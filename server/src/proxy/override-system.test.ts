/**
 * Tests for the override system — condition-triggered urgent directives.
 * Uses in-memory state (Maps, mocks) — no database or network access.
 */

import { describe, it, expect } from "bun:test";
import {
  OverrideRegistry,
  BUILT_IN_RULES,
  extractAgentState,
  createOverrideInjection,
  type OverrideContext,
  type OverrideRule,
} from "./override-system.js";
import { InjectionRegistry } from "./injection-registry.js";
import { MetricsWindow } from "./instability-metrics.js";
import type { PipelineContext } from "./pipeline.js";
import type { BattleState } from "../shared/types.js";

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

function makeCtx(
  statusData?: Record<string, Record<string, unknown>>,
  battleData?: Record<string, BattleState | null>,
): OverrideContext {
  const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
  if (statusData) {
    for (const [agent, data] of Object.entries(statusData)) {
      statusCache.set(agent, { data, fetchedAt: Date.now() });
    }
  }
  const battleCache = new Map<string, BattleState | null>();
  if (battleData) {
    for (const [agent, state] of Object.entries(battleData)) {
      battleCache.set(agent, state);
    }
  }
  return { statusCache, battleCache };
}

function makeBattle(overrides: Partial<BattleState> = {}): BattleState {
  return {
    status: "attacking",
    zone: "mid",
    hull: 80,
    shields: 50,
    stance: "balanced",
    battle_id: "b-123",
    ...overrides,
  } as BattleState;
}

// ---------------------------------------------------------------------------
// extractAgentState
// ---------------------------------------------------------------------------

describe("extractAgentState", () => {
  it("extracts all fields from statusCache", () => {
    const cache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
    cache.set("alpha", { data: makeStatusData(), fetchedAt: Date.now() });
    const state = extractAgentState(cache, "alpha");
    expect(state.fuel).toBe(80);
    expect(state.maxFuel).toBe(100);
    expect(state.hull).toBe(90);
    expect(state.maxHull).toBe(100);
    expect(state.cargoUsed).toBe(5);
    expect(state.cargoCapacity).toBe(20);
    expect(state.credits).toBe(5000);
    expect(state.currentSystem).toBe("SOL-001");
    expect(state.dockedAtBase).toBe(true);
  });

  it("returns empty object for missing agent", () => {
    const cache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
    const state = extractAgentState(cache, "missing");
    expect(state).toEqual({});
  });

  it("handles flat data shape (no nested player/ship)", () => {
    const cache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
    cache.set("alpha", {
      data: { fuel: 10, max_fuel: 100, current_system: "X-1" },
      fetchedAt: Date.now(),
    });
    const state = extractAgentState(cache, "alpha");
    // flat shape — no player/ship wrapping, so ship fields come from player fallback
    expect(state.currentSystem).toBe("X-1");
  });
});

// ---------------------------------------------------------------------------
// OverrideRegistry basics
// ---------------------------------------------------------------------------

describe("OverrideRegistry", () => {
  it("evaluates no rules when none are registered", () => {
    const registry = new OverrideRegistry();
    const ctx = makeCtx({ alpha: makeStatusData() });
    expect(registry.evaluate(ctx, "alpha")).toEqual([]);
  });

  it("evaluates a simple custom rule", () => {
    const rule: OverrideRule = {
      name: "test-rule",
      priority: 1,
      cooldownMs: 0,
      condition: () => true,
      directive: "Test directive",
    };
    const registry = new OverrideRegistry([rule]);
    const ctx = makeCtx({ alpha: makeStatusData() });
    const result = registry.evaluate(ctx, "alpha");
    expect(result).toEqual(["Test directive"]);
  });

  it("skips rules whose condition returns false", () => {
    const rule: OverrideRule = {
      name: "never-fires",
      priority: 1,
      cooldownMs: 0,
      condition: () => false,
      directive: "Should not appear",
    };
    const registry = new OverrideRegistry([rule]);
    const ctx = makeCtx({ alpha: makeStatusData() });
    expect(registry.evaluate(ctx, "alpha")).toEqual([]);
  });

  it("respects cooldown", () => {
    const rule: OverrideRule = {
      name: "cooldown-rule",
      priority: 1,
      cooldownMs: 60_000,
      condition: () => true,
      directive: "Cooldown test",
    };
    const registry = new OverrideRegistry([rule]);
    const ctx = makeCtx({ alpha: makeStatusData() });
    const now = Date.now();

    // First call fires
    expect(registry.evaluate(ctx, "alpha", now)).toEqual(["Cooldown test"]);
    // Second call within cooldown does NOT fire
    expect(registry.evaluate(ctx, "alpha", now + 1000)).toEqual([]);
    // After cooldown expires, fires again
    expect(registry.evaluate(ctx, "alpha", now + 61_000)).toEqual(["Cooldown test"]);
  });

  it("cooldowns are per-agent", () => {
    const rule: OverrideRule = {
      name: "per-agent",
      priority: 1,
      cooldownMs: 60_000,
      condition: () => true,
      directive: "Fire!",
    };
    const registry = new OverrideRegistry([rule]);
    const ctx = makeCtx({ alpha: makeStatusData(), bravo: makeStatusData() });
    const now = Date.now();

    // alpha fires
    expect(registry.evaluate(ctx, "alpha", now)).toEqual(["Fire!"]);
    // bravo fires (separate cooldown)
    expect(registry.evaluate(ctx, "bravo", now)).toEqual(["Fire!"]);
    // alpha on cooldown
    expect(registry.evaluate(ctx, "alpha", now + 100)).toEqual([]);
  });

  it("executes rules in priority order", () => {
    const rules: OverrideRule[] = [
      { name: "low-pri", priority: 20, cooldownMs: 0, condition: () => true, directive: "low" },
      { name: "high-pri", priority: 5, cooldownMs: 0, condition: () => true, directive: "high" },
      { name: "mid-pri", priority: 10, cooldownMs: 0, condition: () => true, directive: "mid" },
    ];
    const registry = new OverrideRegistry(rules);
    const ctx = makeCtx({ alpha: makeStatusData() });
    expect(registry.evaluate(ctx, "alpha")).toEqual(["high", "mid", "low"]);
  });

  it("supports function directives", () => {
    const rule: OverrideRule = {
      name: "fn-directive",
      priority: 1,
      cooldownMs: 0,
      condition: () => true,
      directive: (_ctx, agent) => `Hello ${agent}`,
    };
    const registry = new OverrideRegistry([rule]);
    const ctx = makeCtx({ alpha: makeStatusData() });
    expect(registry.evaluate(ctx, "alpha")).toEqual(["Hello alpha"]);
  });

  it("handles condition errors gracefully", () => {
    const rule: OverrideRule = {
      name: "error-rule",
      priority: 1,
      cooldownMs: 0,
      condition: () => { throw new Error("boom"); },
      directive: "Should not appear",
    };
    const registry = new OverrideRegistry([rule]);
    const ctx = makeCtx({ alpha: makeStatusData() });
    // Should not throw, should return empty
    expect(registry.evaluate(ctx, "alpha")).toEqual([]);
  });

  it("addRule inserts and maintains priority order", () => {
    const registry = new OverrideRegistry();
    registry.addRule({ name: "b", priority: 20, cooldownMs: 0, condition: () => true, directive: "B" });
    registry.addRule({ name: "a", priority: 5, cooldownMs: 0, condition: () => true, directive: "A" });
    expect(registry.getRuleNames()).toEqual(["a", "b"]);
  });

  it("removeRule removes a rule by name", () => {
    const registry = new OverrideRegistry(BUILT_IN_RULES);
    const before = registry.getRuleNames();
    expect(before).toContain("low-fuel");
    registry.removeRule("low-fuel");
    expect(registry.getRuleNames()).not.toContain("low-fuel");
  });
});

// ---------------------------------------------------------------------------
// History tracking
// ---------------------------------------------------------------------------

describe("OverrideRegistry history", () => {
  it("tracks history of fired overrides", () => {
    const rule: OverrideRule = {
      name: "tracked",
      priority: 1,
      cooldownMs: 0,
      condition: () => true,
      directive: "Tracked directive",
    };
    const registry = new OverrideRegistry([rule]);
    const ctx = makeCtx({ alpha: makeStatusData() });
    registry.evaluate(ctx, "alpha");

    const history = registry.getHistory("alpha");
    expect(history).toHaveLength(1);
    expect(history[0].rule).toBe("tracked");
    expect(history[0].directive).toBe("Tracked directive");
    expect(typeof history[0].timestamp).toBe("number");
  });

  it("limits history to 10 entries", () => {
    const rule: OverrideRule = {
      name: "spam",
      priority: 1,
      cooldownMs: 0,
      condition: () => true,
      directive: "Spam",
    };
    const registry = new OverrideRegistry([rule]);
    const ctx = makeCtx({ alpha: makeStatusData() });

    for (let i = 0; i < 15; i++) {
      registry.evaluate(ctx, "alpha");
    }

    expect(registry.getHistory("alpha")).toHaveLength(10);
  });

  it("getAllHistory returns entries for all agents", () => {
    const rule: OverrideRule = {
      name: "multi",
      priority: 1,
      cooldownMs: 0,
      condition: () => true,
      directive: "Multi",
    };
    const registry = new OverrideRegistry([rule]);
    const ctx = makeCtx({ alpha: makeStatusData(), bravo: makeStatusData() });
    registry.evaluate(ctx, "alpha");
    registry.evaluate(ctx, "bravo");

    const all = registry.getAllHistory();
    expect(Object.keys(all)).toContain("alpha");
    expect(Object.keys(all)).toContain("bravo");
  });

  it("clearAgent removes cooldowns and history", () => {
    const rule: OverrideRule = {
      name: "clear-test",
      priority: 1,
      cooldownMs: 60_000,
      condition: () => true,
      directive: "Clear test",
    };
    const registry = new OverrideRegistry([rule]);
    const ctx = makeCtx({ alpha: makeStatusData() });
    const now = Date.now();

    registry.evaluate(ctx, "alpha", now);
    expect(registry.getHistory("alpha")).toHaveLength(1);

    registry.clearAgent("alpha");
    expect(registry.getHistory("alpha")).toHaveLength(0);

    // Cooldown should be cleared — fires again
    expect(registry.evaluate(ctx, "alpha", now + 100)).toEqual(["Clear test"]);
  });
});

// ---------------------------------------------------------------------------
// Built-in rules
// ---------------------------------------------------------------------------

describe("built-in rules", () => {
  it("low-fuel fires when fuel < 20%", () => {
    const registry = new OverrideRegistry(BUILT_IN_RULES);
    const data = makeStatusData({ ship: { fuel: 15, max_fuel: 100, hull: 100, max_hull: 100, cargo_used: 0, cargo_capacity: 20 } });
    const ctx = makeCtx({ alpha: data });
    const result = registry.evaluate(ctx, "alpha");
    expect(result.some((d) => d.includes("Fuel critically low"))).toBe(true);
  });

  it("low-fuel does not fire when fuel is healthy", () => {
    const registry = new OverrideRegistry(BUILT_IN_RULES);
    const data = makeStatusData({ ship: { fuel: 80, max_fuel: 100, hull: 100, max_hull: 100, cargo_used: 0, cargo_capacity: 20 } });
    const ctx = makeCtx({ alpha: data });
    const result = registry.evaluate(ctx, "alpha");
    expect(result.some((d) => d.includes("Fuel critically low"))).toBe(false);
  });

  it("in-combat fires during active battle", () => {
    const registry = new OverrideRegistry(BUILT_IN_RULES);
    const ctx = makeCtx({ alpha: makeStatusData() }, { alpha: makeBattle() });
    const result = registry.evaluate(ctx, "alpha");
    expect(result.some((d) => d.includes("active combat"))).toBe(true);
  });

  it("in-combat does not fire for ended battle", () => {
    const registry = new OverrideRegistry(BUILT_IN_RULES);
    const ctx = makeCtx({ alpha: makeStatusData() }, { alpha: makeBattle({ status: "ended" }) });
    const result = registry.evaluate(ctx, "alpha");
    expect(result.some((d) => d.includes("active combat"))).toBe(false);
  });

  it("in-combat does not fire for null battle", () => {
    const registry = new OverrideRegistry(BUILT_IN_RULES);
    const ctx = makeCtx({ alpha: makeStatusData() }, { alpha: null });
    const result = registry.evaluate(ctx, "alpha");
    expect(result.some((d) => d.includes("active combat"))).toBe(false);
  });

  it("low-hull fires when hull < 30%", () => {
    const registry = new OverrideRegistry(BUILT_IN_RULES);
    const data = makeStatusData({ ship: { fuel: 100, max_fuel: 100, hull: 25, max_hull: 100, cargo_used: 0, cargo_capacity: 20 } });
    const ctx = makeCtx({ alpha: data });
    const result = registry.evaluate(ctx, "alpha");
    expect(result.some((d) => d.includes("Hull critically low"))).toBe(true);
  });

  it("low-hull does not fire at 50% hull", () => {
    const registry = new OverrideRegistry(BUILT_IN_RULES);
    const data = makeStatusData({ ship: { fuel: 100, max_fuel: 100, hull: 50, max_hull: 100, cargo_used: 0, cargo_capacity: 20 } });
    const ctx = makeCtx({ alpha: data });
    const result = registry.evaluate(ctx, "alpha");
    expect(result.some((d) => d.includes("Hull critically low"))).toBe(false);
  });

  it("cargo-full fires when cargo at capacity", () => {
    const registry = new OverrideRegistry(BUILT_IN_RULES);
    const data = makeStatusData({ ship: { fuel: 100, max_fuel: 100, hull: 100, max_hull: 100, cargo_used: 20, cargo_capacity: 20 } });
    const ctx = makeCtx({ alpha: data });
    const result = registry.evaluate(ctx, "alpha");
    expect(result.some((d) => d.includes("Cargo hold is full"))).toBe(true);
  });

  it("cargo-full does not fire when cargo has space", () => {
    const registry = new OverrideRegistry(BUILT_IN_RULES);
    const data = makeStatusData({ ship: { fuel: 100, max_fuel: 100, hull: 100, max_hull: 100, cargo_used: 10, cargo_capacity: 20 } });
    const ctx = makeCtx({ alpha: data });
    const result = registry.evaluate(ctx, "alpha");
    expect(result.some((d) => d.includes("Cargo hold is full"))).toBe(false);
  });

  it("stuck-in-transit fires when no current system", () => {
    const registry = new OverrideRegistry(BUILT_IN_RULES);
    const data = makeStatusData({ player: { current_system: "", current_poi: "" } });
    const ctx = makeCtx({ alpha: data });
    const result = registry.evaluate(ctx, "alpha");
    expect(result.some((d) => d.includes("hyperspace transit"))).toBe(true);
  });

  it("stuck-in-transit does not fire when system is present", () => {
    const registry = new OverrideRegistry(BUILT_IN_RULES);
    const ctx = makeCtx({ alpha: makeStatusData() });
    const result = registry.evaluate(ctx, "alpha");
    expect(result.some((d) => d.includes("hyperspace transit"))).toBe(false);
  });

  it("low-credits fires when credits < 500", () => {
    const registry = new OverrideRegistry(BUILT_IN_RULES);
    const data = makeStatusData({ player: { username: "test", credits: 200, current_system: "SOL-001", current_poi: "Station", docked_at_base: true } });
    const ctx = makeCtx({ alpha: data });
    const result = registry.evaluate(ctx, "alpha");
    expect(result.some((d) => d.includes("Credits critically low"))).toBe(true);
  });

  it("low-credits does not fire when credits are sufficient", () => {
    const registry = new OverrideRegistry(BUILT_IN_RULES);
    const ctx = makeCtx({ alpha: makeStatusData() }); // 5000 credits
    const result = registry.evaluate(ctx, "alpha");
    expect(result.some((d) => d.includes("Credits critically low"))).toBe(false);
  });

  it("low-credits includes credit amount in directive", () => {
    const registry = new OverrideRegistry(BUILT_IN_RULES);
    const data = makeStatusData({ player: { username: "test", credits: 42, current_system: "SOL-001", current_poi: "Station", docked_at_base: true } });
    const ctx = makeCtx({ alpha: data });
    const result = registry.evaluate(ctx, "alpha");
    const creditDirective = result.find((d) => d.includes("Credits critically low"));
    expect(creditDirective).toBeDefined();
    expect(creditDirective).toContain("42");
  });

  it("does not fire for agent with no status cache entry", () => {
    const registry = new OverrideRegistry(BUILT_IN_RULES);
    const ctx = makeCtx({});
    const result = registry.evaluate(ctx, "missing-agent");
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Injection integration
// ---------------------------------------------------------------------------

describe("createOverrideInjection", () => {
  it("creates an injection with priority 5", () => {
    const registry = new OverrideRegistry(BUILT_IN_RULES);
    const injection = createOverrideInjection(registry);
    expect(injection.name).toBe("overrides");
    expect(injection.key).toBe("_overrides");
    expect(injection.priority).toBe(5);
  });

  it("returns null when no overrides fire", () => {
    const registry = new OverrideRegistry(BUILT_IN_RULES);
    const injection = createOverrideInjection(registry);

    const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
    statusCache.set("alpha", { data: makeStatusData(), fetchedAt: Date.now() });

    const ctx = {
      config: { agents: [], gameUrl: "", gameApiUrl: "", gameMcpUrl: "", agentDeniedTools: {}, callLimits: {}, turnSleepMs: 0, staggerDelay: 0 },
      sessionAgentMap: new Map(),
      callTrackers: new Map(),
      eventBuffers: new Map(),
      battleCache: new Map(),
      statusCache,
      callLimits: {},
      serverMetrics: new MetricsWindow(),
      getFleetPendingOrders: () => [],
      markOrderDelivered: () => {},
      reformatResponse: (text: string) => text,
      injectionRegistry: new InjectionRegistry(),
    } as unknown as PipelineContext;

    expect(injection.gather(ctx, "alpha")).toBeNull();
  });

  it("returns directives array when overrides fire", () => {
    const rule: OverrideRule = {
      name: "always",
      priority: 1,
      cooldownMs: 0,
      condition: () => true,
      directive: "Always fire",
    };
    const registry = new OverrideRegistry([rule]);
    const injection = createOverrideInjection(registry);

    const ctx = {
      statusCache: new Map(),
      battleCache: new Map(),
    } as unknown as PipelineContext;

    const result = injection.gather(ctx, "alpha");
    expect(result).toEqual(["Always fire"]);
  });

  it("integrates with InjectionRegistry at correct priority", () => {
    const rule: OverrideRule = {
      name: "test",
      priority: 1,
      cooldownMs: 0,
      condition: () => true,
      directive: "Override!",
    };
    const overrideRegistry = new OverrideRegistry([rule]);
    const injectionRegistry = new InjectionRegistry();
    injectionRegistry.register(createOverrideInjection(overrideRegistry));

    // The override injection should be the first (and only) registered
    expect(injectionRegistry.getRegistered()).toEqual(["overrides"]);
  });
});
