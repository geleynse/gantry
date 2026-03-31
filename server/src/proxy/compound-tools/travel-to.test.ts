/**
 * compound-tools/travel-to.test.ts
 *
 * Tests for the travel_to compound tool, imported directly from the source module.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createDatabase, closeDb } from "../../services/database.js";
import { travelTo } from "./travel-to.js";
import { systemPoiCache } from "../poi-resolver.js";
import type { CompoundToolDeps, GameClientLike } from "./types.js";
import { SellLog } from "../sell-log.js";
import { GalaxyGraph } from "../pathfinder.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type StatusEntry = { data: Record<string, unknown>; fetchedAt: number };

function makeClient(
  overrides: Partial<{
    execute: GameClientLike["execute"];
    waitForTick: GameClientLike["waitForTick"];
  }> = {},
): GameClientLike {
  return {
    execute: overrides.execute ?? (async () => ({ result: { ok: true } })),
    waitForTick: overrides.waitForTick ?? (async () => {}),
    lastArrivalTick: null,
  };
}

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
): CompoundToolDeps {
  return {
    client,
    agentName,
    statusCache,
    battleCache: new Map(),
    sellLog: new SellLog(),
    galaxyGraph: new GalaxyGraph(),
    persistBattleState: () => {},
    upsertNote: () => {},
  };
}

/** Simple identity resolver — passes the destination through unchanged. */
const identityResolver = (_agent: string, name: string, _cache: unknown) => name;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("travel-to (direct import)", () => {
  beforeEach(() => {
    createDatabase(":memory:");
    systemPoiCache.clear();
  });

  afterEach(() => {
    closeDb();
    systemPoiCache.clear();
  });

  it("returns completed status with steps after a successful travel", async () => {
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
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, cache);

    const result = await travelTo(deps, "sol_belt", identityResolver, false);

    expect(result.status).toBe("completed");
    const steps = result.steps as Array<{ action: string }>;
    expect(steps.some((s) => s.action === "travel")).toBe(true);
  });

  it("returns error status when travel call fails", async () => {
    const cache = makeStatusCache("agent", {
      player: { current_system: "sol", current_poi: "sol_belt", docked_at_base: null },
    });
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "travel") return { error: { message: "destination_unreachable" } };
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, cache);

    const result = await travelTo(deps, "unknown_dest", identityResolver, false);

    expect(result.status).toBe("error");
    expect(result.error).toBe("travel_failed");
    expect(String(result.message)).toContain("Travel execution failed");
  });

  it("includes travel step in steps array", async () => {
    const cache = makeStatusCache("agent", {
      player: { current_system: "sol", current_poi: "sol_belt", docked_at_base: null },
    });
    const client = makeClient({
      execute: async () => ({ result: { ok: true } }),
    });
    const deps = makeDeps("agent", client, cache);

    const result = await travelTo(deps, "sol_station", identityResolver, false);

    const steps = result.steps as Array<{ action: string; result: unknown }>;
    const travelStep = steps.find((s) => s.action === "travel");
    expect(travelStep).toBeTruthy();
    expect(travelStep?.result).toEqual({ ok: true });
  });

  it("calls dock when should_dock is explicitly true", async () => {
    const executedTools: string[] = [];
    const cache = makeStatusCache("agent", {
      player: { current_system: "sol", current_poi: "sol_belt", docked_at_base: "sol_station" },
    });
    const client = makeClient({
      execute: async (tool) => {
        executedTools.push(tool);
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, cache);

    await travelTo(deps, "sol_belt", identityResolver, true);

    expect(executedTools).toContain("dock");
  });

  it("does not call dock when should_dock is false", async () => {
    const executedTools: string[] = [];
    const client = makeClient({
      execute: async (tool) => {
        executedTools.push(tool);
        return { result: {} };
      },
    });
    const cache = makeStatusCache("agent", {
      player: { current_system: "sol", current_poi: "sol_belt", docked_at_base: null },
    });
    const deps = makeDeps("agent", client, cache);

    await travelTo(deps, "sol_belt", identityResolver, false);

    expect(executedTools).not.toContain("dock");
  });

  it("auto-docks when destination contains 'station' (no explicit override)", async () => {
    const executedTools: string[] = [];
    const cache = makeStatusCache("agent", {
      player: { current_system: "sol", current_poi: "sol_station", docked_at_base: "sol_station" },
    });
    const client = makeClient({
      execute: async (tool) => {
        executedTools.push(tool);
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, cache);

    await travelTo(deps, "sol_station", identityResolver);

    expect(executedTools).toContain("dock");
  });

  it("auto-docks when destination contains 'core'", async () => {
    const executedTools: string[] = [];
    const cache = makeStatusCache("agent", {
      player: { current_system: "sol", current_poi: "sol_core", docked_at_base: "sol_core" },
    });
    const client = makeClient({
      execute: async (tool) => {
        executedTools.push(tool);
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, cache);

    await travelTo(deps, "sol_core", identityResolver);

    expect(executedTools).toContain("dock");
  });

  it("sends the resolved POI ID to the travel call when resolver maps the name", async () => {
    const travelArgs: Array<Record<string, unknown>> = [];
    const cache = makeStatusCache("agent", {
      player: { current_system: "sol", current_poi: "poi_0041_002", docked_at_base: null },
    });
    const client = makeClient({
      execute: async (tool, args) => {
        if (tool === "travel") travelArgs.push(args ?? {});
        return { result: {} };
      },
    });
    const resolver = (_agent: string, _name: string, _cache: unknown) => "poi_0041_002";
    const deps = makeDeps("agent", client, cache);

    await travelTo(deps, "Sol Station", resolver, false);

    expect(travelArgs.length).toBeGreaterThan(0);
    expect(travelArgs[0].target_poi).toBe("poi_0041_002");
  });

  it("returns location_after from the status cache", async () => {
    const cache = makeStatusCache("agent", {
      player: {
        current_system: "alpha",
        current_poi: "alpha_belt",
        docked_at_base: null,
      },
    });
    const client = makeClient({
      execute: async () => ({ result: {} }),
    });
    const deps = makeDeps("agent", client, cache);

    const result = await travelTo(deps, "alpha_belt", identityResolver, false);

    expect(result.location_after).toMatchObject({
      system: "alpha",
      poi: "alpha_belt",
      docked_at_base: null,
    });
  });

  it("returns error when 'home' destination is used but home_poi is not set", async () => {
    const cache = makeStatusCache("agent", {
      player: { current_system: "sol", current_poi: "sol_belt", docked_at_base: null },
      // home_poi is not set
    });
    const client = makeClient();
    const deps = makeDeps("agent", client, cache);

    const result = await travelTo(deps, "home", identityResolver, false);

    expect(result.status).toBe("error");
    expect(result.error).toBe("home_not_set");
  });

  it("routes 'home' destination to home_poi when it is set", async () => {
    const travelArgs: Array<Record<string, unknown>> = [];
    const cache = makeStatusCache("agent", {
      player: {
        current_system: "sol",
        current_poi: "sol_belt",
        docked_at_base: null,
        home_poi: "poi_home_001",
        home_system: "sol",
      },
    });
    const client = makeClient({
      execute: async (tool, args) => {
        if (tool === "travel") travelArgs.push(args ?? {});
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, cache);

    await travelTo(deps, "home", identityResolver, false);

    expect(travelArgs.length).toBeGreaterThan(0);
    expect(travelArgs[0].target_poi).toBe("poi_home_001");
  });

  it("auto-fetches get_system to populate POI cache when destination is an unknown name", async () => {
    systemPoiCache.clear();
    const executedTools: string[] = [];
    const cache = makeStatusCache("agent", {
      player: { current_system: "sys_0041", current_poi: "poi_0041_001", docked_at_base: null },
    });
    const client = makeClient({
      execute: async (tool, args) => {
        executedTools.push(tool);
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

    // Use the real resolvePoiId so auto-fetch logic actually matters
    const { resolvePoiId } = await import("../poi-resolver.js");
    const result = await travelTo(deps, "sol_station", resolvePoiId, false);

    expect(result.status).toBe("completed");
    expect(executedTools).toContain("get_system");
  });

  it("does not call get_system when destination already starts with 'poi_'", async () => {
    const executedTools: string[] = [];
    const cache = makeStatusCache("agent", {
      player: { current_system: "sys_0041", current_poi: "poi_0041_001", docked_at_base: null },
    });
    const client = makeClient({
      execute: async (tool) => {
        executedTools.push(tool);
        return { result: { ok: true } };
      },
    });
    const deps = makeDeps("agent", client, cache);

    await travelTo(deps, "poi_0041_002", identityResolver, false);

    expect(executedTools).not.toContain("get_system");
  });

  it("waits two ticks after travel completes", async () => {
    let tickCount = 0;
    const cache = makeStatusCache("agent", {
      player: { current_system: "sol", current_poi: "sol_belt", docked_at_base: null },
    });
    const client = makeClient({
      execute: async () => ({ result: {} }),
      waitForTick: async () => {
        tickCount++;
      },
    });
    const deps = makeDeps("agent", client, cache);

    await travelTo(deps, "sol_belt", identityResolver, false);

    // At minimum 2 ticks after travel
    expect(tickCount).toBeGreaterThanOrEqual(2);
  });

  it("includes dock warning when dock succeeds but docked_at_base remains null after retry", async () => {
    // Cache never updates to show docked
    const cache = makeStatusCache("agent", {
      player: { current_system: "sol", current_poi: "sol_station", docked_at_base: null },
    });
    const client = makeClient({
      execute: async () => ({ result: {} }),
    });
    const deps = makeDeps("agent", client, cache);

    const result = await travelTo(deps, "sol_station", identityResolver);

    expect(result.warning).toBeTruthy();
    expect(String(result.warning)).toContain("NOT docked");
  });

  it("includes dock step in steps array when docking is attempted", async () => {
    const cache = makeStatusCache("agent", {
      player: { current_system: "sol", current_poi: "sol_station", docked_at_base: "sol_station" },
    });
    const client = makeClient({
      execute: async () => ({ result: { docked: true } }),
    });
    const deps = makeDeps("agent", client, cache);

    const result = await travelTo(deps, "sol_station", identityResolver);

    const steps = result.steps as Array<{ action: string }>;
    expect(steps.some((s) => s.action === "dock")).toBe(true);
  });
});
