import { describe, expect, test } from "bun:test";
import { evalPredicate } from "./predicates.js";
import type { AnalyzedPredicate, ExecState, ExecutorDeps } from "./types.js";
import type { GameClientLike } from "../compound-tools/index.js";

function makeClient(): GameClientLike {
  return {
    execute: async () => ({ result: {} }),
    waitForTick: async () => {},
    lastArrivalTick: null,
  };
}

function makeState(): ExecState {
  return {
    stepsExecuted: 0,
    startedAt: Date.now(),
    transientRetriesUsed: 0,
    log: [],
    cargoBaseline: new Map(),
    haltRequested: false,
    interrupt: null,
  };
}

function makeDeps(data: Record<string, unknown>): ExecutorDeps {
  return {
    agentName: "test-agent",
    client: makeClient(),
    compoundActions: {},
    statusCache: new Map([["test-agent", { fetchedAt: Date.now(), data }]]),
    handlePassthrough: async () => ({}),
    maxSteps: 10,
    maxLoopIters: 10,
    maxWallClockMs: 60_000,
  };
}

const loc = { line: 1, col: 1 };

function stashedPred(item: string, op: AnalyzedPredicate["op"], rhs: number): AnalyzedPredicate {
  return {
    metric: "STASHED",
    args: [{ kind: "static", value: item }],
    op,
    rhs,
    loc,
  };
}

function stashPred(poi: string, item: string, op: AnalyzedPredicate["op"], rhs: number): AnalyzedPredicate {
  return {
    metric: "STASH",
    args: [{ kind: "static", value: poi }, { kind: "static", value: item }],
    op,
    rhs,
    loc,
  };
}

describe("STASHED predicate", () => {
  test("returns total across all personal storage POIs", async () => {
    const data = {
      player: { faction_id: "fed" },
      personal_storage: [
        { item_id: "iron_ore", quantity: 5, poi_id: "sol_station" },
        { item_id: "iron_ore", quantity: 3, poi_id: "vega_outpost" },
        { item_id: "copper_ore", quantity: 10, poi_id: "sol_station" },
      ],
    };
    const deps = makeDeps(data);
    const state = makeState();

    expect(await evalPredicate(stashedPred("iron_ore", ">=", 8), state, deps)).toBe(true);
    expect(await evalPredicate(stashedPred("iron_ore", ">", 8), state, deps)).toBe(false);
    expect(await evalPredicate(stashedPred("iron_ore", ">", 0), state, deps)).toBe(true);
  });

  test("returns 0 for absent items", async () => {
    const deps = makeDeps({
      personal_storage: [{ item_id: "iron_ore", quantity: 5, poi_id: "sol_station" }],
    });
    const state = makeState();
    expect(await evalPredicate(stashedPred("titanium_ore", "==", 0), state, deps)).toBe(true);
    expect(await evalPredicate(stashedPred("titanium_ore", ">", 0), state, deps)).toBe(false);
  });

  test("returns 0 when storage isn't cached at all", async () => {
    const deps = makeDeps({ player: { credits: 100 }, ship: { fuel: 50, cargo: [] } });
    const state = makeState();
    expect(await evalPredicate(stashedPred("iron_ore", "==", 0), state, deps)).toBe(true);
    expect(await evalPredicate(stashedPred("iron_ore", ">", 0), state, deps)).toBe(false);
  });

  test("supports legacy `storage` and `qty` field aliases", async () => {
    const deps = makeDeps({
      storage: [{ id: "iron_ore", qty: 7, poi: "sol_station" }],
    });
    const state = makeState();
    expect(await evalPredicate(stashedPred("iron_ore", "==", 7), state, deps)).toBe(true);
  });
});

describe("MISSION_ACTIVE predicate", () => {
  function missionActivePred(op: AnalyzedPredicate["op"], rhs: number): AnalyzedPredicate {
    return { metric: "MISSION_ACTIVE", args: [], op, rhs, loc };
  }

  test("returns count from active_missions array", async () => {
    const deps = makeDeps({
      active_missions: [
        { id: "m1", title: "Supply Run" },
        { id: "m2", title: "Patrol" },
      ],
    });
    const state = makeState();
    expect(await evalPredicate(missionActivePred("==", 2), state, deps)).toBe(true);
    expect(await evalPredicate(missionActivePred(">", 0), state, deps)).toBe(true);
    expect(await evalPredicate(missionActivePred("==", 0), state, deps)).toBe(false);
  });

  test("returns count from _active_missions_count integer field", async () => {
    const deps = makeDeps({ _active_missions_count: 3 });
    const state = makeState();
    expect(await evalPredicate(missionActivePred("==", 3), state, deps)).toBe(true);
    expect(await evalPredicate(missionActivePred(">", 0), state, deps)).toBe(true);
  });

  test("returns 0 when no mission data in cache", async () => {
    const deps = makeDeps({ player: { credits: 100 }, ship: { fuel: 50, cargo: [] } });
    const state = makeState();
    expect(await evalPredicate(missionActivePred("==", 0), state, deps)).toBe(true);
    expect(await evalPredicate(missionActivePred(">", 0), state, deps)).toBe(false);
  });

  test("returns 0 for empty active_missions array", async () => {
    const deps = makeDeps({ active_missions: [] });
    const state = makeState();
    expect(await evalPredicate(missionActivePred("==", 0), state, deps)).toBe(true);
  });

  test("prefers active_missions array over _active_missions_count", async () => {
    // Array wins over synthetic count field when both present
    const deps = makeDeps({
      active_missions: [{ id: "m1" }],
      _active_missions_count: 99,
    });
    const state = makeState();
    expect(await evalPredicate(missionActivePred("==", 1), state, deps)).toBe(true);
  });
});

describe("STASH predicate", () => {
  test("matches item only at the specified POI", async () => {
    const data = {
      player: { faction_id: "fed" },
      personal_storage: [
        { item_id: "iron_ore", quantity: 5, poi_id: "sol_station" },
        { item_id: "iron_ore", quantity: 3, poi_id: "vega_outpost" },
      ],
    };
    const deps = makeDeps(data);
    const state = makeState();

    expect(await evalPredicate(stashPred("sol_station", "iron_ore", "==", 5), state, deps)).toBe(true);
    expect(await evalPredicate(stashPred("vega_outpost", "iron_ore", "==", 3), state, deps)).toBe(true);
    expect(await evalPredicate(stashPred("kepler_base", "iron_ore", "==", 0), state, deps)).toBe(true);
  });

  test("includes faction storage owned by the agent's faction", async () => {
    const data = {
      player: { faction_id: "fed" },
      personal_storage: [{ item_id: "iron_ore", quantity: 2, poi_id: "sol_station" }],
      faction_storage: [
        { item_id: "iron_ore", quantity: 100, poi_id: "sol_station", faction_id: "fed" },
        { item_id: "iron_ore", quantity: 999, poi_id: "sol_station", faction_id: "klingon" },
      ],
    };
    const deps = makeDeps(data);
    const state = makeState();

    // 2 personal + 100 own faction; klingon entry excluded
    expect(await evalPredicate(stashPred("sol_station", "iron_ore", "==", 102), state, deps)).toBe(true);
  });

  test("includes faction storage when no faction_id is recorded on the entry", async () => {
    const data = {
      player: { faction_id: "fed" },
      faction_storage: [{ item_id: "iron_ore", quantity: 10, poi_id: "sol_station" }],
    };
    const deps = makeDeps(data);
    const state = makeState();
    expect(await evalPredicate(stashPred("sol_station", "iron_ore", "==", 10), state, deps)).toBe(true);
  });

  test("returns 0 for the wrong POI", async () => {
    const data = {
      personal_storage: [{ item_id: "iron_ore", quantity: 5, poi_id: "sol_station" }],
    };
    const deps = makeDeps(data);
    const state = makeState();
    expect(await evalPredicate(stashPred("vega_outpost", "iron_ore", "==", 0), state, deps)).toBe(true);
    expect(await evalPredicate(stashPred("vega_outpost", "iron_ore", ">", 0), state, deps)).toBe(false);
  });
});
