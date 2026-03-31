import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MockGameClient } from "./mock-game-client.js";
import { SessionManager } from "./session-manager.js";
import { BreakerRegistry } from "./circuit-breaker.js";
import { MetricsWindow } from "./instability-metrics.js";
import type { MockModeConfig } from "../config.js";
import type { GantryConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<MockModeConfig>): MockModeConfig {
  return {
    enabled: true,
    tickIntervalMs: 0, // instant ticks for tests
    ...overrides,
  };
}

function makeClient(overrides?: Partial<MockModeConfig>): MockGameClient {
  return new MockGameClient(makeConfig(overrides));
}

// ---------------------------------------------------------------------------
// Construction + interface
// ---------------------------------------------------------------------------

describe("MockGameClient — construction", () => {
  it("constructs without error", () => {
    const client = makeClient();
    expect(client).toBeDefined();
  });

  it("has hasSocksProxy = false (no network)", () => {
    expect(makeClient().hasSocksProxy).toBe(false);
  });

  it("starts with null credentials", () => {
    expect(makeClient().getCredentials()).toBeNull();
  });

  it("exposes circuit breaker stub that always allows connections", () => {
    const client = makeClient();
    expect(client.breaker.allowConnection()).toBe(true);
    expect(client.breaker.getState()).toBe("closed");
  });

  it("exposes onEvent, onStateUpdate, onReconnect as null", () => {
    const client = makeClient();
    expect(client.onEvent).toBeNull();
    expect(client.onStateUpdate).toBeNull();
    expect(client.onReconnect).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Login / logout
// ---------------------------------------------------------------------------

describe("MockGameClient — login/logout", () => {
  it("login() returns success result with username and credits", async () => {
    const client = makeClient();
    const resp = await client.login("test-pilot", "pass1234");
    expect(resp.error).toBeUndefined();
    expect(resp.result).toBeDefined();
    const result = resp.result as Record<string, unknown>;
    expect(result.status).toBe("ok");
    expect(typeof result.credits).toBe("number");
  });

  it("login() stores credentials", async () => {
    const client = makeClient();
    await client.login("test-pilot", "pass1234");
    expect(client.getCredentials()).toEqual({ username: "test-pilot", password: "pass1234" });
  });

  it("logout() clears credentials", async () => {
    const client = makeClient();
    await client.login("test-pilot", "pass1234");
    await client.logout();
    expect(client.getCredentials()).toBeNull();
  });

  it("logout() returns ok", async () => {
    const client = makeClient();
    await client.login("test-pilot", "pass1234");
    const resp = await client.logout();
    expect(resp.error).toBeUndefined();
    const result = resp.result as Record<string, unknown>;
    expect(result.status).toBe("ok");
  });

  it("restoreCredentials() makes client behave as authenticated", async () => {
    const client = makeClient();
    client.restoreCredentials({ username: "restored-pilot", password: "secret" });
    expect(client.getCredentials()).toEqual({ username: "restored-pilot", password: "secret" });
    // Can call execute without login
    const resp = await client.execute("get_credits");
    expect(resp.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// execute() — not authenticated guard
// ---------------------------------------------------------------------------

describe("MockGameClient — authentication guard", () => {
  it("execute() returns not_authenticated when not logged in", async () => {
    const client = makeClient();
    const resp = await client.execute("get_credits");
    expect(resp.error?.code).toBe("not_authenticated");
  });

  it("execute() works after login", async () => {
    const client = makeClient();
    await client.login("test-pilot", "pass");
    const resp = await client.execute("get_credits");
    expect(resp.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Status tools — reflect simulated state
// ---------------------------------------------------------------------------

describe("MockGameClient — status tools", () => {
  let client: MockGameClient;
  beforeEach(async () => {
    client = makeClient({ initialState: { credits: 3000, fuel: 70, location: "sol_station", dockedAt: "sol_hub" } });
    await client.login("test-pilot", "pass");
  });

  it("get_credits returns initial credits", async () => {
    const resp = await client.execute("get_credits");
    const r = resp.result as Record<string, unknown>;
    expect(r.credits).toBe(3000);
  });

  it("get_fuel returns initial fuel", async () => {
    const resp = await client.execute("get_fuel");
    const r = resp.result as Record<string, unknown>;
    expect(r.fuel).toBe(70);
  });

  it("get_location returns initial location", async () => {
    const resp = await client.execute("get_location");
    const r = resp.result as Record<string, unknown>;
    expect(r.location).toBe("sol_station");
    expect(r.docked_at_base).toBe("sol_hub");
  });

  it("get_status returns full snapshot", async () => {
    const resp = await client.execute("get_status");
    const r = resp.result as Record<string, unknown>;
    expect(r.status).toBe("ok");
    expect(r.credits).toBe(3000);
    expect(r.fuel).toBe(70);
    expect(r.location).toBe("sol_station");
  });

  it("get_cargo returns empty cargo initially", async () => {
    const resp = await client.execute("get_cargo");
    const r = resp.result as Record<string, unknown>;
    expect(r.cargo_used).toBe(0);
    expect(Array.isArray(r.cargo)).toBe(true);
  });

  it("get_cargo_summary matches get_cargo", async () => {
    const resp = await client.execute("get_cargo_summary");
    const r = resp.result as Record<string, unknown>;
    expect(r.cargo_used).toBe(0);
    expect(r.cargo_capacity).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// State tracking — credits decrease on refuel
// ---------------------------------------------------------------------------

describe("MockGameClient — state tracking (refuel)", () => {
  it("refuel() decreases credits and increases fuel", async () => {
    const client = makeClient({ initialState: { credits: 2000, fuel: 50, dockedAt: "nexus_station" } });
    await client.login("test-pilot", "pass");

    const resp = await client.execute("refuel");
    const r = resp.result as Record<string, unknown>;
    expect(r.status).toBe("ok");
    expect(r.fuel_after).toBeGreaterThan(50);
    expect(r.credits_after).toBeLessThan(2000);
  });

  it("refuel() fails when not docked", async () => {
    const client = makeClient({ initialState: { credits: 2000, fuel: 50, dockedAt: undefined } });
    await client.login("test-pilot", "pass");

    const resp = await client.execute("refuel");
    expect(resp.result as Record<string, unknown>).toMatchObject({
      status: "error",
      error: { code: "not_docked" },
    });
  });

  it("refuel() is reflected in subsequent get_fuel", async () => {
    const client = makeClient({ initialState: { credits: 2000, fuel: 50, dockedAt: "nexus_station" } });
    await client.login("test-pilot", "pass");

    await client.execute("refuel");
    const fuelResp = await client.execute("get_fuel");
    const r = fuelResp.result as Record<string, unknown>;
    expect(r.fuel).toBe(100); // full tank
  });
});

// ---------------------------------------------------------------------------
// State tracking — cargo fills on mine, decreases on sell
// ---------------------------------------------------------------------------

describe("MockGameClient — state tracking (mine + sell)", () => {
  it("batch_mine increases cargo", async () => {
    const client = makeClient({ initialState: { dockedAt: undefined } });
    await client.login("test-pilot", "pass");

    const resp = await client.execute("batch_mine", { count: 5 });
    const r = resp.result as Record<string, unknown>;
    expect(r.status).toBe("completed");
    expect(r.mines_completed).toBeGreaterThan(0);
    expect(r.ore_extracted).toBeGreaterThan(0);

    const cargoResp = await client.execute("get_cargo");
    const cargo = cargoResp.result as Record<string, unknown>;
    expect(cargo.cargo_used).toBeGreaterThan(0);
  });

  it("cargo stops filling when full (batch_mine)", async () => {
    // Start with 48/50 cargo used — only 2 slots left
    const client = makeClient({ initialState: { cargo: [{ item_id: "iron_ore", quantity: 48 }], dockedAt: undefined } });
    await client.login("test-pilot", "pass");

    const resp = await client.execute("batch_mine", { count: 20 });
    const r = resp.result as Record<string, unknown>;
    expect(r.stopped_reason).toBe("cargo_full");

    const cargoResp = await client.execute("get_cargo");
    const cargo = cargoResp.result as Record<string, unknown>;
    expect(cargo.cargo_used).toBeLessThanOrEqual(50);
  });

  it("multi_sell removes cargo and increases credits", async () => {
    const client = makeClient({ initialState: { credits: 1000, cargo: [{ item_id: "iron_ore", quantity: 20 }], dockedAt: "nexus_station" } });
    await client.login("test-pilot", "pass");

    const resp = await client.execute("multi_sell", {
      items: [{ item_id: "iron_ore", quantity: 20 }],
    });
    const r = resp.result as Record<string, unknown>;
    expect(r.status).toBe("completed");
    expect(r.credits_after).toBeGreaterThan(1000);

    const cargo = (await client.execute("get_cargo")).result as Record<string, unknown>;
    expect(cargo.cargo_used).toBe(0);
  });

  it("multi_sell fails when not docked", async () => {
    const client = makeClient({ initialState: { cargo: [{ item_id: "iron_ore", quantity: 20 }], dockedAt: undefined } });
    await client.login("test-pilot", "pass");

    const resp = await client.execute("multi_sell", {
      items: [{ item_id: "iron_ore", quantity: 20 }],
    });
    const r = resp.result as Record<string, unknown>;
    expect(r.status).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Navigation — travel_to updates location/poi
// ---------------------------------------------------------------------------

describe("MockGameClient — travel_to", () => {
  it("travel_to updates fuel (decreases)", async () => {
    const client = makeClient({ initialState: { fuel: 80 } });
    await client.login("test-pilot", "pass");

    await client.execute("travel_to", { target_poi: "nexus_belt_alpha" });

    const resp = await client.execute("get_fuel");
    const r = resp.result as Record<string, unknown>;
    expect(r.fuel).toBeLessThan(80);
  });

  it("travel_to belt sets docked_at_base to null", async () => {
    const client = makeClient({ initialState: { dockedAt: "nexus_station" } });
    await client.login("test-pilot", "pass");

    await client.execute("travel_to", { target_poi: "nexus_belt_alpha" });

    const loc = (await client.execute("get_location")).result as Record<string, unknown>;
    expect(loc.docked_at_base).toBeNull();
  });

  it("travel_to station sets docked_at_base", async () => {
    const client = makeClient({ initialState: { dockedAt: undefined } });
    await client.login("test-pilot", "pass");

    await client.execute("travel_to", { target_poi: "sol_station" });

    const loc = (await client.execute("get_location")).result as Record<string, unknown>;
    expect(loc.docked_at_base).toBe("sol_station");
  });
});

// ---------------------------------------------------------------------------
// Tick simulation
// ---------------------------------------------------------------------------

describe("MockGameClient — waitForTick", () => {
  it("waitForTick() resolves without error", async () => {
    const client = makeClient({ tickIntervalMs: 0 });
    await client.login("test-pilot", "pass");
    await expect(client.waitForTick()).resolves.toBeUndefined();
  });

  it("waitForTick() calls onStateUpdate with current state", async () => {
    const client = makeClient({ tickIntervalMs: 0, initialState: { credits: 9999 } });
    await client.login("test-pilot", "pass");

    const updates: Record<string, unknown>[] = [];
    client.onStateUpdate = (data) => updates.push(data);

    await client.waitForTick();
    expect(updates).toHaveLength(1);
    expect(updates[0].credits).toBe(9999);
  });

  it("waitForTick() with tickIntervalMs=0 is instant", async () => {
    const client = makeClient({ tickIntervalMs: 0 });
    await client.login("test-pilot", "pass");

    const start = Date.now();
    await client.waitForTick();
    expect(Date.now() - start).toBeLessThan(100);
  });

  it("waitForTick() with tickIntervalMs=50 waits ~50ms", async () => {
    const client = makeClient({ tickIntervalMs: 50 });
    await client.login("test-pilot", "pass");

    const start = Date.now();
    await client.waitForTick();
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });
});

// ---------------------------------------------------------------------------
// refreshStatus
// ---------------------------------------------------------------------------

describe("MockGameClient — refreshStatus", () => {
  it("returns null when not authenticated", async () => {
    const client = makeClient();
    const result = await client.refreshStatus();
    expect(result).toBeNull();
  });

  it("returns status snapshot when authenticated", async () => {
    const client = makeClient({ initialState: { credits: 1234 } });
    await client.login("test-pilot", "pass");

    const data = await client.refreshStatus();
    expect(data).not.toBeNull();
    expect(data!.credits).toBe(1234);
  });
});

// ---------------------------------------------------------------------------
// Miscellaneous tools
// ---------------------------------------------------------------------------

describe("MockGameClient — misc tools", () => {
  let client: MockGameClient;
  beforeEach(async () => {
    client = makeClient();
    await client.login("test-pilot", "pass");
  });

  it("scan() returns targets array", async () => {
    const resp = await client.execute("scan");
    const r = resp.result as Record<string, unknown>;
    expect(r.status).toBe("ok");
    expect(Array.isArray(r.targets)).toBe(true);
  });

  it("analyze_market() returns recommendations", async () => {
    const resp = await client.execute("analyze_market");
    const r = resp.result as Record<string, unknown>;
    expect(r.status).toBe("ok");
    expect(Array.isArray(r.recommendations)).toBe(true);
  });

  it("get_missions() returns missions array", async () => {
    const resp = await client.execute("get_missions");
    const r = resp.result as Record<string, unknown>;
    expect(r.status).toBe("ok");
    expect(Array.isArray(r.missions)).toBe(true);
  });

  it("captains_log_list() returns entries", async () => {
    const resp = await client.execute("captains_log_list");
    const r = resp.result as Record<string, unknown>;
    expect(r.status).toBe("ok");
  });

  it("captains_log_add() returns ok", async () => {
    const resp = await client.execute("captains_log_add");
    const r = resp.result as Record<string, unknown>;
    expect(r.status).toBe("ok");
  });

  it("read_doc() returns ok with content", async () => {
    const resp = await client.execute("read_doc");
    const r = resp.result as Record<string, unknown>;
    expect(r.status).toBe("ok");
    expect("content" in r).toBe(true);
  });

  it("write_diary() returns ok", async () => {
    const resp = await client.execute("write_diary");
    const r = resp.result as Record<string, unknown>;
    expect(r.status).toBe("ok");
  });

  it("write_doc() returns ok", async () => {
    const resp = await client.execute("write_doc");
    const r = resp.result as Record<string, unknown>;
    expect(r.status).toBe("ok");
  });

  it("unknown command returns default response", async () => {
    const resp = await client.execute("some_future_tool");
    const r = resp.result as Record<string, unknown>;
    expect(r.status).toBe("ok");
  });

  it("get_system returns system info with pois", async () => {
    const resp = await client.execute("get_system", { target_system: "nexus_core" });
    const r = resp.result as Record<string, unknown>;
    expect(r.status).toBe("ok");
    expect(r.system).toBeDefined();
  });

  it("craft() fails when not docked", async () => {
    const c = makeClient({ initialState: { dockedAt: undefined, cargo: [{ item_id: "iron_ore", quantity: 10 }] } });
    await c.login("test-pilot", "pass");
    const resp = await c.execute("craft", { recipe_id: "refine_steel", quantity: 3 });
    const r = resp.result as Record<string, unknown>;
    expect(r.status).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// close()
// ---------------------------------------------------------------------------

describe("MockGameClient — close", () => {
  it("close() resolves without error", async () => {
    const client = makeClient();
    await client.login("test-pilot", "pass");
    await expect(client.close()).resolves.toBeUndefined();
  });

  it("after close(), execute() returns not_authenticated", async () => {
    const client = makeClient();
    await client.login("test-pilot", "pass");
    await client.close();
    const resp = await client.execute("get_credits");
    expect(resp.error?.code).toBe("not_authenticated");
  });
});

// ---------------------------------------------------------------------------
// Config wiring — SessionManager uses MockGameClient when enabled
// ---------------------------------------------------------------------------

describe("SessionManager — mockMode wiring", () => {
  let breakerRegistry: BreakerRegistry;

  beforeEach(() => {
    breakerRegistry = new BreakerRegistry();
  });

  // Clean up breaker registry entries created during these tests
  // to prevent polluting the global singleton used by integration tests.
  afterEach(() => {
    breakerRegistry.remove("test-agent");
    breakerRegistry.remove("test-direct");
  });

  const baseConfig: GantryConfig = {
    agents: [
      { name: "test-agent" },
      { name: "test-direct" },
    ],
    gameUrl: "https://game.spacemolt.com/mcp",
    gameApiUrl: "https://game.spacemolt.com/api/v1",
    gameMcpUrl: "https://game.spacemolt.com/mcp",
    agentDeniedTools: {},
    callLimits: {},
    turnSleepMs: 90,
    staggerDelay: 20,
  };

  it("returns MockGameClient when mockMode.enabled = true", () => {
    const config = { ...baseConfig, mockMode: { enabled: true, tickIntervalMs: 0 } };
    const mgr = new SessionManager(config, breakerRegistry, new MetricsWindow());
    const client = mgr.getOrCreateClient("test-agent");
    expect(client).toBeInstanceOf(MockGameClient);
  });

  it("returns real HttpGameClient when mockMode not set", () => {
    const { HttpGameClient } = require("./game-client.js");
    const mgr = new SessionManager(baseConfig, breakerRegistry, new MetricsWindow());
    const client = mgr.getOrCreateClient("test-agent");
    expect(client).toBeInstanceOf(HttpGameClient);
  });

  it("returns real HttpGameClient when mockMode.enabled = false", () => {
    const { HttpGameClient } = require("./game-client.js");
    const config = { ...baseConfig, mockMode: { enabled: false } };
    const mgr = new SessionManager(config, breakerRegistry, new MetricsWindow());
    const client = mgr.getOrCreateClient("test-agent");
    expect(client).toBeInstanceOf(HttpGameClient);
  });

  it("mock client can login without network", async () => {
    const config = { ...baseConfig, mockMode: { enabled: true, tickIntervalMs: 0 } };
    const mgr = new SessionManager(config, breakerRegistry, new MetricsWindow());
    const client = mgr.getOrCreateClient("test-agent");
    const resp = await client.login("test-pilot", "pass");
    expect(resp.error).toBeUndefined();
  });

  it("reuses same mock client on repeated calls", () => {
    const config = { ...baseConfig, mockMode: { enabled: true, tickIntervalMs: 0 } };
    const mgr = new SessionManager(config, breakerRegistry, new MetricsWindow());
    const a = mgr.getOrCreateClient("test-agent");
    const b = mgr.getOrCreateClient("test-agent");
    expect(a).toBe(b);
  });

  it("mock client has hasSocksProxy = false", () => {
    const config = { ...baseConfig, mockMode: { enabled: true } };
    const mgr = new SessionManager(config, breakerRegistry, new MetricsWindow());
    const client = mgr.getOrCreateClient("test-agent");
    expect(client.hasSocksProxy).toBe(false);
  });
});
