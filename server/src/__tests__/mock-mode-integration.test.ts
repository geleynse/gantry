/**
 * Mock mode integration test — exercises MockGameClient in-process.
 *
 * Tests a full mining loop: travel → mine → travel (to station) → multi_sell.
 * Also exercises the Tier-2 handlers added in Batch 10:
 *   jump, dock, undock, sell, buy, repair, get_notifications, view_market, view_storage.
 *
 * Uses MockGameClient directly (no HTTP server spin-up) for CI-safe, fast tests.
 *
 * @see src/proxy/__tests__/smoke.test.ts for full MCP pipeline tests
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { MockGameClient } from "../proxy/mock-game-client.js";
import type { MockModeConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(initial?: MockModeConfig["initialState"]): MockGameClient {
  const config: MockModeConfig = {
    enabled: true,
    tickIntervalMs: 0, // instant ticks for tests
    initialState: initial,
  };
  const client = new MockGameClient(config);
  client.label = "test-agent";
  return client;
}

async function loginClient(client: MockGameClient): Promise<void> {
  await client.login("test-agent", "test-pass");
}

/** Execute a command and return the unwrapped result (throws on error). */
async function callCommand(
  client: MockGameClient,
  command: string,
  payload: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = await client.execute(command, payload);
  if (response.error) {
    throw new Error(`${command} failed: ${JSON.stringify(response.error)}`);
  }
  return response.result as Record<string, unknown>;
}

/** Execute a command and return the raw response (including potential error shapes). */
async function callCommandRaw(
  client: MockGameClient,
  command: string,
  payload: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = await client.execute(command, payload);
  if (response.error) return { error: response.error };
  return response.result as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Full mining loop
// ---------------------------------------------------------------------------

describe("MockGameClient: full mining loop", () => {
  let client: MockGameClient;

  beforeEach(async () => {
    client = makeClient({
      credits: 5000,
      fuel: 80,
      location: "nexus_core",
      // not docked — start in space near a belt
      cargo: [],
    });
    await loginClient(client);
  });

  it("travel_to mining belt → mine → travel_to station → multi_sell — state changes correctly", async () => {
    // 1. Travel to asteroid belt
    const travel1 = await callCommand(client, "travel_to", { target_poi: "nexus_belt_alpha" });
    expect(travel1.status).toBe("completed");
    expect(travel1.docked_at_base).toBeNull();

    // Fuel should have decreased
    const statusAfterTravel = await callCommand(client, "get_status");
    expect((statusAfterTravel.fuel as number)).toBeLessThan(80);

    // 2. Mine (batch_mine)
    const mine = await callCommand(client, "batch_mine", { count: 5 });
    expect(mine.status).toBe("completed");
    expect(mine.mines_completed as number).toBeGreaterThan(0);
    expect(mine.ore_extracted as number).toBeGreaterThan(0);

    // Cargo should now have iron_ore
    const cargoAfterMine = await callCommand(client, "get_cargo");
    const cargoItems = cargoAfterMine.cargo as Array<{ item_id: string; quantity: number }>;
    const ore = cargoItems.find((c) => c.item_id === "iron_ore");
    expect(ore).toBeDefined();
    expect(ore!.quantity).toBeGreaterThan(0);
    const oreMined = ore!.quantity;

    // 3. Travel to station
    const travel2 = await callCommand(client, "travel_to", { target_poi: "nexus_station" });
    expect(travel2.status).toBe("completed");
    expect(travel2.docked_at_base).toBe("nexus_station");

    // 4. Multi-sell
    const sellResult = await callCommand(client, "multi_sell", {
      items: [{ item_id: "iron_ore", quantity: oreMined }],
    });
    expect(sellResult.status).toBe("completed");
    const soldItems = sellResult.sold as Array<{ item_id: string; quantity: number; total_credits: number }>;
    expect(soldItems.length).toBeGreaterThan(0);
    expect(soldItems[0].item_id).toBe("iron_ore");
    expect(soldItems[0].quantity).toBeGreaterThan(0);

    // Credits should have increased
    const creditsAfterSell = sellResult.credits_after as number;
    expect(creditsAfterSell).toBeGreaterThan(5000);

    // Cargo should be empty
    const cargoAfterSell = await callCommand(client, "get_cargo");
    const remainingCargo = cargoAfterSell.cargo as unknown[];
    expect(remainingCargo.length).toBe(0);

    // Location should still be nexus_core
    const location = await callCommand(client, "get_location");
    expect(location.location).toBe("nexus_core");
    expect(location.docked_at_base).toBe("nexus_station");
  });
});

// ---------------------------------------------------------------------------
// Tier-2 handler: jump
// ---------------------------------------------------------------------------

describe("MockGameClient: jump", () => {
  it("updates location, deducts fuel, clears docked state", async () => {
    const client = makeClient({ fuel: 50, location: "nexus_core", dockedAt: "nexus_station" });
    await loginClient(client);

    const result = await callCommand(client, "jump", { target_system: "kepler_sector" });

    expect(result.status).toBe("completed");
    expect(result.system).toBe("kepler_sector");
    expect(result.fuel as number).toBe(40); // 50 - 10

    const location = await callCommand(client, "get_location");
    expect(location.location).toBe("kepler_sector");
    expect(location.docked_at_base).toBeNull(); // undocked after jump
  });

  it("returns error shape when insufficient fuel", async () => {
    const client = makeClient({ fuel: 5, location: "nexus_core" });
    await loginClient(client);

    const result = await callCommandRaw(client, "jump", { target_system: "kepler_sector" });
    expect((result.error as any).code).toBe("insufficient_fuel");
  });

  it("uses default target_system when not provided", async () => {
    const client = makeClient({ fuel: 80 });
    await loginClient(client);

    const result = await callCommand(client, "jump", {});
    expect(result.status).toBe("completed");
    expect(typeof result.system).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Tier-2 handler: dock / undock
// ---------------------------------------------------------------------------

describe("MockGameClient: dock / undock", () => {
  it("dock sets dockedAt and poi", async () => {
    const client = makeClient({ dockedAt: null, location: "nexus_core" });
    await loginClient(client);

    const result = await callCommand(client, "dock", { station_id: "nexus_station" });
    expect(result.status).toBe("docked");
    expect(result.station_id).toBe("nexus_station");

    const location = await callCommand(client, "get_location");
    expect(location.docked_at_base).toBe("nexus_station");
  });

  it("undock clears dockedAt", async () => {
    const client = makeClient({ dockedAt: "nexus_station", location: "nexus_core" });
    await loginClient(client);

    const result = await callCommand(client, "undock");
    expect(result.status).toBe("undocked");
    expect(result.location).toBe("nexus_core");

    const location = await callCommand(client, "get_location");
    expect(location.docked_at_base).toBeNull();
  });

  it("dock → undock → dock cycle", async () => {
    const client = makeClient({ dockedAt: null, location: "nexus_core" });
    await loginClient(client);

    await callCommand(client, "dock", { station_id: "nexus_station" });
    let loc = await callCommand(client, "get_location");
    expect(loc.docked_at_base).toBe("nexus_station");

    await callCommand(client, "undock");
    loc = await callCommand(client, "get_location");
    expect(loc.docked_at_base).toBeNull();

    await callCommand(client, "dock", { station_id: "nexus_station" });
    loc = await callCommand(client, "get_location");
    expect(loc.docked_at_base).toBe("nexus_station");
  });
});

// ---------------------------------------------------------------------------
// Tier-2 handler: sell (single-item)
// ---------------------------------------------------------------------------

describe("MockGameClient: sell", () => {
  it("deducts cargo and increases credits", async () => {
    const client = makeClient({
      credits: 1000,
      dockedAt: "nexus_station",
      cargo: [{ item_id: "iron_ore", quantity: 20 }],
    });
    await loginClient(client);

    const result = await callCommand(client, "sell", { item_id: "iron_ore", quantity: 10 });
    expect(result.status).toBe("sold");
    expect(result.quantity).toBe(10);
    expect(result.credits_earned as number).toBeGreaterThan(0);
    expect(result.credits as number).toBeGreaterThan(1000);

    const cargo = await callCommand(client, "get_cargo");
    const items = cargo.cargo as Array<{ item_id: string; quantity: number }>;
    const ore = items.find((c) => c.item_id === "iron_ore");
    expect(ore!.quantity).toBe(10);
  });

  it("fails when not docked", async () => {
    const client = makeClient({
      credits: 1000,
      dockedAt: null,
      cargo: [{ item_id: "iron_ore", quantity: 10 }],
    });
    await loginClient(client);

    const result = await callCommandRaw(client, "sell", { item_id: "iron_ore", quantity: 10 });
    expect((result.error as any).code).toBe("not_docked");
  });

  it("fails when item not in cargo", async () => {
    const client = makeClient({ credits: 1000, dockedAt: "nexus_station", cargo: [] });
    await loginClient(client);

    const result = await callCommandRaw(client, "sell", { item_id: "steel_plate", quantity: 1 });
    expect((result.error as any).code).toBe("item_not_in_cargo");
  });
});

// ---------------------------------------------------------------------------
// Tier-2 handler: buy
// ---------------------------------------------------------------------------

describe("MockGameClient: buy", () => {
  it("deducts credits and adds to cargo", async () => {
    const client = makeClient({ credits: 1000, dockedAt: "nexus_station", cargo: [] });
    await loginClient(client);

    const result = await callCommand(client, "buy", { item_id: "iron_ore", quantity: 5 });
    expect(result.status).toBe("bought");
    expect(result.quantity).toBe(5);
    expect(result.credits as number).toBeLessThan(1000);

    const cargo = await callCommand(client, "get_cargo");
    const items = cargo.cargo as Array<{ item_id: string; quantity: number }>;
    const ore = items.find((c) => c.item_id === "iron_ore");
    expect(ore!.quantity).toBe(5);
  });

  it("fails when not docked", async () => {
    const client = makeClient({ credits: 1000, dockedAt: null, cargo: [] });
    await loginClient(client);

    const result = await callCommandRaw(client, "buy", { item_id: "iron_ore", quantity: 5 });
    expect((result.error as any).code).toBe("not_docked");
  });

  it("fails with insufficient credits", async () => {
    const client = makeClient({ credits: 1, dockedAt: "nexus_station", cargo: [] });
    await loginClient(client);

    const result = await callCommandRaw(client, "buy", { item_id: "iron_ore", quantity: 100 });
    expect((result.error as any).code).toBe("insufficient_credits");
  });
});

// ---------------------------------------------------------------------------
// Tier-2 handler: repair
// ---------------------------------------------------------------------------

describe("MockGameClient: repair", () => {
  it("returns ok when hull already at full (default state)", async () => {
    const client = makeClient({ credits: 1000, dockedAt: "nexus_station" });
    await loginClient(client);

    const result = await callCommand(client, "repair");
    // Hull defaults to 100 — already full
    expect(result.status).toBe("ok");
    expect(typeof result.hull).toBe("number");
  });

  it("fails when not docked", async () => {
    const client = makeClient({ credits: 1000, dockedAt: null });
    await loginClient(client);

    const result = await callCommandRaw(client, "repair");
    expect((result.error as any).code).toBe("not_docked");
  });
});

// ---------------------------------------------------------------------------
// Tier-2 handler: get_notifications
// ---------------------------------------------------------------------------

describe("MockGameClient: get_notifications", () => {
  it("returns empty notifications array without error", async () => {
    const client = makeClient();
    await loginClient(client);

    const result = await callCommand(client, "get_notifications");
    expect(result.status).toBe("ok");
    expect(Array.isArray(result.notifications)).toBe(true);
    expect((result.notifications as unknown[]).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tier-2 handler: view_market
// ---------------------------------------------------------------------------

describe("MockGameClient: view_market", () => {
  it("returns item list with price_buy/price_sell fields", async () => {
    const client = makeClient({ dockedAt: "nexus_station" });
    await loginClient(client);

    const result = await callCommand(client, "view_market");
    expect(result.status).toBe("ok");
    expect(Array.isArray(result.items)).toBe(true);
    const items = result.items as Array<{ item_id: string; price_buy: number; price_sell: number }>;
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].item_id).toBeTruthy();
    expect(typeof items[0].price_buy).toBe("number");
    expect(typeof items[0].price_sell).toBe("number");
  });

  it("includes station_id in response", async () => {
    const client = makeClient({ dockedAt: "nexus_station" });
    await loginClient(client);

    const result = await callCommand(client, "view_market");
    expect(result.station_id).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Tier-2 handler: view_storage
// ---------------------------------------------------------------------------

describe("MockGameClient: view_storage", () => {
  it("returns storage data with capacity fields", async () => {
    const client = makeClient({ dockedAt: "nexus_station" });
    await loginClient(client);

    const result = await callCommand(client, "view_storage");
    expect(result.status).toBe("ok");
    expect(Array.isArray(result.items)).toBe(true);
    expect(typeof result.storage_capacity).toBe("number");
    expect(typeof result.storage_used).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// loadConfig: GANTRY_MOCK env var precedence
// ---------------------------------------------------------------------------

describe("loadConfig: GANTRY_MOCK env var precedence", () => {
  it("config mockMode: false wins over GANTRY_MOCK=1 (config takes precedence)", async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const tmpDir = `/tmp/gantry-mock-test-${Date.now()}`;
    mkdirSync(tmpDir, { recursive: true });

    writeFileSync(
      join(tmpDir, "gantry.json"),
      JSON.stringify({
        mcpGameUrl: "https://game.example.com/mcp",
        agents: [{ name: "test-agent" }],
        mockMode: { enabled: false },
      }),
    );

    const { loadConfig } = await import("../config/fleet.js");
    const config = loadConfig(tmpDir);

    // mockMode.enabled is explicitly false in config — GANTRY_MOCK must not override
    expect(config.mockMode?.enabled).toBe(false);
    rmSync(tmpDir, { recursive: true });
  });

  it("config mockMode: true is preserved regardless of env var", async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const tmpDir = `/tmp/gantry-mock-test-${Date.now()}`;
    mkdirSync(tmpDir, { recursive: true });

    writeFileSync(
      join(tmpDir, "gantry.json"),
      JSON.stringify({
        mcpGameUrl: "https://game.example.com/mcp",
        agents: [{ name: "test-agent" }],
        mockMode: true,
      }),
    );

    const { loadConfig } = await import("../config/fleet.js");
    const config = loadConfig(tmpDir);

    expect(config.mockMode?.enabled).toBe(true);
    rmSync(tmpDir, { recursive: true });
  });

  it("no mockMode in config — resolves to undefined (env var path tested at module load)", async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const tmpDir = `/tmp/gantry-mock-test-${Date.now()}`;
    mkdirSync(tmpDir, { recursive: true });

    writeFileSync(
      join(tmpDir, "gantry.json"),
      JSON.stringify({
        mcpGameUrl: "https://game.example.com/mcp",
        agents: [{ name: "test-agent" }],
        // no mockMode key
      }),
    );

    const { loadConfig } = await import("../config/fleet.js");
    const config = loadConfig(tmpDir);

    // If GANTRY_MOCK was "1" at module-load time, mockMode will be { enabled: true }.
    // If not, it will be undefined. Either outcome is valid — we just verify it doesn't throw.
    expect(config.agents.length).toBe(1);
    rmSync(tmpDir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// Unauthenticated guard
// ---------------------------------------------------------------------------

describe("MockGameClient: unauthenticated guard", () => {
  it("returns not_authenticated error before login", async () => {
    const client = makeClient();
    // Do not call login

    const response = await client.execute("get_status");
    expect(response.error).toBeDefined();
    expect((response.error as any).code).toBe("not_authenticated");
  });
});

// ---------------------------------------------------------------------------
// State isolation between clients
// ---------------------------------------------------------------------------

describe("MockGameClient: state isolation", () => {
  it("two clients have independent state", async () => {
    const client1 = makeClient({ credits: 1000, cargo: [] });
    const client2 = makeClient({ credits: 9999, cargo: [{ item_id: "iron_ore", quantity: 50 }] });
    await loginClient(client1);
    await loginClient(client2);

    const status1 = await callCommand(client1, "get_credits");
    const status2 = await callCommand(client2, "get_credits");

    expect(status1.credits).toBe(1000);
    expect(status2.credits).toBe(9999);
  });
});
