/**
 * compound-tools-impl.test.ts
 *
 * Tests for the shared compound tool logic extracted from server.ts.
 * All dependencies (GameClient, statusCache, battleCache, etc.) are mocked
 * with simple in-memory objects — no imports from server.ts.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { createDatabase, closeDb } from "../services/database.js";
import { resetSessionShutdownManager } from "./session-shutdown.js";
import { systemPoiCache } from "./poi-resolver.js";
import { resolvePoiId } from "./poi-resolver.js";

import {
  batchMine,
  travelTo,
  jumpRoute,
  multiSell,
  scanAndAttack,
  battleReadiness,
  lootWrecks,
  flee,
  stripPendingFields,
  findTargets,
  waitForNavCacheUpdate,
  type CompoundToolDeps,
  type GameClientLike,
  type BattleStateForCache,
} from "./compound-tools-impl.js";
import { SellLog } from "./sell-log.js";
import { GalaxyGraph } from "./pathfinder.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeClient(
  overrides: Partial<{
    execute: GameClientLike["execute"];
    waitForTick: GameClientLike["waitForTick"];
    lastArrivalTick: number | null;
  }> = {},
): GameClientLike {
  return {
    execute: overrides.execute ?? (async () => ({ result: { ok: true } })),
    waitForTick: overrides.waitForTick ?? (async () => {}),
    lastArrivalTick: overrides.lastArrivalTick ?? null,
  };
}

type StatusEntry = { data: Record<string, unknown>; fetchedAt: number };

function makeStatusCache(
  agentName: string,
  data: Record<string, unknown>,
): Map<string, StatusEntry> {
  const cache = new Map<string, StatusEntry>();
  cache.set(agentName, { data, fetchedAt: Date.now() });
  return cache;
}

function makeDeps(
  agentName: string,
  client: GameClientLike,
  statusCache: Map<string, StatusEntry>,
  overrides: Partial<CompoundToolDeps> = {},
): CompoundToolDeps {
  return {
    client,
    agentName,
    statusCache,
    battleCache: new Map<string, BattleStateForCache | null>(),
    sellLog: new SellLog(),
    galaxyGraph: new GalaxyGraph(),
    persistBattleState: () => {},
    upsertNote: () => {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// stripPendingFields
// ---------------------------------------------------------------------------

describe("Compound Tools", () => {
  beforeEach(() => {
    createDatabase(":memory:");
    resetSessionShutdownManager();
  });

  afterEach(() => {
    closeDb();
  });

  describe("stripPendingFields", () => {
  it("removes pending:true and updates the message", () => {
    const obj = { pending: true, message: "action pending", command: "mine" };
    stripPendingFields(obj);
    expect(obj).not.toHaveProperty("pending");
    expect((obj as Record<string, unknown>).message).toBe("mine completed");
  });

  it("is a no-op on non-pending objects", () => {
    const obj = { result: "ok" };
    stripPendingFields(obj);
    expect(obj).toEqual({ result: "ok" });
  });

  it("is safe on null / primitives", () => {
    expect(() => stripPendingFields(null)).not.toThrow();
    expect(() => stripPendingFields(42)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// findTargets
// ---------------------------------------------------------------------------

describe("findTargets", () => {
  const OUR_AGENTS = new Set(["our agent"]);

  it("excludes in_combat entities", () => {
    const entities = [{ username: "pirate", in_combat: true }];
    expect(findTargets(entities, "our agent", OUR_AGENTS)).toHaveLength(0);
  });

  it("excludes fleet agents", () => {
    const entities = [{ username: "our agent", in_combat: false }];
    expect(findTargets(entities, "test", OUR_AGENTS)).toHaveLength(0);
  });

  it("excludes QTCG faction mates", () => {
    const entities = [{ username: "friend", faction_tag: "QTCG", in_combat: false }];
    expect(findTargets(entities, "test", OUR_AGENTS)).toHaveLength(0);
  });

  it("excludes anonymous entities (NPCs — attack is PvP only)", () => {
    const entities = [
      { username: "known_player", anonymous: false, in_combat: false },
      { username: "pirate", anonymous: true, in_combat: false },
    ];
    const targets = findTargets(entities, "test", OUR_AGENTS);
    expect(targets).toHaveLength(1);
    expect(targets[0].username).toBe("known_player");
  });

  it("returns empty array when no valid targets", () => {
    expect(findTargets([], "test", OUR_AGENTS)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// batchMine
// ---------------------------------------------------------------------------

describe("batchMine", () => {
  it("mines count times and returns aggregated results", async () => {
    const calls: string[] = [];
    let callCount = 0;
    const client = makeClient({
      execute: async (tool) => {
        calls.push(tool);
        if (tool === "get_cargo") return { result: { cargo: [] } };
        callCount++;
        return { result: { ore: "iron", amount: callCount } };
      },
    });
    const cache = makeStatusCache("agent", {
      player: { docked_at_base: null },
      ship: { cargo_used: 10, cargo_capacity: 100 },
    });
    const deps = makeDeps("agent", client, cache);

    const result = await batchMine(deps, 3);

    expect(result.status).toBe("completed");
    expect(result.mines_completed).toBe(3);
    const mined = result.mined as unknown[];
    expect(mined).toHaveLength(3);
    expect(result.cargo_after).toEqual({ cargo: [] });
    expect(result.stopped_reason).toBeUndefined();
  });

  it("stops on error after some successes", async () => {
    let callCount = 0;
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_cargo") return { result: { cargo: [] } };
        callCount++;
        if (callCount === 3) return { error: { code: "not_at_belt" } };
        return { result: { ore: "iron" } };
      },
    });
    const cache = makeStatusCache("agent", {
      player: { docked_at_base: null },
    });
    const deps = makeDeps("agent", client, cache);

    const result = await batchMine(deps, 5);

    expect(result.status).toBe("completed");
    expect(result.mines_completed).toBe(2);
    expect(result.stopped_reason).toBe("error");
    expect(result.last_error).toEqual({ code: "not_at_belt" });
  });

  it("returns error immediately when first mine fails", async () => {
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_cargo") return { result: {} };
        return { error: { code: "not_at_belt" } };
      },
    });
    const cache = makeStatusCache("agent", {
      player: { docked_at_base: null },
    });
    const deps = makeDeps("agent", client, cache);

    const result = await batchMine(deps, 3);

    expect(result.error).toEqual({ code: "not_at_belt" });
    expect(result.status).toBeUndefined();
  });

  it("stops when cargo is full (checked every 5 mines)", async () => {
    let tick = 0;
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_cargo") return { result: {} };
        tick++;
        return { result: { ore: "iron", amount: tick } };
      },
    });
    const cache = makeStatusCache("agent", {
      player: { docked_at_base: null },
      ship: { cargo_used: 100, cargo_capacity: 100 },
    });
    const deps = makeDeps("agent", client, cache);

    const result = await batchMine(deps, 10);

    // Cargo is full after first check (at 5 mines)
    expect(result.mines_completed).toBe(5);
    expect(result.stopped_reason).toBe("cargo_full");
  });

  it("waits for tick when mine returns pending result", async () => {
    let ticked = 0;
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_cargo") return { result: {} };
        return { result: { pending: true, command: "mine" } };
      },
      waitForTick: async () => { ticked++; },
    });
    const cache = makeStatusCache("agent", {
      player: { docked_at_base: null },
      ship: { cargo_used: 0, cargo_capacity: 100 },
    });
    const deps = makeDeps("agent", client, cache);

    await batchMine(deps, 2);
    expect(ticked).toBeGreaterThanOrEqual(2);
  });

  it("clamps count to range [1, 50]", async () => {
    let mineCount = 0;
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_cargo") return { result: {} };
        mineCount++;
        return { result: {} };
      },
    });
    const cache = makeStatusCache("agent", {
      player: { docked_at_base: null },
    });
    const deps = makeDeps("agent", client, cache);

    // count=0 → should mine 1 time
    mineCount = 0;
    await batchMine(deps, 0);
    expect(mineCount).toBe(1);

    // count=100 → should mine 50 times
    mineCount = 0;
    await batchMine(deps, 100);
    expect(mineCount).toBe(50);
  });

  it("blocks when docked", async () => {
    const cache = makeStatusCache("agent", {
      player: { docked_at_base: "sol_station" },
    });
    const client = makeClient();
    const deps = makeDeps("agent", client, cache);
    const result = await batchMine(deps, 5);

    expect(result.error).toBeTruthy();
    expect(String(result.error)).toContain("You are docked");
  });
});

// ---------------------------------------------------------------------------
// travelTo
// ---------------------------------------------------------------------------

describe("travelTo", () => {
  const identityResolver = (_agent: string, name: string, _cache: unknown) => name;

  it("travels to a destination and returns location_after", async () => {
    const cache = makeStatusCache("agent", {
      player: {
        current_system: "sol",
        current_poi: "sol_belt",
        docked_at_base: null,
      },
    });
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "travel") return { result: { ok: true } };
        if (tool === "dock") return { result: { docked: true } };
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, cache);

    const result = await travelTo(deps, "sol_belt", identityResolver, false);

    expect(result.status).toBe("completed");
    const steps = result.steps as Array<{ action: string }>;
    expect(steps.some((s) => s.action === "travel")).toBe(true);
    expect(result.location_after).toBeTruthy();
  });

  it("docks when destination contains 'station'", async () => {
    const dockCalls: string[] = [];
    const cache = makeStatusCache("agent", {
      player: { current_system: "sol", current_poi: "sol_station", docked_at_base: "sol_station_base" },
    });
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "dock") dockCalls.push("dock");
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, cache);

    const result = await travelTo(deps, "sol_station", identityResolver);

    expect(dockCalls).toContain("dock");
    const steps = result.steps as Array<{ action: string }>;
    expect(steps.some((s) => s.action === "dock")).toBe(true);
  });

  it("does not dock when should_dock is false", async () => {
    const dockCalls: string[] = [];
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "dock") dockCalls.push("dock");
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, makeStatusCache("agent", {
      player: { current_system: "sol", current_poi: "sol_belt", docked_at_base: null },
    }));

    await travelTo(deps, "sol_belt", identityResolver, false);
    expect(dockCalls).toHaveLength(0);
  });

  it("uses resolved POI ID when resolver returns different ID", async () => {
    const executed: Array<{ tool: string; args?: Record<string, unknown> }> = [];
    const client = makeClient({
      execute: async (tool, args) => {
        executed.push({ tool, args });
        return { result: {} };
      },
    });
    const resolver = (_agent: string, _name: string, _cache: unknown) =>
      "poi_0041_002";
    const deps = makeDeps("agent", client, makeStatusCache("agent", {
      player: { current_system: "sol", current_poi: "poi_0041_002", docked_at_base: null },
    }));

    await travelTo(deps, "Sol Station", resolver, false);

    const travelCall = executed.find((e) => e.tool === "travel");
    expect(travelCall?.args?.target_poi).toBe("poi_0041_002");
  });

  it("includes dock warning when dock is attempted but docked_at_base is null", async () => {
    const cache = makeStatusCache("agent", {
      player: { current_system: "sol", current_poi: "sol_station", docked_at_base: null },
    });
    const client = makeClient({
      execute: async () => ({ result: {} }),
    });
    const deps = makeDeps("agent", client, cache);

    const result = await travelTo(deps, "sol_station", identityResolver);
    expect(typeof result.warning).toBe("string");
    // After retry fails, warning should indicate dock verification failure
    expect(result.warning as string).toContain("NOT docked");
  });

  it("auto-fetches get_system when POI cache is empty and resolves destination", async () => {
    systemPoiCache.clear();
    const executed: Array<{ tool: string; args?: Record<string, unknown> }> = [];
    const cache = makeStatusCache("agent", {
      player: { current_system: "sys_0041", current_poi: "poi_0041_001", docked_at_base: null },
    });
    const client = makeClient({
      execute: async (tool, args) => {
        executed.push({ tool, args });
        if (tool === "get_system") {
          return {
            result: {
              id: "sys_0041",
              name: "Sol",
              pois: [
                { id: "poi_0041_001", name: "Sol Belt", type: "asteroid_belt" },
                { id: "poi_0041_002", name: "Sol Station", type: "station" },
              ],
            },
          };
        }
        return { result: { ok: true } };
      },
    });
    const deps = makeDeps("agent", client, cache);

    // Pass the real resolvePoiId (not identity resolver) so auto-fetch logic works
    const result = await travelTo(deps, "sol_station", resolvePoiId, false);

    expect(result.status).toBe("completed");
    // Verify get_system was called to populate the cache
    expect(executed.some(e => e.tool === "get_system")).toBe(true);
    // Verify travel was called with the resolved POI ID
    const travelCall = executed.find(e => e.tool === "travel");
    expect(travelCall?.args?.target_poi).toBe("poi_0041_002");
    // Clean up
    systemPoiCache.clear();
  });

  it("does not call get_system when POI cache is already populated", async () => {
    systemPoiCache.clear();
    systemPoiCache.set("sys_0041", [
      { id: "poi_0041_001", name: "Sol Belt", type: "asteroid_belt" },
      { id: "poi_0041_002", name: "Sol Station", type: "station" },
    ]);
    const executed: Array<{ tool: string }> = [];
    const cache = makeStatusCache("agent", {
      player: { current_system: "sys_0041", current_poi: "poi_0041_001", docked_at_base: null },
    });
    const client = makeClient({
      execute: async (tool) => {
        executed.push({ tool });
        return { result: { ok: true } };
      },
    });
    const deps = makeDeps("agent", client, cache);

    await travelTo(deps, "sol_station", resolvePoiId, false);

    // get_system should NOT be called since cache is populated
    expect(executed.some(e => e.tool === "get_system")).toBe(false);
    // Clean up
    systemPoiCache.clear();
  });

  it("does not call get_system for poi_ prefixed destinations", async () => {
    systemPoiCache.clear();
    const executed: Array<{ tool: string }> = [];
    const cache = makeStatusCache("agent", {
      player: { current_system: "sys_0041", current_poi: "poi_0041_001", docked_at_base: null },
    });
    const client = makeClient({
      execute: async (tool) => {
        executed.push({ tool });
        return { result: { ok: true } };
      },
    });
    const deps = makeDeps("agent", client, cache);

    await travelTo(deps, "poi_0041_002", resolvePoiId, false);

    // get_system should NOT be called for raw POI IDs
    expect(executed.some(e => e.tool === "get_system")).toBe(false);
    systemPoiCache.clear();
  });
});

// ---------------------------------------------------------------------------
// jumpRoute
// ---------------------------------------------------------------------------

describe("jumpRoute", () => {
  function makeJumpClient(
    systemSequence: string[],
    cacheMap: Map<string, StatusEntry>,
    agentName: string,
  ): GameClientLike {
    let jumpIdx = 0;
    return {
      execute: async (tool, args) => {
        if (tool === "jump") {
          const sysId = systemSequence[jumpIdx++] ?? (args?.target_system as string);
          // Update cache to simulate system change
          const prev = cacheMap.get(agentName);
          if (prev) {
            cacheMap.set(agentName, {
              data: {
                ...prev.data,
                player: { ...(prev.data.player as Record<string, unknown>), current_system: sysId },
              },
              fetchedAt: Date.now(),
            });
          }
          return { result: { ok: true } };
        }
        if (tool === "refuel" || tool === "undock") return { result: {} };
        return { result: {} };
      },
      waitForTick: async () => {},
      lastArrivalTick: null,
    };
  }

  it("jumps through all systems and returns location_after", async () => {
    const cache = makeStatusCache("agent", {
      player: { current_system: "sol", current_poi: "sol_belt", docked_at_base: null },
    });
    const systemIds = ["alpha", "beta", "gamma"];
    const client = makeJumpClient(systemIds, cache, "agent");
    const deps = makeDeps("agent", client, cache);

    const result = await jumpRoute(deps, systemIds);

    expect(result.status).toBe("completed");
    expect(result.jumps_completed).toBe(3);
    expect(result.jumps_total).toBe(3);
    expect(result.stopped_reason).toBeUndefined();
  });

  it("stops and reports reason when a jump fails", async () => {
    let jumpCount = 0;
    const client = makeClient({
      execute: async (tool, args) => {
        if (tool === "jump") {
          jumpCount++;
          if (jumpCount === 2) return { error: { code: "jump_failed" } };
          return { result: { ok: true } };
        }
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, makeStatusCache("agent", {
      player: { current_system: "sol", current_poi: "sol_belt", docked_at_base: null },
    }));

    const result = await jumpRoute(deps, ["alpha", "beta", "gamma"]);

    expect(result.status).toBe("error");
    expect(result.jumps_completed).toBe(1);
    expect(result.error).toBe("jump_failed");
    expect(result.message).toBe("jump_failed at beta");
    // New enriched error fields
    expect(result.game_error).toEqual({ code: "jump_failed" });
    expect(result.hint).toBeTypeOf("string");
    expect(result.jumps_remaining).toBe(2);
  });

  it("includes fuel context and low-fuel hint when jump fails with low fuel", async () => {
    let jumpCount = 0;
    const cache = makeStatusCache("agent", {
      player: { current_system: "sol", current_poi: "sol_belt", docked_at_base: null },
      ship: { fuel: 8, fuel_capacity: 100 },
    });
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "jump") {
          jumpCount++;
          if (jumpCount === 1) return { error: "insufficient_fuel" };
          return { result: { ok: true } };
        }
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, cache);

    const result = await jumpRoute(deps, ["alpha", "beta", "gamma"]);

    expect(result.status).toBe("error");
    expect(result.jumps_completed).toBe(0);
    expect(result.fuel_remaining).toBe(8);
    expect(result.fuel_capacity).toBe(100);
    expect(result.hint).toContain("Low fuel");
    expect(result.hint).toContain("Refuel");
    expect(result.current_system).toBe("sol");
    expect(result.game_error).toEqual({ detail: "insufficient_fuel" });
    expect(result.jumps_remaining).toBe(3);
  });

  it("includes default hint when jump fails with adequate fuel", async () => {
    let jumpCount = 0;
    const cache = makeStatusCache("agent", {
      player: { current_system: "sol", current_poi: "sol_belt", docked_at_base: null },
      ship: { fuel: 80, fuel_capacity: 100 },
    });
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "jump") {
          jumpCount++;
          if (jumpCount === 2) return { error: { code: "system_not_found" } };
          return { result: { ok: true } };
        }
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, cache);

    const result = await jumpRoute(deps, ["alpha", "beta", "gamma"]);

    expect(result.status).toBe("error");
    expect(result.jumps_completed).toBe(1);
    expect(result.fuel_remaining).toBe(80);
    expect(result.hint).toBe("Try a shorter route or jump manually to the next system.");
    expect(result.game_error).toEqual({ code: "system_not_found" });
  });

  it("auto-undocks if docked at station before jumping", async () => {
    const undockCalls: string[] = [];
    const refuelCalls: string[] = [];
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "undock") { undockCalls.push("undock"); return { result: {} }; }
        if (tool === "refuel") { refuelCalls.push("refuel"); return { result: {} }; }
        return { result: { ok: true } };
      },
    });
    const cache = makeStatusCache("agent", {
      player: {
        current_system: "sol",
        current_poi: "sol_station",
        docked_at_base: "sol_station_base",
      },
    });
    const deps = makeDeps("agent", client, cache);

    await jumpRoute(deps, ["alpha"]);

    expect(undockCalls).toContain("undock");
    expect(refuelCalls).toContain("refuel");
  });

  it("clamps system_ids list to 30", async () => {
    let jumpCount = 0;
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "jump") jumpCount++;
        return { result: { ok: true } };
      },
    });
    const deps = makeDeps("agent", client, makeStatusCache("agent", {
      player: { current_system: "sol", current_poi: "sol_belt", docked_at_base: null },
    }));

    const manyIds = Array.from({ length: 50 }, (_, i) => `sys_${i}`);
    const result = await jumpRoute(deps, manyIds);

    expect(jumpCount).toBe(30);
    expect(result.jumps_total).toBe(30);
  });

  it("aborts jump sequence when pirate_combat event is detected before a hop", async () => {
    const cache = makeStatusCache("agent", {
      player: { current_system: "sol", current_poi: "sol_belt", docked_at_base: null },
    });
    const systemIds = ["alpha", "beta", "gamma"];
    let jumpCount = 0;
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "jump") { jumpCount++; return { result: { ok: true } }; }
        return { result: {} };
      },
    });

    // Inject a pirate_combat event into the event buffer
    const eventBuffers = new Map<string, { events?: Array<{ type: string }> }>([
      ["agent", { events: [{ type: "pirate_combat" }] }],
    ]);

    const deps = makeDeps("agent", client, cache, { eventBuffers });

    const result = await jumpRoute(deps, systemIds);

    // Should abort immediately on first hop (before any jump)
    expect(result.status).toBe("error");
    expect(result.error).toBe("jump_route_interrupted");
    expect(result.reason).toBe("pirate_combat detected");
    expect(result.jumps_completed).toBe(0);
    expect(result.total_jumps).toBe(3);
    expect(jumpCount).toBe(0); // no jumps were made
  });

  it("completes jumps until pirate_combat event appears mid-route", async () => {
    const cache = makeStatusCache("agent", {
      player: { current_system: "sol", current_poi: "sol_belt", docked_at_base: null },
    });
    const systemIds = ["alpha", "beta", "gamma"];
    let jumpCount = 0;
    // We'll add the pirate_combat event after the first jump by using a mutable buffer
    const eventBuffer: { events: Array<{ type: string }> } = { events: [] };
    const eventBuffers = new Map<string, { events?: Array<{ type: string }> }>([
      ["agent", eventBuffer],
    ]);

    const client: GameClientLike = {
      execute: async (tool, args) => {
        if (tool === "jump") {
          jumpCount++;
          // Update cache system
          const prev = cache.get("agent");
          if (prev) {
            cache.set("agent", {
              data: { ...prev.data, player: { ...(prev.data.player as Record<string, unknown>), current_system: args?.target_system as string } },
              fetchedAt: Date.now(),
            });
          }
          // Inject pirate_combat after first jump
          if (jumpCount === 1) {
            eventBuffer.events.push({ type: "pirate_combat" });
          }
          return { result: { ok: true } };
        }
        return { result: {} };
      },
      waitForTick: async () => {},
      lastArrivalTick: null,
    };

    const deps = makeDeps("agent", client, cache, { eventBuffers });
    const result = await jumpRoute(deps, systemIds);

    // First jump completes, then interrupt fires before second hop
    expect(result.status).toBe("error");
    expect(result.error).toBe("jump_route_interrupted");
    expect(result.jumps_completed).toBe(1);
    expect(jumpCount).toBe(1);
  });

  it("does NOT patch cache from 'jump completed' message — waits for server state_update", async () => {
    const cache = makeStatusCache("agent", {
      player: { current_system: "sol", current_poi: "sol_belt", docked_at_base: null },
    });
    const client: GameClientLike = {
      execute: async (tool) => {
        if (tool === "jump") {
          return { result: { message: "jump completed", ok: true } };
        }
        return { result: {} };
      },
      waitForTick: async () => {
        // Simulate server sending state_update: cache updates to destination
        const cached = cache.get("agent");
        if (cached?.data?.player) {
          (cached.data.player as Record<string, unknown>).current_system = "alpha";
          cache.set("agent", { data: cached.data, fetchedAt: Date.now() });
        }
      },
      lastArrivalTick: null,
    };
    const deps = makeDeps("agent", client, cache);

    const result = await jumpRoute(deps, ["alpha"]);

    expect(result.jumps_completed).toBe(1);
    // Cache should reflect server-confirmed destination
    const cached = cache.get("agent");
    expect((cached?.data?.player as Record<string, unknown>)?.current_system).toBe("alpha");
  });

  it("marks anyUnconfirmed=true on poll timeout — does NOT guess destination", async () => {
    const cache = makeStatusCache("agent", {
      player: { current_system: "sol", current_poi: "sol_belt", docked_at_base: null },
    });
    const client: GameClientLike = {
      execute: async (tool) => {
        if (tool === "jump") {
          return { result: { ok: true } };
        }
        return { result: {} };
      },
      // waitForTick never updates cache — forces poll timeout path
      waitForTick: async () => {},
      lastArrivalTick: null,
    };
    const deps = makeDeps("agent", client, cache);

    const result = await jumpRoute(deps, ["alpha"]);

    expect(result.jumps_completed).toBe(1);
    // Cache should NOT be patched with guessed destination
    const cached = cache.get("agent");
    // current_system stays as "sol" (unconfirmed — server didn't send state_update)
    expect((cached?.data?.player as Record<string, unknown>)?.current_system).toBe("sol");
    // Result should indicate unconfirmed state
    expect(result.location_confirmed).toBe(false);
    expect(result.location_warning).toBeDefined();
  });

  it("jumps step-by-step through multi-hop route (each hop is a separate jump call)", async () => {
    const jumpTargets: string[] = [];
    const cache = makeStatusCache("agent", {
      player: { current_system: "sys_a", current_poi: "poi_a", docked_at_base: null },
    });
    const client: GameClientLike = {
      execute: async (tool, args) => {
        if (tool === "jump") {
          const target = (args as Record<string, unknown>)?.target_system as string;
          jumpTargets.push(target);
          // Update cache to simulate arrival
          cache.set("agent", {
            data: { player: { current_system: target, current_poi: null, docked_at_base: null } },
            fetchedAt: Date.now(),
          });
          return { result: { ok: true } };
        }
        return { result: {} };
      },
      waitForTick: async () => {},
      lastArrivalTick: null,
    };
    const deps = makeDeps("agent", client, cache);

    // Simulate 3-hop route: each ID is a separate jump
    const result = await jumpRoute(deps, ["sys_b", "sys_c", "sys_d"]);

    expect(result.status).toBe("completed");
    expect(result.jumps_completed).toBe(3);
    // Verify each hop was made in order — NOT jumping to sys_d directly
    expect(jumpTargets).toEqual(["sys_b", "sys_c", "sys_d"]);
  });

  it("stops at failed hop and does not attempt remaining jumps", async () => {
    const jumpTargets: string[] = [];
    const cache = makeStatusCache("agent", {
      player: { current_system: "sys_a", current_poi: null, docked_at_base: null },
    });
    const client = makeClient({
      execute: async (tool, args) => {
        if (tool === "jump") {
          const target = (args as Record<string, unknown>)?.target_system as string;
          jumpTargets.push(target);
          if (target === "sys_b") return { error: "Cannot jump — not connected" };
          return { result: { ok: true } };
        }
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, cache);

    const result = await jumpRoute(deps, ["sys_b", "sys_c", "sys_d"]);

    expect(result.status).toBe("error");
    expect(result.jumps_completed).toBe(0);
    // Only sys_b was attempted; sys_c and sys_d were skipped
    expect(jumpTargets).toEqual(["sys_b"]);
    expect(result.message).toContain("sys_b");
  });
});

// ---------------------------------------------------------------------------
// multiSell
// ---------------------------------------------------------------------------

describe("multiSell", () => {
  it("sells all items and returns aggregated result with credits delta", async () => {
    const cache = makeStatusCache("agent", {
      player: {
        current_system: "sol",
        current_poi: "sol_station",
        credits: 1500,
        docked_at_base: "sol_station",
      },
    });
    const client = makeClient({
      execute: async (tool, args) => {
        if (tool === "sell") {
          // Update credits in cache after first sell
          const prev = cache.get("agent")!;
          cache.set("agent", {
            data: {
              ...prev.data,
              player: { ...(prev.data.player as Record<string, unknown>), credits: 2000 },
            },
            fetchedAt: Date.now(),
          });
          return { result: { credits_earned: 500 } };
        }
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, cache);
    const calledTools = new Set(["analyze_market"]);

    const result = await multiSell(
      deps,
      [{ item_id: "iron_ore", quantity: 10 }],
      calledTools,
    );

    expect(result.status).toBe("completed");
    expect(result.items_sold).toBe(1);
    const sells = result.sells as Array<{ item_id: string }>;
    expect(sells[0].item_id).toBe("iron_ore");
    expect(result.credits_after).toBe(2000);
  });

  it("proceeds with advisory when analyze_market not called", async () => {
    const cache = makeStatusCache("agent", {
      player: { docked_at_base: "sol_station", credits: 1000 },
      ship: { cargo_used: 10 },
    });
    const client = makeClient({
      execute: async () => ({ result: { ok: true } }),
    });
    const deps = makeDeps("agent", client, cache);
    const calledTools = new Set<string>(); // missing analyze_market

    const result = await multiSell(deps, [{ item_id: "iron_ore", quantity: 5 }], calledTools);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("completed");
    expect(result._market_advisory).toContain("analyze_market");
  });

  it("blocks when not docked (after fresh status refresh)", async () => {
    const cache = makeStatusCache("agent", {
      player: { docked_at_base: null },
    });
    // get_status is called to refresh, but cache still shows not docked
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_status") return { result: { player: { docked_at_base: null } } };
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, cache);
    const result = await multiSell(deps, [{ item_id: "iron_ore", quantity: 5 }], new Set(["analyze_market"]));

    expect(result.error).toBeTruthy();
    expect(String(result.error)).toContain("must be docked");
  });

  it("proceeds when stale cache says not docked but fresh status confirms docked", async () => {
    const cache = makeStatusCache("agent", {
      player: { docked_at_base: null, credits: 1000, current_poi: "sol_station" },
    });
    let getStatusCalled = false;
    const client = makeClient({
      execute: async (tool, args) => {
        if (tool === "get_status") {
          getStatusCalled = true;
          // Simulate the onStateUpdate callback updating the cache
          cache.set("agent", {
            data: {
              player: { docked_at_base: "sol_station", credits: 1000, current_poi: "sol_station" },
              ship: { cargo_used: 10 },
            },
            fetchedAt: Date.now(),
          });
          return { result: { player: { docked_at_base: "sol_station" } } };
        }
        if (tool === "sell") {
          return { result: { credits_earned: 100 } };
        }
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, cache);
    const calledTools = new Set(["analyze_market"]);

    const result = await multiSell(deps, [{ item_id: "iron_ore", quantity: 5 }], calledTools);

    expect(getStatusCalled).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("completed");
  });

  it("adds warning when 0 credits earned", async () => {
    const cache = makeStatusCache("agent", {
      player: { current_poi: "sol_station", credits: 1000, docked_at_base: "sol_station" },
    });
    const client = makeClient({
      execute: async () => ({ result: {} }), // credits don't change
    });
    const deps = makeDeps("agent", client, cache);
    const calledTools = new Set(["analyze_market"]);

    const result = await multiSell(
      deps,
      [{ item_id: "iron_ore", quantity: 5 }],
      calledTools,
    );

    expect(result.warning).toBeTruthy();
    expect(String(result.warning)).toContain("0 credits");
  });

  it("waits for tick on pending sell results", async () => {
    let ticked = 0;
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "sell") return { result: { pending: true, command: "sell" } };
        return { result: {} };
      },
      waitForTick: async () => { ticked++; },
    });
    const cache = makeStatusCache("agent", {
      player: { current_poi: "sol_station", credits: 1000, docked_at_base: "sol_station" },
    });
    const deps = makeDeps("agent", client, cache);

    await multiSell(deps, [{ item_id: "iron_ore", quantity: 5 }], new Set(["analyze_market"]));

    // waitForTick is called once (final wait only — per-item tick waits removed to prevent HTTP timeout)
    expect(ticked).toBe(1);
  });

  it("records sells in sellLog for fleet deconfliction", async () => {
    const sellLog = new SellLog();
    const cache = makeStatusCache("agent", {
      player: { current_poi: "sol_station", credits: 1000, docked_at_base: "sol_station" },
    });
    const client = makeClient({
      execute: async () => ({ result: { ok: true } }),
    });
    const deps = makeDeps("agent", client, cache, { sellLog });

    await multiSell(
      deps,
      [{ item_id: "iron_ore", quantity: 5 }],
      new Set(["analyze_market"]),
    );

    const recent = sellLog.getRecent("sol_station");
    expect(recent).toHaveLength(1);
    expect(recent[0].item_id).toBe("iron_ore");
    expect(recent[0].agent).toBe("agent");
  });

  it("sells 120 items with only 1 final tick wait (no batch waits)", async () => {
    let tickWaits = 0;
    let sellCount = 0;

    const cache = makeStatusCache("agent", {
      player: { current_poi: "sol_station", credits: 100000, docked_at_base: "sol_station" },
    });
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "sell") {
          sellCount++;
          return { result: { ok: true } };
        }
        return { result: {} };
      },
      waitForTick: async () => { tickWaits++; },
    });
    const deps = makeDeps("agent", client, cache);

    const items: Array<{ item_id: string; quantity: number }> = [];
    for (let i = 0; i < 120; i++) {
      items.push({ item_id: `item_${i}`, quantity: 1 });
    }

    await multiSell(deps, items, new Set(["analyze_market"]));

    expect(sellCount).toBe(120);
    // Only 1 final tick wait — batch waits removed to prevent HTTP response timeouts
    expect(tickWaits).toBe(1);
  });

  it("does not batch for small sells (under BATCH_SIZE)", async () => {
    let tickWaits = 0;

    const cache = makeStatusCache("agent", {
      player: { current_poi: "sol_station", credits: 10000, docked_at_base: "sol_station" },
    });
    const client = makeClient({
      execute: async () => ({ result: { ok: true } }),
      waitForTick: async () => { tickWaits++; },
    });
    const deps = makeDeps("agent", client, cache);

    // Create 10 items (less than BATCH_SIZE of 35)
    const items: Array<{ item_id: string; quantity: number }> = [];
    for (let i = 0; i < 10; i++) {
      items.push({ item_id: `item_${i}`, quantity: 1 });
    }

    await multiSell(deps, items, new Set(["analyze_market"]));

    // For small sells under BATCH_SIZE, only the final tick wait should occur
    // (unless items have pending=true, which they don't in this test)
    expect(tickWaits).toBe(1); // Only final wait
  });
});

// ---------------------------------------------------------------------------
// scanAndAttack
// ---------------------------------------------------------------------------

describe("scanAndAttack", () => {
  const OUR_AGENTS = new Set<string>();

  function makeFullCombatClient(overrides: {
    battleStatuses?: Array<Record<string, unknown>>;
    attackError?: unknown;
    nearbyEntities?: Array<Record<string, unknown>>;
  } = {}): GameClientLike {
    const statuses = overrides.battleStatuses ?? [{ status: "victory", hull: 80 }];
    let statusIdx = 0;

    return makeClient({
      execute: async (tool) => {
        if (tool === "get_nearby") {
          const nearby = overrides.nearbyEntities ?? [
            { username: "pirate_player", player_id: "pid_1", anonymous: false, in_combat: false },
          ];
          return { result: { nearby } };
        }
        if (tool === "attack") {
          if (overrides.attackError) return { error: overrides.attackError };
          return { result: { ok: true } };
        }
        if (tool === "get_battle_status") {
          const s = statuses[Math.min(statusIdx, statuses.length - 1)];
          statusIdx++;
          return { result: s };
        }
        if (tool === "get_wrecks") {
          return { result: { wrecks: [{ id: "wreck_1" }] } };
        }
        if (tool === "salvage_wreck") {
          return { result: { loot: ["iron"] } };
        }
        return { result: {} };
      },
    });
  }

  function makeCombatCache(agentName: string): Map<string, StatusEntry> {
    return makeStatusCache(agentName, {
      ship: {
        hull: 80,
        fuel: 80,
        weapons: [{ id: "laser" }],
        weapon_slots: 2,
        cargo: [{ item_id: "ammo_kinetic", quantity: 50 }],
      },
      player: { current_system: "sol", current_poi: "sol_belt", docked_at_base: null },
      nearby: [],
    });
  }

  it("returns no_targets when there are no attackable entities", async () => {
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_nearby") return { result: { nearby: [] } };
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, makeCombatCache("agent"));

    const result = await scanAndAttack(deps, OUR_AGENTS);
    expect(result.status).toBe("no_targets");
  });

  it("returns no_weapons when ship has no weapons installed", async () => {
    const cache = makeStatusCache("agent", {
      ship: { hull: 80, fuel: 80, weapons: [], weapon_slots: 2, cargo: [] },
      player: { current_system: "sol", current_poi: "sol_belt", docked_at_base: null },
      nearby: [{ username: "pirate_player", in_combat: false, anonymous: false }],
    });
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_nearby")
          return { result: { nearby: [{ username: "pirate_player", player_id: "p1", in_combat: false, anonymous: false }] } };
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, cache);

    const result = await scanAndAttack(deps, OUR_AGENTS);
    // Phase 4: Now returns "not_ready" with readiness_details instead of "no_weapons"
    expect(result.status).toBe("not_ready");
    expect(result.reason).toContain("No weapons");
    expect(result.readiness_details).toBeTruthy();
  });

  it("returns safe_zone when docked at a station", async () => {
    const cache = makeStatusCache("agent", {
      ship: { hull: 80, fuel: 80, weapons: [{ id: "laser" }], cargo: [{ item_id: "ammo_standard", quantity: 50 }] },
      player: {
        current_system: "sol",
        current_poi: "sol_station",
        docked_at_base: "sol_station_base",
      },
      nearby: [],
    });
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_nearby")
          return { result: { nearby: [{ username: "pirate_player", player_id: "p1", in_combat: false, anonymous: false }] } };
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, cache);

    const result = await scanAndAttack(deps, OUR_AGENTS);
    expect(result.status).toBe("safe_zone");
  });

  it("returns battle_failed when attack returns an error", async () => {
    const client = makeFullCombatClient({
      attackError: { code: "target_invincible" },
    });
    const deps = makeDeps("agent", client, makeCombatCache("agent"));

    const result = await scanAndAttack(deps, OUR_AGENTS);
    expect(result.status).toBe("battle_failed");
    expect(result.error).toEqual({ code: "target_invincible" });
  });

  it("completes a full battle loop and returns victory", async () => {
    const client = makeFullCombatClient({
      battleStatuses: [
        { status: "active", hull: 80, zone: "outer" },
        { status: "victory", hull: 75 },
      ],
    });
    const deps = makeDeps("agent", client, makeCombatCache("agent"));

    const result = await scanAndAttack(deps, OUR_AGENTS);
    expect(result.status).toBe("victory");
    expect(result.loot).toBeTruthy();
  });

  it("switches stance to brace when hull drops below 30%", async () => {
    const stanceCalls: string[] = [];
    const client = makeClient({
      execute: async (tool, args) => {
        if (tool === "get_nearby")
          return { result: { nearby: [{ username: "pirate_player", player_id: "p1", in_combat: false, anonymous: false }] } };
        if (tool === "attack") return { result: {} };
        if (tool === "get_battle_status" && stanceCalls.length === 0) {
          return { result: { status: "active", hull: 25, zone: "outer" } };
        }
        if (tool === "get_battle_status") {
          return { result: { status: "victory", hull: 25 } };
        }
        if (tool === "battle" && args?.action === "stance") {
          stanceCalls.push(String(args.stance));
          return { result: {} };
        }
        if (tool === "get_wrecks") return { result: { wrecks: [] } };
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, makeCombatCache("agent"));

    const result = await scanAndAttack(deps, OUR_AGENTS);
    expect(stanceCalls).toContain("brace");
    expect(result.status).toBe("victory");
  });

  it("switches stance to flee when hull drops below 20%", async () => {
    const stanceCalls: string[] = [];
    // Use a state machine: first N get_battle_status calls are for battle init
    // (up to BATTLE_INIT_MAX_TICKS=3), then the real battle loop starts.
    let battleInitDone = false;
    let battleLoopTick = 0;
    const client = makeClient({
      execute: async (tool, args) => {
        if (tool === "get_nearby")
          return { result: { nearby: [{ username: "pirate_player", player_id: "p1", in_combat: false, anonymous: false }] } };
        if (tool === "attack") return { result: {} };
        if (tool === "get_battle_status") {
          if (!battleInitDone) {
            // First call: battle is initialised (init check succeeds)
            battleInitDone = true;
            return { result: { status: "active", hull: 80 } };
          }
          // Battle loop ticks
          battleLoopTick++;
          if (battleLoopTick === 1) return { result: { status: "active", hull: 15, zone: "outer" } };
          return { result: { status: "fled", hull: 15 } };
        }
        if (tool === "battle" && args?.action === "stance") {
          stanceCalls.push(String(args.stance));
          return { result: {} };
        }
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, makeCombatCache("agent"));

    await scanAndAttack(deps, OUR_AGENTS);
    expect(stanceCalls).toContain("flee");
  });

  it("targets specific entity when targetArg is provided", async () => {
    const attackTargets: string[] = [];
    const client = makeClient({
      execute: async (tool, args) => {
        if (tool === "get_nearby")
          return { result: { nearby: [{ username: "specific_pirate", player_id: "p_spec", in_combat: false }] } };
        if (tool === "attack") {
          attackTargets.push(String(args?.target_id));
          return { result: {} };
        }
        if (tool === "get_battle_status") return { result: { status: "victory", hull: 80 } };
        if (tool === "get_wrecks") return { result: { wrecks: [] } };
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, makeCombatCache("agent"));

    await scanAndAttack(deps, OUR_AGENTS, "specific_pirate");
    expect(attackTargets[0]).toBe("p_spec"); // matched player_id from nearby
  });

  it("clears battle cache after fight ends", async () => {
    const battleCache = new Map<string, BattleStateForCache | null>();
    const client = makeFullCombatClient();
    const deps = makeDeps("agent", client, makeCombatCache("agent"), {
      battleCache,
    });

    await scanAndAttack(deps, OUR_AGENTS);

    expect(battleCache.get("agent")).toBeNull();
  });

  it("sends combat alert via upsertNote when hull drops below 30%", async () => {
    const notes: Array<{ type: string; content: string }> = [];
    let battleInitDone = false;
    let battleLoopTick = 0;
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_nearby")
          return { result: { nearby: [{ username: "pirate_player", player_id: "p1", in_combat: false, anonymous: false }] } };
        if (tool === "attack") return { result: {} };
        if (tool === "get_battle_status") {
          if (!battleInitDone) {
            battleInitDone = true;
            return { result: { status: "active", hull: 80 } };
          }
          battleLoopTick++;
          if (battleLoopTick === 1) return { result: { status: "active", hull: 25, zone: "outer" } };
          return { result: { status: "victory", hull: 25 } };
        }
        if (tool === "get_wrecks") return { result: { wrecks: [] } };
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, makeCombatCache("agent"), {
      upsertNote: (_agent, type, content) => {
        notes.push({ type, content });
      },
    });

    await scanAndAttack(deps, OUR_AGENTS);

    expect(notes.some((n) => n.type === "report" && n.content.includes("COMBAT ALERT"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// battleReadiness
// ---------------------------------------------------------------------------

describe("battleReadiness", () => {
  it("returns ready=true when hull/fuel are good and ammo is present", () => {
    const cache = makeStatusCache("agent", {
      ship: {
        hull: 80,
        fuel: 50,
        weapons: [{ id: "laser" }],
        cargo: [{ item_id: "ammo_kinetic", quantity: 20 }],
      },
      player: { current_system: "sol", current_poi: "sol_belt" },
      nearby: [],
    });
    const deps = { agentName: "agent", statusCache: cache };

    const result = battleReadiness(deps, new Set());
    expect(result.ready).toBe(true);
    expect(result.hull).toBe(80);
    expect(result.fuel).toBe(50);
    expect(Array.isArray(result.ammo)).toBe(true);
  });

  it("returns issues when hull is critical", () => {
    const cache = makeStatusCache("agent", {
      ship: { hull: 20, fuel: 80, cargo: [] },
      player: { current_system: "sol", current_poi: "sol_belt" },
      nearby: [],
    });
    const result = battleReadiness({ agentName: "agent", statusCache: cache }, new Set());
    expect(result.ready).toBe(false);
    const issues = result.issues as string[];
    expect(issues.some((i) => i.includes("critical"))).toBe(true);
  });

  it("returns issues when fuel is low", () => {
    const cache = makeStatusCache("agent", {
      ship: { hull: 80, fuel: 10, cargo: [{ item_id: "ammo_kinetic", quantity: 5 }] },
      player: { current_system: "sol", current_poi: "sol_belt" },
      nearby: [],
    });
    const result = battleReadiness({ agentName: "agent", statusCache: cache }, new Set());
    expect(result.ready).toBe(false);
    const issues = result.issues as string[];
    expect(issues.some((i) => i.includes("fuel"))).toBe(true);
  });

  it("reports no ammo when cargo has none", () => {
    const cache = makeStatusCache("agent", {
      ship: { hull: 80, fuel: 80, weapons: [{ id: "laser" }], cargo: [] },
      player: { current_system: "sol", current_poi: "sol_belt" },
      nearby: [],
    });
    const result = battleReadiness({ agentName: "agent", statusCache: cache }, new Set());
    expect(result.ammo).toEqual([]);
    const issues = result.issues as string[];
    expect(issues.some((i) => i.includes("ammo"))).toBe(true);
  });

  it("detects rounds_standard as valid ammo (kinetic cannon ammo)", () => {
    const cache = makeStatusCache("agent", {
      ship: {
        hull: 80,
        fuel: 50,
        weapons: [{ id: "autocannon" }],
        cargo: [{ item_id: "rounds_standard", quantity: 4 }],
      },
      player: { current_system: "sol", current_poi: "sol_belt" },
      nearby: [],
    });
    const result = battleReadiness({ agentName: "agent", statusCache: cache }, new Set());
    expect(result.ready).toBe(true);
    expect(Array.isArray(result.ammo)).toBe(true);
    const ammoList = result.ammo as Array<{ id: string; qty: number }>;
    expect(ammoList.some((a) => a.id === "rounds_standard")).toBe(true);
  });

  it("counts nearby threats using findTargets", () => {
    const cache = makeStatusCache("agent", {
      ship: { hull: 80, fuel: 80, cargo: [{ item_id: "ammo_kinetic", quantity: 5 }] },
      player: { current_system: "sol", current_poi: "sol_belt" },
      nearby: [
        { username: "pirate_1", in_combat: false, anonymous: false },
        { username: "pirate_2", in_combat: false, anonymous: false },
      ],
    });
    const result = battleReadiness({ agentName: "agent", statusCache: cache }, new Set());
    expect(result.nearby_threats).toBe(2);
    expect(result.total_nearby).toBe(2);
  });

  it("handles missing cache gracefully", () => {
    const cache = new Map<string, StatusEntry>(); // no entry for agent
    const result = battleReadiness({ agentName: "agent", statusCache: cache }, new Set());
    expect(result.hull).toBe(-1);
    expect(result.fuel).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// lootWrecks
// ---------------------------------------------------------------------------

describe("lootWrecks", () => {
  it("returns no_wrecks when get_wrecks returns empty list", async () => {
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_wrecks") return { result: { wrecks: [] } };
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, makeStatusCache("agent", {}));

    const result = await lootWrecks(deps, 5);
    expect(result.status).toBe("no_wrecks");
    expect(result.wrecks_found).toBe(0);
  });

  it("returns error when get_wrecks fails", async () => {
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_wrecks") return { error: { code: "not_in_space" } };
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, makeStatusCache("agent", {}));

    const result = await lootWrecks(deps);
    expect(result.error).toEqual({ code: "not_in_space" });
  });

  it("salvages up to count wrecks", async () => {
    const salvageCalls: string[] = [];
    const client = makeClient({
      execute: async (tool, args) => {
        if (tool === "get_wrecks") {
          return {
            result: {
              wrecks: [
                { id: "w1" },
                { id: "w2" },
                { id: "w3" },
                { id: "w4" },
                { id: "w5" },
                { id: "w6" },
              ],
            },
          };
        }
        if (tool === "salvage_wreck") {
          salvageCalls.push(String(args?.wreck_id));
          return { result: { loot: ["iron"] } };
        }
        if (tool === "get_cargo") return { result: { cargo: [] } };
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, makeStatusCache("agent", {}));

    const result = await lootWrecks(deps, 3);

    expect(result.wrecks_found).toBe(6);
    expect(result.wrecks_salvaged).toBe(3);
    expect(salvageCalls).toHaveLength(3);
    expect(result.remaining_wrecks).toBe(3);
  });

  it("clamps count to max 10", async () => {
    const salvageCalls: string[] = [];
    const wrecks = Array.from({ length: 15 }, (_, i) => ({ id: `w${i}` }));
    const client = makeClient({
      execute: async (tool, args) => {
        if (tool === "get_wrecks") return { result: { wrecks } };
        if (tool === "salvage_wreck") {
          salvageCalls.push(String(args?.wreck_id));
          return { result: {} };
        }
        if (tool === "get_cargo") return { result: {} };
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, makeStatusCache("agent", {}));

    await lootWrecks(deps, 20); // over the 10-cap

    expect(salvageCalls).toHaveLength(10);
  });

  it("handles individual salvage errors without stopping", async () => {
    let salvageIdx = 0;
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_wrecks")
          return { result: { wrecks: [{ id: "w1" }, { id: "w2" }, { id: "w3" }] } };
        if (tool === "salvage_wreck") {
          salvageIdx++;
          if (salvageIdx === 2) return { error: { code: "already_looted" } };
          return { result: { loot: ["iron"] } };
        }
        if (tool === "get_cargo") return { result: {} };
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, makeStatusCache("agent", {}));

    const result = await lootWrecks(deps, 3);

    expect(result.wrecks_salvaged).toBe(3); // attempted 3, 1 failed
    const results = result.results as Array<{ status: string }>;
    expect(results.some((r) => r.status === "failed")).toBe(true);
    expect(results.some((r) => r.status === "looted")).toBe(true);
  });

  it("waits for tick when salvage returns pending", async () => {
    let ticked = 0;
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_wrecks") return { result: { wrecks: [{ id: "w1" }] } };
        if (tool === "salvage_wreck")
          return { result: { pending: true, command: "salvage_wreck" } };
        if (tool === "get_cargo") return { result: {} };
        return { result: {} };
      },
      waitForTick: async () => { ticked++; },
    });
    const deps = makeDeps("agent", client, makeStatusCache("agent", {}));

    await lootWrecks(deps, 1);
    expect(ticked).toBeGreaterThanOrEqual(1);
  });

  it("handles wrecks returned as top-level array (not nested under 'wrecks' key)", async () => {
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_wrecks")
          return { result: [{ id: "w1" }, { id: "w2" }] }; // array, not {wrecks:[...]}
        if (tool === "salvage_wreck") return { result: { loot: [] } };
        if (tool === "get_cargo") return { result: {} };
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, makeStatusCache("agent", {}));

    const result = await lootWrecks(deps, 5);
    expect(result.wrecks_found).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// waitForNavCacheUpdate
// ---------------------------------------------------------------------------

describe("waitForNavCacheUpdate", () => {
  it("returns true when system changes after one tick", async () => {
    let tick = 0;
    const cache = makeStatusCache("agent", {
      player: { current_system: "sol" },
    });
    const client: { waitForTick: () => Promise<void>; lastArrivalTick: number | null } = {
      waitForTick: async () => {
        tick++;
        if (tick === 1) {
          cache.set("agent", {
            data: { player: { current_system: "alpha" } },
            fetchedAt: Date.now(),
          });
        }
      },
      lastArrivalTick: null,
    };

    const updated = await waitForNavCacheUpdate(client, "agent", "sol", cache);
    expect(updated).toBe(true);
  });

  it("returns false when system never changes within maxTicks", async () => {
    const cache = makeStatusCache("agent", {
      player: { current_system: "sol" },
    });
    const client = {
      waitForTick: async () => {},
      lastArrivalTick: null,
    };

    const updated = await waitForNavCacheUpdate(client, "agent", "sol", cache, 3);
    expect(updated).toBe(false);
  });

  it("fast path: uses waitForNextArrival signal then one get_status instead of polling", async () => {
    let waitForTickCalls = 0;
    let arrivedCb: (() => void) | null = null;
    const cache = makeStatusCache("agent", { player: { current_system: "sol" } });

    const client: GameClientLike = {
      execute: async () => ({ result: {} }),
      waitForTick: async () => {
        waitForTickCalls++;
        // Simulate get_status confirming arrival at "alpha"
        cache.set("agent", { data: { player: { current_system: "alpha" } }, fetchedAt: Date.now() });
      },
      lastArrivalTick: null,
      waitForNextArrival: async (_beforeTick, _timeoutMs) => {
        // Simulate the game's deferred ok arriving promptly
        return true;
      },
    };

    const updated = await waitForNavCacheUpdate(client, "agent", "sol", cache);

    expect(updated).toBe(true);
    // Fast path should call waitForTick exactly once (one confirmation get_status)
    expect(waitForTickCalls).toBe(1);
  });

  it("fast path: still does one get_status on arrival timeout", async () => {
    let waitForTickCalls = 0;
    const cache = makeStatusCache("agent", { player: { current_system: "sol" } });

    const client: GameClientLike = {
      execute: async () => ({ result: {} }),
      waitForTick: async () => {
        waitForTickCalls++;
        // get_status returns same system (nav didn't complete)
      },
      lastArrivalTick: null,
      waitForNextArrival: async (_beforeTick, _timeoutMs) => false, // Timed out
    };

    const updated = await waitForNavCacheUpdate(client, "agent", "sol", cache);

    // Returns false (system didn't change), but polls up to 6 ticks as fallback
    expect(updated).toBe(false);
    expect(waitForTickCalls).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// flee
// ---------------------------------------------------------------------------

describe("flee", () => {
  it("returns not_in_battle when battle status is none", async () => {
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_battle_status") return { result: { status: "none" } };
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, makeStatusCache("agent", {
      player: { current_system: "sol", current_poi: "sol_belt", docked_at_base: null },
    }));

    const result = await flee(deps);

    expect(result.status).toBe("not_in_battle");
    expect(result.escaped).toBe(false);
  });

  it("returns error when get_battle_status fails", async () => {
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_battle_status") return { error: "status unavailable" };
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, makeStatusCache("agent", {}));

    const result = await flee(deps);

    expect(result.status).toBe("error");
    expect(result.escaped).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("returns error when battle stance change fails", async () => {
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_battle_status") return { result: { status: "active" } };
        if (tool === "battle") return { error: "stance change failed" };
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, makeStatusCache("agent", {}));

    const result = await flee(deps);

    expect(result.status).toBe("error");
    expect(result.escaped).toBe(false);
  });

  it("succeeds when escape is detected within 5 ticks", async () => {
    let tick = 0;
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_battle_status") return { result: { status: "active" } };
        if (tool === "battle") return { result: { ok: true } };
        if (tool === "get_status") {
          tick++;
          // Simulate escape on tick 2
          if (tick >= 2) {
            return {
              result: {
                ship: { battle_id: null },
              },
            };
          }
          return { result: { ship: { battle_id: "b123" } } };
        }
        if (tool === "undock") return { result: { undocked: true } };
        if (tool === "travel") return { result: { ok: true } };
        return { result: {} };
      },
      waitForTick: async () => {},
    });
    const cache = makeStatusCache("agent", {
      player: { current_system: "sol", current_poi: "sol_belt", docked_at_base: null },
    });
    const deps = makeDeps("agent", client, cache);

    const result = await flee(deps);

    expect(result.status).toBe("success");
    expect(result.escaped).toBe(true);
    expect(result.fled).toBe(true);
  });

  it("returns timeout when escape not detected after 5 ticks but undocks successfully", async () => {
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_battle_status") return { result: { status: "active" } };
        if (tool === "battle") return { result: { ok: true } };
        if (tool === "get_status") {
          return { result: { ship: { battle_id: "b123" } } }; // Battle persists
        }
        if (tool === "undock") return { result: { undocked: true } };
        if (tool === "travel") return { result: { ok: true } };
        return { result: {} };
      },
      waitForTick: async () => {},
    });
    const cache = makeStatusCache("agent", {
      player: { current_system: "sol", current_poi: "sol_belt", docked_at_base: null },
    });
    const deps = makeDeps("agent", client, cache);

    const result = await flee(deps);

    expect(result.status).toBe("timeout");
    expect(result.escaped).toBe(true); // Still safe (undocked)
    expect(result.fled).toBe(false); // But didn't escape the battle
  });

  it("returns error when undock fails", async () => {
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_battle_status") return { result: { status: "active" } };
        if (tool === "battle") return { result: { ok: true } };
        if (tool === "get_status") {
          return { result: { ship: { battle_id: null } } }; // Escaped
        }
        if (tool === "undock") return { error: "not docked" };
        return { result: {} };
      },
      waitForTick: async () => {},
    });
    const deps = makeDeps("agent", client, makeStatusCache("agent", {}));

    const result = await flee(deps);

    expect(result.status).toBe("error");
    expect(result.escaped).toBe(false);
  });

  it("logs escape attempt to notes via upsertNote", async () => {
    const notes: Array<{ agentName: string; type: string; content: string }> = [];
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_battle_status") return { result: { status: "active" } };
        if (tool === "battle") return { result: { ok: true } };
        if (tool === "get_status") {
          return { result: { ship: { battle_id: null } } };
        }
        if (tool === "undock") return { result: { undocked: true } };
        if (tool === "travel") return { result: { ok: true } };
        return { result: {} };
      },
      waitForTick: async () => {},
    });
    const cache = makeStatusCache("agent", {
      player: { current_system: "sol", current_poi: "sol_belt", docked_at_base: null },
    });
    const deps = makeDeps("agent", client, cache, {
      upsertNote: (agentName: string, type: string, content: string) => {
        notes.push({ agentName, type, content });
      },
    });

    await flee(deps);

    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0].type).toBe("escape_log");
    expect(notes[0].content).toContain("FLEE");
  });

  it("accepts optional target_poi to travel to after escape", async () => {
    const travelCalls: Array<Record<string, unknown>> = [];
    const client = makeClient({
      execute: async (tool, args) => {
        if (tool === "get_battle_status") return { result: { status: "active" } };
        if (tool === "battle") return { result: { ok: true } };
        if (tool === "get_status") {
          return { result: { ship: { battle_id: null } } };
        }
        if (tool === "undock") return { result: { undocked: true } };
        if (tool === "travel") {
          travelCalls.push(args ?? {});
          return { result: { ok: true } };
        }
        return { result: {} };
      },
      waitForTick: async () => {},
    });
    const cache = makeStatusCache("agent", {
      player: { current_system: "sol", current_poi: "sol_belt", docked_at_base: null },
    });
    const deps = makeDeps("agent", client, cache);

    await flee(deps, "safe_station");

    expect(travelCalls.length).toBeGreaterThan(0);
    const travelCall = travelCalls[travelCalls.length - 1];
    expect(travelCall.target_poi).toBe("safe_station");
  });

  it("defaults to nearest station when target_poi is omitted", async () => {
    const travelCalls: Array<Record<string, unknown>> = [];
    const client = makeClient({
      execute: async (tool, args) => {
        if (tool === "get_battle_status") return { result: { status: "active" } };
        if (tool === "battle") return { result: { ok: true } };
        if (tool === "get_status") {
          return { result: { ship: { battle_id: null } } };
        }
        if (tool === "undock") return { result: { undocked: true } };
        if (tool === "travel") {
          travelCalls.push(args ?? {});
          return { result: { ok: true } };
        }
        return { result: {} };
      },
      waitForTick: async () => {},
    });
    const cache = makeStatusCache("agent", {
      player: { current_system: "sol", current_poi: "sol_belt", docked_at_base: null },
    });
    const deps = makeDeps("agent", client, cache);

    await flee(deps);

    expect(travelCalls.length).toBeGreaterThan(0);
    const travelCall = travelCalls[travelCalls.length - 1];
    expect(travelCall.target_poi).toBe("station"); // Default to station
  });
});

// ---------------------------------------------------------------------------
// scanAndAttack Phase 4: Enhanced Readiness & Combat Diagnostics
// ---------------------------------------------------------------------------

describe("scanAndAttack Phase 4 enhancements", () => {
  const OUR_AGENTS = new Set(["our-agent"]);

  it("returns not_ready when agent has no weapons equipped", async () => {
    const client = makeClient({
      execute: async () => ({ result: { ok: true } }),
    });
    const cache = makeStatusCache("agent", {
      player: {
        current_system: "sol",
        current_poi: "sol_belt",
        docked_at_base: null,
      },
      ship: {
        hull: 100,
        fuel: 100,
        weapons: [], // No weapons!
        cargo: [],
      },
    });
    const deps = makeDeps("agent", client, cache);

    const result = await scanAndAttack(deps, OUR_AGENTS);

    expect(result.status).toBe("not_ready");
    expect(result.reason).toContain("No weapons");
    expect(result.readiness_details).toBeTruthy();
  });

  it("returns not_ready when hull is critically low (<15%)", async () => {
    const client = makeClient({
      execute: async () => ({ result: { ok: true } }),
    });
    const cache = makeStatusCache("agent", {
      player: {
        current_system: "sol",
        current_poi: "sol_belt",
        docked_at_base: null,
      },
      ship: {
        hull: 10, // Critical!
        fuel: 100,
        weapons: [{ id: "weapon_1", name: "laser" }],
        cargo: [],
      },
      nearby: [{ username: "pirate_player", player_id: "p1", in_combat: false, anonymous: false }],
    });
    const deps = makeDeps("agent", client, cache);

    const result = await scanAndAttack(deps, OUR_AGENTS);

    expect(result.status).toBe("not_ready");
    expect(result.reason).toContain("Hull critical");
    expect(result.readiness_details).toBeTruthy();
  });

  it("returns not_ready when fuel is critically low (<15%)", async () => {
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_nearby") {
          return { result: { nearby: [{ username: "pirate_player", player_id: "p1", in_combat: false, anonymous: false }] } };
        }
        return { result: { ok: true } };
      },
    });
    const cache = makeStatusCache("agent", {
      player: {
        current_system: "sol",
        current_poi: "sol_belt",
        docked_at_base: null,
      },
      ship: {
        hull: 100,
        fuel: 10, // Critical!
        weapons: [{ id: "weapon_1", name: "laser" }],
        cargo: [],
      },
      nearby: [{ username: "pirate_player", player_id: "p1", in_combat: false, anonymous: false }],
    });
    const deps = makeDeps("agent", client, cache);

    const result = await scanAndAttack(deps, OUR_AGENTS);

    expect(result.status).toBe("not_ready");
    expect(result.reason).toContain("Low fuel");
    expect(result.readiness_details).toBeTruthy();
  });

  it("returns battle_init_timeout after BATTLE_INIT_MAX_TICKS attempts with no battle", async () => {
    let getStatusCalls = 0;
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_nearby") {
          return { result: { nearby: [{ username: "pirate_player", player_id: "p1", in_combat: false, anonymous: false }] } };
        }
        if (tool === "attack") {
          return { result: { ok: true } };
        }
        if (tool === "get_battle_status") {
          getStatusCalls++;
          return { error: { code: "not_in_battle" } }; // Battle never starts
        }
        return { result: { ok: true } };
      },
      waitForTick: async () => {},
    });
    const cache = makeStatusCache("agent", {
      player: {
        current_system: "sol",
        current_poi: "sol_belt",
        docked_at_base: null,
      },
      ship: {
        hull: 100,
        fuel: 100,
        weapons: [{ id: "weapon_1", name: "laser" }],
        cargo: [{ item_id: "ammo_standard", quantity: 50 }],
      },
      nearby: [{ username: "pirate_player", player_id: "p1", in_combat: false, anonymous: false }],
    });
    const deps = makeDeps("agent", client, cache);

    const result = await scanAndAttack(deps, OUR_AGENTS);

    expect(result.status).toBe("battle_init_timeout");
    expect(result.attempts).toBe(5); // BATTLE_INIT_MAX_TICKS = 5
    expect(result.reason).toContain("No hostiles scanned after 5 ticks");
    expect(getStatusCalls).toBeGreaterThanOrEqual(5);
  });

  it("logs BATTLE START and BATTLE END events to notes on successful combat", async () => {
    const noteLogs: Array<{ type: string; content: string }> = [];
    let battleTick = 0;

    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_nearby") {
          return { result: { nearby: [{ username: "pirate_player", player_id: "p1", in_combat: false, anonymous: false }] } };
        }
        if (tool === "attack") {
          return { result: { ok: true } };
        }
        if (tool === "get_battle_status") {
          battleTick++;
          if (battleTick === 1) {
            // First call: battle is active
            return { result: { status: "active", hull: 85, stance: "fire", zone: "mid" } };
          }
          // Second call: battle ends in victory
          return { result: { status: "victory", hull: 75, stance: "fire", zone: "mid" } };
        }
        if (tool === "get_wrecks") {
          return { result: { wrecks: [] } };
        }
        return { result: { ok: true } };
      },
      waitForTick: async () => {},
    });
    const cache = makeStatusCache("agent", {
      player: {
        current_system: "sol",
        current_poi: "sol_belt",
        docked_at_base: null,
      },
      ship: {
        hull: 100,
        fuel: 100,
        weapons: [{ id: "weapon_1", name: "laser" }],
        cargo: [{ item_id: "ammo_standard", quantity: 50 }],
      },
      nearby: [{ username: "pirate_player", player_id: "p1", in_combat: false, anonymous: false }],
    });
    const deps = makeDeps("agent", client, cache, {
      upsertNote: (agentName, type, content) => {
        noteLogs.push({ type, content });
      },
    });

    const result = await scanAndAttack(deps, OUR_AGENTS);

    expect(result.status).toBe("victory");

    // Verify BATTLE START and BATTLE END events were logged
    const battleStartLog = noteLogs.find((n) => n.content.includes("BATTLE START"));
    const battleEndLog = noteLogs.find((n) => n.content.includes("BATTLE END"));

    expect(battleStartLog).toBeTruthy();
    expect(battleStartLog?.content).toContain("BATTLE START at sol/sol_belt");
    expect(battleStartLog?.content).toContain("Target: pirate");
    expect(battleStartLog?.content).toContain("Your hull: 100%");

    expect(battleEndLog).toBeTruthy();
    expect(battleEndLog?.content).toContain("BATTLE END - VICTORY");
    expect(battleEndLog?.content).toContain("Final hull: 75%");
  });
});

// ---------------------------------------------------------------------------
// multiSell — fleet sell warning (deconfliction)
// ---------------------------------------------------------------------------

describe("multiSell fleet_sell_warning", () => {
  it("warns second agent when same item was recently sold at same station", async () => {
    const sellLog = new SellLog();

    // Agent A sells iron_ore at sol_station
    sellLog.record("sol_station", {
      agent: "agent-a",
      item_id: "iron_ore",
      quantity: 10,
      timestamp: Date.now() - 30_000, // 30s ago
    });

    // Agent B tries to sell at same station
    const cache = makeStatusCache("agent-b", {
      player: { current_poi: "sol_station", credits: 1000, docked_at_base: "sol_station" },
    });
    const client = makeClient({
      execute: async () => ({ result: { ok: true } }),
    });
    const deps = makeDeps("agent-b", client, cache, { sellLog });

    const result = await multiSell(
      deps,
      [{ item_id: "iron_ore", quantity: 5 }],
      new Set(["analyze_market"]),
    );

    expect(result.status).toBe("completed");
    expect(result.fleet_sell_warning).toBeTruthy();
    expect(String(result.fleet_sell_warning)).toContain("agent-a");
  });

  it("does not warn when no overlapping fleet sells", async () => {
    const sellLog = new SellLog();
    const cache = makeStatusCache("agent-a", {
      player: { current_poi: "sol_station", credits: 1000, docked_at_base: "sol_station" },
    });
    const client = makeClient({
      execute: async () => ({ result: { ok: true } }),
    });
    const deps = makeDeps("agent-a", client, cache, { sellLog });

    const result = await multiSell(
      deps,
      [{ item_id: "iron_ore", quantity: 5 }],
      new Set(["analyze_market"]),
    );

    expect(result.fleet_sell_warning).toBeUndefined();
  });
});
});
