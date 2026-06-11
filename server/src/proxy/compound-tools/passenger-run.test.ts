/**
 * compound-tools/passenger-run.test.ts
 *
 * Tests for the passenger_run compound tool, imported directly from the source
 * module. Mirrors the style of batch-mine.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createDatabase, closeDb } from "../../services/database.js";
import { passengerRun } from "./passenger-run.js";
import type { CompoundToolDeps, GameClientLike } from "./types.js";
import { SellLog } from "../sell-log.js";
import { GalaxyGraph } from "../pathfinder.js";

type StatusEntry = { data: Record<string, unknown>; fetchedAt: number };

function makeClient(execute: GameClientLike["execute"]): GameClientLike {
  return {
    execute,
    waitForTick: async () => {},
    lastArrivalTick: null,
  };
}

function makeStatusCache(agentName: string, data: Record<string, unknown>): Map<string, StatusEntry> {
  const cache = new Map<string, StatusEntry>();
  cache.set(agentName, { data, fetchedAt: Date.now() });
  return cache;
}

function makeDeps(agentName: string, client: GameClientLike, statusCache: Map<string, StatusEntry>): CompoundToolDeps {
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

describe("passenger-run (direct import)", () => {
  beforeEach(() => {
    createDatabase(":memory:");
  });
  afterEach(() => {
    closeDb();
  });

  it("blocks when the ship is not docked", async () => {
    const calls: string[] = [];
    const client = makeClient(async (tool) => {
      calls.push(tool);
      return { result: {} };
    });
    const cache = makeStatusCache("agent", { player: { docked_at_base: null } });
    const result = await passengerRun(makeDeps("agent", client, cache));

    expect(result.error).toBeTruthy();
    expect(String(result.error)).toContain("docked");
    expect(calls).not.toContain("list_station_passengers");
  });

  it("returns no_passengers when none are waiting", async () => {
    const client = makeClient(async (tool) => {
      if (tool === "list_station_passengers") return { result: { passengers: [], station: "sol_central" } };
      return { result: {} };
    });
    const cache = makeStatusCache("agent", { player: { docked_at_base: "sol_central" } });
    const result = await passengerRun(makeDeps("agent", client, cache));

    expect(result.status).toBe("no_passengers");
    expect(result.station).toBe("sol_central");
  });

  it("loads passengers by destination (highest fare first) and reports a route", async () => {
    const loadCalls: string[] = [];
    const client = makeClient(async (tool, args) => {
      if (tool === "list_station_passengers") {
        return {
          result: {
            passengers: [
              { name: "Low", destination: "near_hub", fare: 200, time_remaining: 50 },
              { name: "High", destination: "far_hub", fare: 1500, time_remaining: 30 },
              { name: "High2", destination: "far_hub", fare: 1400, time_remaining: 30 },
            ],
          },
        };
      }
      if (tool === "load_passenger") {
        const dest = String((args as Record<string, unknown>).destination);
        loadCalls.push(dest);
        if (dest === "far_hub") {
          return { result: { destination: dest, loaded: [{ name: "High" }, { name: "High2" }], berths_free: 0 } };
        }
        return { result: { destination: dest, loaded: [{ name: "Low" }], berths_free: 0 } };
      }
      if (tool === "list_passengers") {
        return {
          result: {
            passengers: [
              { name: "High", destination: "far_hub", time_remaining: 30 },
              { name: "High2", destination: "far_hub", time_remaining: 28 },
              { name: "Low", destination: "near_hub", time_remaining: 50 },
            ],
          },
        };
      }
      return { result: {} };
    });
    const cache = makeStatusCache("agent", { player: { docked_at_base: "sol_central" } });
    const result = await passengerRun(makeDeps("agent", client, cache));

    expect(result.status).toBe("completed");
    // highest-fare destination loaded first
    expect(loadCalls[0]).toBe("far_hub");
    expect(result.loaded_count).toBe(3);
    expect(result.aboard_count).toBe(3);

    // Route is ordered by soonest-expiring timer: far_hub (28) before near_hub (50)
    const route = result.route as Array<Record<string, unknown>>;
    expect(route[0].destination).toBe("far_hub");
    expect(route[0].soonest_timer).toBe(28);
    expect(route[0].passengers).toBe(2);
    expect(route[1].destination).toBe("near_hub");

    // Reminder about the can't-sell-with-passengers rule is surfaced.
    expect(String(result.reminder)).toContain("cannot be sold");
  });

  it("stops loading when berths are full", async () => {
    const loadCalls: string[] = [];
    const client = makeClient(async (tool, args) => {
      if (tool === "list_station_passengers") {
        return {
          result: {
            passengers: [
              { name: "A", destination: "dest_a", fare: 900 },
              { name: "B", destination: "dest_b", fare: 800 },
            ],
          },
        };
      }
      if (tool === "load_passenger") {
        const dest = String((args as Record<string, unknown>).destination);
        loadCalls.push(dest);
        if (dest === "dest_a") return { result: { loaded: [{ name: "A" }] } };
        // second destination: no berths left
        return { error: { code: "no_berths", message: "No free berths" } };
      }
      if (tool === "list_passengers") return { result: { passengers: [{ name: "A", destination: "dest_a" }] } };
      return { result: {} };
    });
    const cache = makeStatusCache("agent", { player: { docked_at_base: "sol_central" } });
    const result = await passengerRun(makeDeps("agent", client, cache));

    expect(result.status).toBe("completed");
    expect(result.loaded_count).toBe(1);
    // Both destinations were attempted, but the loop stopped after the berth error.
    expect(loadCalls).toEqual(["dest_a", "dest_b"]);
    const loads = result.loads as Array<Record<string, unknown>>;
    expect(loads[1].error).toBeTruthy();
  });

  it("propagates an error from list_station_passengers", async () => {
    const client = makeClient(async (tool) => {
      if (tool === "list_station_passengers") return { error: { code: "no_terminal", message: "No passenger terminal here" } };
      return { result: {} };
    });
    const cache = makeStatusCache("agent", { player: { docked_at_base: "remote_outpost" } });
    const result = await passengerRun(makeDeps("agent", client, cache));

    expect(result.error).toEqual({ code: "no_terminal", message: "No passenger terminal here" });
  });

  it("uses the v2 spacemolt namespace when the client reports isV2", async () => {
    const seen: Array<{ tool: string; action?: unknown }> = [];
    const client: GameClientLike = {
      execute: async (tool, args) => {
        seen.push({ tool, action: (args as Record<string, unknown> | undefined)?.action });
        const action = (args as Record<string, unknown> | undefined)?.action;
        if (action === "list_station_passengers") return { result: { passengers: [{ name: "A", destination: "x", fare: 100 }] } };
        if (action === "load_passenger") return { result: { loaded: [{ name: "A" }] } };
        if (action === "list_passengers") return { result: { passengers: [{ name: "A", destination: "x" }] } };
        return { result: {} };
      },
      waitForTick: async () => {},
      lastArrivalTick: null,
      isV2: () => true,
    };
    const cache = makeStatusCache("agent", { player: { docked_at_base: "sol_central" } });
    const result = await passengerRun(makeDeps("agent", client, cache));

    expect(result.status).toBe("completed");
    // All game calls went through the "spacemolt" namespace with an action arg.
    expect(seen.every((c) => c.tool === "spacemolt")).toBe(true);
    expect(seen.map((c) => c.action)).toContain("list_station_passengers");
    expect(seen.map((c) => c.action)).toContain("load_passenger");
  });
});
