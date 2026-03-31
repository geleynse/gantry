/**
 * Tests for the state hints system — proactive suggestions based on game state.
 * Uses in-memory state (Maps) — no database or network access.
 */

import { describe, it, expect } from "bun:test";
import {
  StateHintEngine,
  BUILT_IN_HINTS,
  createStateHintInjection,
  type StateHint,
} from "./state-hints.js";
import { InjectionRegistry } from "./injection-registry.js";
import { MetricsWindow } from "./instability-metrics.js";
import type { PipelineContext } from "./pipeline.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStatusData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    player: {
      username: "test-agent",
      credits: 5000,
      current_system: "SOL-001",
      current_poi: "Station Alpha",
      docked_at_base: true,
    },
    ship: {
      fuel: 80,
      max_fuel: 100,
      hull: 90,
      max_hull: 100,
      cargo_used: 5,
      cargo_capacity: 20,
    },
    ...overrides,
  };
}

function makeCache(agents: Record<string, Record<string, unknown>>): Map<string, { data: Record<string, unknown>; fetchedAt: number }> {
  const cache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
  for (const [name, data] of Object.entries(agents)) {
    cache.set(name, { data, fetchedAt: Date.now() });
  }
  return cache;
}

// ---------------------------------------------------------------------------
// StateHintEngine basics
// ---------------------------------------------------------------------------

describe("StateHintEngine", () => {
  it("returns null on non-Nth calls (frequency limiting)", () => {
    const hint: StateHint = {
      id: "always",
      category: "economy",
      condition: () => true,
      hint: "Always",
    };
    const engine = new StateHintEngine([hint]);
    const cache = makeCache({ alpha: makeStatusData() });

    // Call 1: not 3rd → null
    expect(engine.evaluate(cache, "alpha")).toBeNull();
    // Call 2: not 3rd → null
    expect(engine.evaluate(cache, "alpha")).toBeNull();
    // Call 3: 3rd → fires
    expect(engine.evaluate(cache, "alpha")).toEqual(["Always"]);
  });

  it("fires every 3rd call", () => {
    const hint: StateHint = {
      id: "always",
      category: "economy",
      condition: () => true,
      hint: "Always",
    };
    const engine = new StateHintEngine([hint]);
    const cache = makeCache({ alpha: makeStatusData() });

    // Advance through 6 calls
    const results: (string[] | null)[] = [];
    for (let i = 0; i < 6; i++) {
      results.push(engine.evaluate(cache, "alpha"));
    }
    expect(results[0]).toBeNull();
    expect(results[1]).toBeNull();
    expect(results[2]).toEqual(["Always"]);
    expect(results[3]).toBeNull();
    expect(results[4]).toBeNull();
    expect(results[5]).toEqual(["Always"]);
  });

  it("returns null when no hints match", () => {
    const hint: StateHint = {
      id: "never",
      category: "economy",
      condition: () => false,
      hint: "Never",
    };
    const engine = new StateHintEngine([hint]);
    const cache = makeCache({ alpha: makeStatusData() });

    // Advance to 3rd call
    engine.evaluate(cache, "alpha");
    engine.evaluate(cache, "alpha");
    expect(engine.evaluate(cache, "alpha")).toBeNull();
  });

  it("limits to 2 hints per injection", () => {
    const hints: StateHint[] = [
      { id: "a", category: "economy", condition: () => true, hint: "A" },
      { id: "b", category: "combat", condition: () => true, hint: "B" },
      { id: "c", category: "navigation", condition: () => true, hint: "C" },
    ];
    const engine = new StateHintEngine(hints);
    const cache = makeCache({ alpha: makeStatusData() });

    // Advance to 3rd call
    engine.evaluate(cache, "alpha");
    engine.evaluate(cache, "alpha");
    const result = engine.evaluate(cache, "alpha");
    expect(result).toHaveLength(2);
    expect(result).toEqual(["A", "B"]);
  });

  it("frequency counters are per-agent", () => {
    const hint: StateHint = {
      id: "per-agent",
      category: "economy",
      condition: () => true,
      hint: "Per agent",
    };
    const engine = new StateHintEngine([hint]);
    const cache = makeCache({ alpha: makeStatusData(), bravo: makeStatusData() });

    // Both start at count 0
    engine.evaluate(cache, "alpha"); // alpha:1
    engine.evaluate(cache, "alpha"); // alpha:2
    engine.evaluate(cache, "bravo"); // bravo:1
    engine.evaluate(cache, "bravo"); // bravo:2

    // alpha:3 → fires
    expect(engine.evaluate(cache, "alpha")).toEqual(["Per agent"]);
    // bravo:3 → fires
    expect(engine.evaluate(cache, "bravo")).toEqual(["Per agent"]);
  });

  it("resetCounter resets the frequency counter", () => {
    const hint: StateHint = {
      id: "reset",
      category: "economy",
      condition: () => true,
      hint: "Reset",
    };
    const engine = new StateHintEngine([hint]);
    const cache = makeCache({ alpha: makeStatusData() });

    engine.evaluate(cache, "alpha"); // 1
    engine.evaluate(cache, "alpha"); // 2
    engine.resetCounter("alpha");
    // After reset, starts from 0 again
    expect(engine.evaluate(cache, "alpha")).toBeNull(); // 1
    expect(engine.evaluate(cache, "alpha")).toBeNull(); // 2
    expect(engine.evaluate(cache, "alpha")).toEqual(["Reset"]); // 3
  });

  it("handles condition errors gracefully", () => {
    const hints: StateHint[] = [
      { id: "error", category: "economy", condition: () => { throw new Error("boom"); }, hint: "Error" },
      { id: "ok", category: "economy", condition: () => true, hint: "OK" },
    ];
    const engine = new StateHintEngine(hints);
    const cache = makeCache({ alpha: makeStatusData() });

    engine.evaluate(cache, "alpha");
    engine.evaluate(cache, "alpha");
    const result = engine.evaluate(cache, "alpha");
    // Error hint skipped, OK hint fires
    expect(result).toEqual(["OK"]);
  });

  it("addHint and removeHint work", () => {
    const engine = new StateHintEngine([]);
    engine.addHint({ id: "new", category: "combat", condition: () => true, hint: "New" });
    expect(engine.getHintIds()).toContain("new");
    engine.removeHint("new");
    expect(engine.getHintIds()).not.toContain("new");
  });

  it("returns null for agent with no cache entry", () => {
    const engine = new StateHintEngine(BUILT_IN_HINTS);
    const cache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();

    // Advance to 3rd call
    engine.evaluate(cache, "missing");
    engine.evaluate(cache, "missing");
    expect(engine.evaluate(cache, "missing")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Built-in hints
// ---------------------------------------------------------------------------

describe("built-in hints", () => {
  it("near-market-with-cargo fires when docked with cargo", () => {
    const engine = new StateHintEngine(BUILT_IN_HINTS);
    const data = makeStatusData({
      player: { current_system: "SOL-001", current_poi: "Station Alpha", docked_at_base: true },
      ship: { fuel: 80, max_fuel: 100, hull: 90, max_hull: 100, cargo_used: 10, cargo_capacity: 20 },
    });
    const cache = makeCache({ alpha: data });

    // Advance to 3rd call
    engine.evaluate(cache, "alpha");
    engine.evaluate(cache, "alpha");
    const result = engine.evaluate(cache, "alpha");
    expect(result).not.toBeNull();
    expect(result!.some((h) => h.includes("selling items"))).toBe(true);
  });

  it("near-market-with-cargo does not fire when cargo empty", () => {
    const engine = new StateHintEngine(BUILT_IN_HINTS);
    const data = makeStatusData({
      player: { current_system: "SOL-001", current_poi: "Station Alpha", docked_at_base: true },
      ship: { fuel: 80, max_fuel: 100, hull: 90, max_hull: 100, cargo_used: 0, cargo_capacity: 20 },
    });
    const cache = makeCache({ alpha: data });

    engine.evaluate(cache, "alpha");
    engine.evaluate(cache, "alpha");
    const result = engine.evaluate(cache, "alpha");
    // Low fuel near station might fire, but not cargo hint
    if (result) {
      expect(result.some((h) => h.includes("selling items"))).toBe(false);
    }
  });

  it("low-fuel-near-station fires when docked with low fuel", () => {
    const engine = new StateHintEngine(BUILT_IN_HINTS);
    const data = makeStatusData({
      player: { current_system: "SOL-001", current_poi: "Station Alpha", docked_at_base: true },
      ship: { fuel: 30, max_fuel: 100, hull: 90, max_hull: 100, cargo_used: 0, cargo_capacity: 20 },
    });
    const cache = makeCache({ alpha: data });

    engine.evaluate(cache, "alpha");
    engine.evaluate(cache, "alpha");
    const result = engine.evaluate(cache, "alpha");
    expect(result).not.toBeNull();
    expect(result!.some((h) => h.includes("Refuel"))).toBe(true);
  });

  it("damaged-near-repair fires when docked with low hull", () => {
    const engine = new StateHintEngine(BUILT_IN_HINTS);
    const data = makeStatusData({
      player: { current_system: "SOL-001", current_poi: "Station Alpha", docked_at_base: true },
      ship: { fuel: 80, max_fuel: 100, hull: 40, max_hull: 100, cargo_used: 0, cargo_capacity: 20 },
    });
    const cache = makeCache({ alpha: data });

    engine.evaluate(cache, "alpha");
    engine.evaluate(cache, "alpha");
    const result = engine.evaluate(cache, "alpha");
    expect(result).not.toBeNull();
    expect(result!.some((h) => h.includes("Repair"))).toBe(true);
  });

  it("empty-cargo-near-asteroids fires at mining site with empty cargo", () => {
    const engine = new StateHintEngine(BUILT_IN_HINTS);
    const data = makeStatusData({
      player: { current_system: "SOL-001", current_poi: "Iron Belt A", docked_at_base: false },
      ship: { fuel: 80, max_fuel: 100, hull: 90, max_hull: 100, cargo_used: 0, cargo_capacity: 20 },
    });
    const cache = makeCache({ alpha: data });

    engine.evaluate(cache, "alpha");
    engine.evaluate(cache, "alpha");
    const result = engine.evaluate(cache, "alpha");
    expect(result).not.toBeNull();
    expect(result!.some((h) => h.includes("mine"))).toBe(true);
  });

  it("empty-cargo does not fire at a station", () => {
    const engine = new StateHintEngine(BUILT_IN_HINTS);
    const data = makeStatusData({
      player: { current_system: "SOL-001", current_poi: "Station Alpha", docked_at_base: true },
      ship: { fuel: 80, max_fuel: 100, hull: 90, max_hull: 100, cargo_used: 0, cargo_capacity: 20 },
    });
    const cache = makeCache({ alpha: data });

    engine.evaluate(cache, "alpha");
    engine.evaluate(cache, "alpha");
    const result = engine.evaluate(cache, "alpha");
    // Should NOT contain the mining hint
    if (result) {
      expect(result.some((h) => h.includes("mine"))).toBe(false);
    }
  });

  it("mission-deadline fires when _active_missions_count is set", () => {
    const engine = new StateHintEngine(BUILT_IN_HINTS);
    const data = { ...makeStatusData(), _active_missions_count: 2 };
    const cache = makeCache({ alpha: data });

    engine.evaluate(cache, "alpha");
    engine.evaluate(cache, "alpha");
    const result = engine.evaluate(cache, "alpha");
    expect(result).not.toBeNull();
    expect(result!.some((h) => h.includes("missions"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Injection integration
// ---------------------------------------------------------------------------

describe("createStateHintInjection", () => {
  it("creates an injection with priority 65", () => {
    const engine = new StateHintEngine();
    const injection = createStateHintInjection(engine);
    expect(injection.name).toBe("state-hints");
    expect(injection.key).toBe("_hints");
    expect(injection.priority).toBe(65);
  });

  it("returns null when no hints fire (frequency limiting)", () => {
    const engine = new StateHintEngine(BUILT_IN_HINTS);
    const injection = createStateHintInjection(engine);

    const ctx = {
      statusCache: makeCache({ alpha: makeStatusData() }),
      battleCache: new Map(),
    } as unknown as PipelineContext;

    // First call — not 3rd
    expect(injection.gather(ctx, "alpha")).toBeNull();
  });

  it("integrates with InjectionRegistry at correct priority", () => {
    const engine = new StateHintEngine();
    const injectionRegistry = new InjectionRegistry();
    injectionRegistry.register(createStateHintInjection(engine));
    expect(injectionRegistry.getRegistered()).toEqual(["state-hints"]);
  });
});
