/**
 * compound-tools/travel-to.test.ts
 *
 * Tests for the travel_to compound tool, imported directly from the source module.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createDatabase, closeDb } from "../../services/database.js";
import { travelTo, resolveCrossSystem, parseWrongSystemTarget } from "./travel-to.js";
import { NAV_COMMAND_TIMEOUT_MS } from "../game-transport.js";
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

  it("returns status:in_transit (not completed) when arrival-wait times out", async () => {
    // Bug: travel-to.ts ignored waitForNavCacheUpdate's return value and unconditionally
    // returned status:"completed". Agent then polled get_status, saw empty location for 6+
    // turns, TransitStuckDetector advised logout/login, mid-transit logout caused SESSION_EXPIRED.
    // Fix: check `updated` — on false, return status:"in_transit" with a wait-and-poll message.
    const cache = makeStatusCache("agent", {
      // current_system stays "sol" throughout — cache never updates (ship still in hyperspace)
      player: { current_system: "sol", current_poi: "sol_belt", docked_at_base: null },
    });

    // Travel response includes arrival_tick, making isPending=true
    const client = makeClient({
      execute: async () => ({
        result: { pending: true, arrival_tick: 999, status: "pending" },
      }),
      // waitForTick is a no-op — cache never changes, simulating a long-jump timeout
      waitForTick: async () => {},
    });
    const deps = makeDeps("agent", client, cache);

    const result = await travelTo(deps, "gsc_0041", identityResolver, false);

    // Must NOT claim completion — ship hasn't arrived
    expect(result.status).toBe("in_transit");
    // Message must discourage logout/login (the action that triggered SESSION_EXPIRED)
    expect(String(result.message)).toContain("Do NOT call logout/login");
    // Must include the destination so the agent knows where it's headed
    expect(result.destination).toBe("gsc_0041");
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

describe("travel-to fuzzy POI matching", () => {
  beforeEach(() => {
    createDatabase(":memory:");
    systemPoiCache.clear();
  });

  afterEach(() => {
    closeDb();
    systemPoiCache.clear();
  });

  it("auto-resolves single substring match on invalid_poi error", async () => {
    systemPoiCache.set("krynn", [
      { id: "krynn_war_citadel_station", name: "War Citadel Station", type: "station" },
      { id: "krynn_mining_belt", name: "Krynn Belt", type: "asteroid_belt" },
    ]);
    const travelArgs: Array<Record<string, unknown>> = [];
    const cache = makeStatusCache("agent", {
      player: {
        current_system: "krynn",
        current_poi: "krynn_mining_belt",
        docked_at_base: null,
      },
    });
    let callCount = 0;
    const client = makeClient({
      execute: async (tool, args) => {
        if (tool === "travel") {
          travelArgs.push(args ?? {});
          callCount++;
          if (callCount === 1) {
            // First call fails with invalid_poi
            return { error: { message: "invalid_poi: war_citadel" } };
          }
          // Second call succeeds
          return { result: { ok: true } };
        }
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, cache);

    const result = await travelTo(deps, "war_citadel", identityResolver, false);

    expect(result.status).toBe("completed");
    expect(travelArgs).toHaveLength(2);
    expect(travelArgs[1].target_poi).toBe("krynn_war_citadel_station");
  });

  it("returns ambiguous error when multiple POIs match", async () => {
    systemPoiCache.set("krynn", [
      { id: "krynn_citadel_alpha", name: "Citadel Alpha", type: "station" },
      { id: "krynn_citadel_beta", name: "Citadel Beta", type: "station" },
    ]);
    const cache = makeStatusCache("agent", {
      player: {
        current_system: "krynn",
        current_poi: "krynn_belt",
        docked_at_base: null,
      },
    });
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "travel") {
          return { error: { message: "invalid_poi: citadel" } };
        }
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, cache);

    const result = await travelTo(deps, "citadel", identityResolver, false);

    expect(result.status).toBe("error");
    expect(result.error).toBe("travel_failed");
    expect(String(result.message)).toContain("krynn_citadel_alpha");
    expect(String(result.message)).toContain("krynn_citadel_beta");
  });

  it("returns original error when no fuzzy match found", async () => {
    systemPoiCache.set("krynn", [
      { id: "krynn_mining_belt", name: "Krynn Belt", type: "asteroid_belt" },
    ]);
    const cache = makeStatusCache("agent", {
      player: {
        current_system: "krynn",
        current_poi: "krynn_mining_belt",
        docked_at_base: null,
      },
    });
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "travel") {
          return { error: { message: "invalid_poi: nowhere" } };
        }
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, cache);

    const result = await travelTo(deps, "nowhere", identityResolver, false);

    expect(result.status).toBe("error");
    expect(result.error).toBe("travel_failed");
    expect(String(result.message)).toContain("invalid_poi: nowhere");
  });

  it("fetches get_system when cache is empty before fuzzy matching", async () => {
    systemPoiCache.clear();
    const executedTools: string[] = [];
    const cache = makeStatusCache("agent", {
      player: {
        current_system: "krynn",
        current_poi: "krynn_belt",
        docked_at_base: null,
      },
    });
    let travelCallCount = 0;
    const client = makeClient({
      execute: async (tool, args) => {
        executedTools.push(tool);
        if (tool === "get_system") {
          // Populate cache via cacheSystemPois
          const { cacheSystemPois: cache2 } = await import("../poi-resolver.js");
          cache2({
            id: "krynn",
            name: "Krynn",
            pois: [{ id: "krynn_war_citadel_station", name: "War Citadel Station", type: "station" }],
          });
          return { result: { id: "krynn", name: "Krynn", pois: [{ id: "krynn_war_citadel_station", name: "War Citadel Station", type: "station" }] } };
        }
        if (tool === "travel") {
          travelCallCount++;
          if (travelCallCount === 1) return { error: { message: "invalid_poi: war_citadel" } };
          return { result: { ok: true } };
        }
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, cache);

    const result = await travelTo(deps, "war_citadel", identityResolver, false);

    expect(result.status).toBe("completed");
    expect(executedTools).toContain("get_system");
  });

  it("does not fuzzy-match on non-poi errors (e.g. action_pending)", async () => {
    const travelCallCount = { n: 0 };
    const cache = makeStatusCache("agent", {
      player: { current_system: "krynn", current_poi: "krynn_belt", docked_at_base: null },
    });
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "travel") {
          travelCallCount.n++;
          return { error: { message: "action_pending" } };
        }
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, cache);

    const result = await travelTo(deps, "krynn_belt", identityResolver, false);

    // Should fail without retrying via fuzzy
    expect(result.status).toBe("error");
    expect(travelCallCount.n).toBe(1);
  });

  it("handles 'Unknown destination' error message (case-insensitive)", async () => {
    systemPoiCache.set("sol", [
      { id: "sol_main_station", name: "Sol Main Station", type: "station" },
    ]);
    const cache = makeStatusCache("agent", {
      player: { current_system: "sol", current_poi: "sol_belt", docked_at_base: null },
    });
    let travelCallCount = 0;
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "travel") {
          travelCallCount++;
          if (travelCallCount === 1) return { error: { message: "Unknown destination: main_station" } };
          return { result: { ok: true } };
        }
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, cache);

    const result = await travelTo(deps, "main_station", identityResolver, false);

    expect(result.status).toBe("completed");
    expect(travelCallCount).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Cross-system resolution (Task #14) — `go sirius` from Sol must route to
  // Sirius via jumpRoute, not fail with "Unknown destination". The PrayerLang
  // docs explicitly promise this, and 80% of soak3 prayers failed because the
  // resolver only looked at local-system POIs.
  // -------------------------------------------------------------------------

  describe("cross-system fuzzy resolution", () => {
    function makeGalaxyGraphWithSystems(systems: Array<{ id: string; name: string; connections?: string[] }>): GalaxyGraph {
      const g = new GalaxyGraph();
      for (const s of systems) g.addSystem(s.id, s.name);
      for (const s of systems) {
        for (const c of s.connections ?? []) g.addEdge(s.id, c);
      }
      return g;
    }

    it("resolveCrossSystem: matches an exact system name", () => {
      const g = makeGalaxyGraphWithSystems([
        { id: "sol", name: "Sol", connections: ["sirius"] },
        { id: "sirius", name: "Sirius" },
      ]);
      const r = resolveCrossSystem("sirius", g, "sol");
      expect(r.kind).toBe("route");
      if (r.kind === "route") {
        expect(r.finalSystemId).toBe("sirius");
        expect(r.systemIds).toEqual(["sirius"]);
      }
    });

    it("resolveCrossSystem: matches a partial system name", () => {
      const g = makeGalaxyGraphWithSystems([
        { id: "sol", name: "Sol", connections: ["sirius_observatory"] },
        { id: "sirius_observatory", name: "Sirius Observatory" },
      ]);
      // The agent typed "sirius" — only one system contains that substring.
      const r = resolveCrossSystem("sirius", g, "sol");
      expect(r.kind).toBe("route");
      if (r.kind === "route") {
        expect(r.finalSystemId).toBe("sirius_observatory");
      }
    });

    it("resolveCrossSystem: ambiguous match (multiple systems contain 'sirius') errors clearly", () => {
      const g = makeGalaxyGraphWithSystems([
        { id: "sol", name: "Sol" },
        { id: "sirius_alpha", name: "Sirius Alpha" },
        { id: "sirius_beta", name: "Sirius Beta" },
      ]);
      const r = resolveCrossSystem("sirius", g, "sol");
      expect(r.kind).toBe("ambiguous");
      if (r.kind === "ambiguous") {
        expect(r.matches.length).toBe(2);
        expect(r.matches).toContain("sirius_alpha");
        expect(r.matches).toContain("sirius_beta");
      }
    });

    it("resolveCrossSystem: no match returns no_match (caller falls through to local POI travel)", () => {
      const g = makeGalaxyGraphWithSystems([
        { id: "sol", name: "Sol" },
      ]);
      const r = resolveCrossSystem("not_a_real_system", g, "sol");
      expect(r.kind).toBe("no_match");
    });

    it("resolveCrossSystem: empty galaxy graph returns noop (don't break travel_to flow)", () => {
      const g = new GalaxyGraph();
      const r = resolveCrossSystem("sirius", g, "sol");
      expect(r.kind).toBe("noop");
    });

    it("resolveCrossSystem: exact match to current system returns noop (already there)", () => {
      const g = makeGalaxyGraphWithSystems([{ id: "sol", name: "Sol" }]);
      const r = resolveCrossSystem("sol", g, "sol");
      expect(r.kind).toBe("noop");
    });

    it("travelTo: returns ambiguous_destination error when destination matches multiple systems", async () => {
      const cache = makeStatusCache("agent", {
        player: { current_system: "sol", current_poi: "sol_belt", docked_at_base: null },
      });
      // POI cache empty — local resolution will fail and we'll proceed to cross-system.
      const client = makeClient({
        execute: async () => ({ result: {} }),
      });
      const deps = makeDeps("agent", client, cache);
      // Replace galaxy graph with one that has ambiguous matches
      deps.galaxyGraph = (() => {
        const g = new GalaxyGraph();
        g.addSystem("sol", "Sol");
        g.addSystem("sirius_alpha", "Sirius Alpha");
        g.addSystem("sirius_beta", "Sirius Beta");
        return g;
      })();

      const result = await travelTo(deps, "sirius", identityResolver, false);
      expect(result.status).toBe("error");
      expect(result.error).toBe("ambiguous_destination");
      expect(String(result.message)).toContain("sirius_alpha");
      expect(String(result.message)).toContain("sirius_beta");
    });

    it("travelTo: cross-system fall-through is a noop when galaxyGraph is empty", async () => {
      // Sanity: when we have no galaxy data, cross-system path doesn't run, and
      // travel_to behaves exactly like the legacy code path (call travel + fail).
      const cache = makeStatusCache("agent", {
        player: { current_system: "sol", current_poi: "sol_belt", docked_at_base: null },
      });
      let travelCalls = 0;
      const client = makeClient({
        execute: async (tool) => {
          if (tool === "travel") {
            travelCalls++;
            return { error: { message: "Unknown destination: sirius" } };
          }
          return { result: {} };
        },
      });
      const deps = makeDeps("agent", client, cache);
      // empty galaxy graph
      const result = await travelTo(deps, "sirius", identityResolver, false);
      expect(result.status).toBe("error");
      expect(travelCalls).toBe(1); // travel was attempted; cross-system path was a noop
    });
  });

  // -------------------------------------------------------------------------
  // Nav error-code handling (v0.341.1 / v0.345.1)
  // -------------------------------------------------------------------------
  describe("nav error codes", () => {
    function makeGalaxyGraphWithSystems(systems: Array<{ id: string; name: string; connections?: string[] }>): GalaxyGraph {
      const g = new GalaxyGraph();
      for (const s of systems) g.addSystem(s.id, s.name);
      for (const s of systems) {
        for (const c of s.connections ?? []) g.addEdge(s.id, c);
      }
      return g;
    }

    it("wrong_system: auto-jumps to the named system then retries travel (v0.345.1)", async () => {
      const cache = makeStatusCache("agent", {
        player: { current_system: "sol", current_poi: "sol_station", docked_at_base: null },
      });
      let travelCalls = 0;
      let jumpCalls = 0;
      const client = makeClient({
        execute: async (tool, args) => {
          const action = (args as Record<string, unknown> | undefined)?.action;
          if (tool === "travel") {
            travelCalls++;
            if (travelCalls === 1) {
              return { error: { code: "wrong_system", message: "POI poi_0050_002 is in system sirius, but you are in sol" } };
            }
            return { result: { ok: true } };
          }
          if (tool === "jump" || action === "jump") {
            jumpCalls++;
            // Simulate arrival by advancing the cache to sirius.
            cache.set("agent", { data: { player: { current_system: "sirius", current_poi: "sirius_gate", docked_at_base: null } }, fetchedAt: Date.now() });
            return { result: { status: "completed", location_after: { system: "sirius" } } };
          }
          return { result: {} };
        },
      });
      const deps = makeDeps("agent", client, cache);
      deps.galaxyGraph = makeGalaxyGraphWithSystems([
        { id: "sol", name: "Sol", connections: ["sirius"] },
        { id: "sirius", name: "Sirius" },
      ]);

      // Use a raw poi_* id so the pre-travel cross-system resolver is skipped and
      // the wrong_system error path is exercised.
      const result = await travelTo(deps, "poi_0050_002", identityResolver, false);

      expect(jumpCalls).toBeGreaterThanOrEqual(1);
      expect(travelCalls).toBe(2); // original + retry after jump
      expect(result.status).toBe("completed");
    });

    it("fleet_moved: returns a clean actionable error (v0.341.1)", async () => {
      const cache = makeStatusCache("agent", {
        player: { current_system: "sol", current_poi: "sol_station", docked_at_base: null },
      });
      const client = makeClient({
        execute: async (tool) => {
          if (tool === "travel") return { error: { code: "fleet_moved", message: "fleet leader moved" } };
          return { result: {} };
        },
      });
      const deps = makeDeps("agent", client, cache);
      const result = await travelTo(deps, "poi_0041_002", identityResolver, false);
      expect(result.status).toBe("error");
      expect(result.error).toBe("fleet_moved");
      expect(String(result.message)).toContain("get_status");
    });

    it("in_transit error: returns a clean actionable error, distinct from internal flag (v0.341.1)", async () => {
      const cache = makeStatusCache("agent", {
        player: { current_system: "sol", current_poi: "sol_station", docked_at_base: null },
      });
      const client = makeClient({
        execute: async (tool) => {
          if (tool === "travel") return { error: { code: "in_transit", message: "ship is in transit" } };
          return { result: {} };
        },
      });
      const deps = makeDeps("agent", client, cache);
      const result = await travelTo(deps, "poi_0041_002", identityResolver, false);
      expect(result.status).toBe("error");
      expect(result.error).toBe("in_transit");
      expect(String(result.message)).toContain("Do NOT call logout/login");
    });

    it("client timeout: degrades to in_transit rather than travel_failed (v0.341.1)", async () => {
      const cache = makeStatusCache("agent", {
        player: { current_system: "sol", current_poi: "sol_station", docked_at_base: null },
      });
      const client = makeClient({
        execute: async (tool) => {
          if (tool === "travel") return { error: { code: "timeout", message: "Game server did not respond to spacemolt within 600000ms" } };
          return { result: {} };
        },
      });
      const deps = makeDeps("agent", client, cache);
      const result = await travelTo(deps, "poi_0041_002", identityResolver, false);
      expect(result.status).toBe("in_transit");
      expect(result.destination).toBe("poi_0041_002");
      expect(String(result.message)).toContain("Do NOT call logout/login");
    });

    it("passes the extended nav timeout to the travel execute call", async () => {
      const cache = makeStatusCache("agent", {
        player: { current_system: "sol", current_poi: "sol_station", docked_at_base: null },
      });
      let travelOpts: unknown;
      const client = makeClient({
        execute: async (tool, _args, opts) => {
          if (tool === "travel") travelOpts = opts;
          return { result: { ok: true } };
        },
      });
      const deps = makeDeps("agent", client, cache);
      await travelTo(deps, "poi_0041_002", identityResolver, false);
      expect((travelOpts as { timeoutMs?: number } | undefined)?.timeoutMs).toBe(NAV_COMMAND_TIMEOUT_MS);
    });
  });

  describe("parseWrongSystemTarget", () => {
    it("parses the destination system from the v0.345.1 message", () => {
      expect(parseWrongSystemTarget("POI poi_0050_002 is in system sirius, but you are in sol")).toBe("sirius");
    });
    it("parses the 'in <system>' fallback form", () => {
      expect(parseWrongSystemTarget("That POI is in alrakis_prime")).toBe("alrakis_prime");
    });
    it("returns null when no system can be parsed", () => {
      expect(parseWrongSystemTarget("some unrelated error")).toBeNull();
    });
  });
});
