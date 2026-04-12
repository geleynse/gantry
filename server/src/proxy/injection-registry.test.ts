/**
 * Tests for InjectionRegistry and the default injections extracted from
 * the withInjections() function in pipeline.ts.
 *
 * Uses in-memory state (Maps, mocks) — no database or network access.
 */

import { describe, it, expect } from "bun:test";
import {
  InjectionRegistry,
  createDefaultInjections,
  extractBattleStatus,
} from "./injection-registry.js";
import { EventBuffer } from "./event-buffer.js";
import { MetricsWindow } from "./instability-metrics.js";
import type { PipelineContext } from "./pipeline.js";
import type { BattleState } from "../shared/types.js";
import type { GantryConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<GantryConfig> = {}): GantryConfig {
  return {
    agents: [{ name: "alpha" }, { name: "bravo" }],
    gameUrl: "http://localhost:9999",
    gameApiUrl: "http://localhost:9999/api",
    agentDeniedTools: {},
    callLimits: {},
    turnSleepMs: 0,
    staggerDelay: 0,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const registry = new InjectionRegistry();
  for (const inj of createDefaultInjections()) registry.register(inj);
  return {
    config: makeConfig(),
    sessionAgentMap: new Map(),
    callTrackers: new Map(),
    eventBuffers: new Map(),
    battleCache: new Map(),
    callLimits: {},
    serverMetrics: new MetricsWindow(),
    getFleetPendingOrders: () => [],
    markOrderDelivered: () => {},
    reformatResponse: (text) => text,
    injectionRegistry: registry,
    ...overrides,
  } as PipelineContext;
}

function makeBattleState(overrides: Partial<BattleState> = {}): BattleState {
  return {
    status: "attacking",
    zone: "mid",
    hull: 80,
    shields: 50,
    stance: "aggressive",
    battle_id: "b-001",
    ...overrides,
  } as BattleState;
}

// ---------------------------------------------------------------------------
// InjectionRegistry — core behaviour
// ---------------------------------------------------------------------------

describe("InjectionRegistry", () => {
  it("executes injections in priority order", () => {
    const registry = new InjectionRegistry();
    const order: number[] = [];

    registry.register({
      name: "third",
      key: "c",
      priority: 30,
      enabled: () => true,
      gather: () => { order.push(30); return { key: "c", value: 30 }; },
    });
    registry.register({
      name: "first",
      key: "a",
      priority: 10,
      enabled: () => true,
      gather: () => { order.push(10); return { key: "a", value: 10 }; },
    });
    registry.register({
      name: "second",
      key: "b",
      priority: 20,
      enabled: () => true,
      gather: () => { order.push(20); return { key: "b", value: 20 }; },
    });

    const ctx = makeCtx({ injectionRegistry: registry });
    registry.run(ctx, "alpha");

    expect(order).toEqual([10, 20, 30]);
  });

  it("returns registered injection names in priority order", () => {
    const registry = new InjectionRegistry();
    registry.register({ name: "b", key: "b", priority: 20, enabled: () => true, gather: () => null });
    registry.register({ name: "a", key: "a", priority: 10, enabled: () => true, gather: () => null });
    registry.register({ name: "c", key: "c", priority: 30, enabled: () => true, gather: () => null });

    expect(registry.getRegistered()).toEqual(["a", "b", "c"]);
  });

  it("skips disabled injections", () => {
    const registry = new InjectionRegistry();
    registry.register({
      name: "active",
      key: "yes",
      priority: 10,
      enabled: () => true,
      gather: () => ({ key: "yes", value: "active" }),
    });
    registry.register({
      name: "inactive",
      key: "no",
      priority: 20,
      enabled: () => false,
      gather: () => ({ key: "no", value: "inactive" }),
    });

    const ctx = makeCtx({ injectionRegistry: registry });
    const results = registry.run(ctx, "alpha");

    expect(results.has("yes")).toBe(true);
    expect(results.has("no")).toBe(false);
  });

  it("excludes injections that return null from gather()", () => {
    const registry = new InjectionRegistry();
    registry.register({
      name: "present",
      key: "present",
      priority: 10,
      enabled: () => true,
      gather: () => ({ key: "present", value: "data" }),
    });
    registry.register({
      name: "absent",
      key: "absent",
      priority: 20,
      enabled: () => true,
      gather: () => null,
    });

    const ctx = makeCtx({ injectionRegistry: registry });
    const results = registry.run(ctx, "alpha");

    expect(results.has("present")).toBe(true);
    expect(results.has("absent")).toBe(false);
    expect(results.size).toBe(1);
  });

  it("unregister() removes an injection by name", () => {
    const registry = new InjectionRegistry();
    registry.register({ name: "keep", key: "k", priority: 10, enabled: () => true, gather: () => ({ key: "k", value: 1 }) });
    registry.register({ name: "remove", key: "r", priority: 20, enabled: () => true, gather: () => ({ key: "r", value: 2 }) });

    registry.unregister("remove");

    const ctx = makeCtx({ injectionRegistry: registry });
    const results = registry.run(ctx, "alpha");
    expect(results.has("k")).toBe(true);
    expect(results.has("r")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractBattleStatus helper
// ---------------------------------------------------------------------------

describe("extractBattleStatus", () => {
  it("returns null when no battle in cache", () => {
    expect(extractBattleStatus(new Map(), "alpha")).toBeNull();
  });

  it("returns null when cached battle is explicitly null (ended)", () => {
    const cache = new Map<string, BattleState | null>([["alpha", null]]);
    expect(extractBattleStatus(cache, "alpha")).toBeNull();
  });

  it("returns null for terminal statuses", () => {
    for (const status of ["ended", "victory", "defeat", "fled"] as const) {
      const cache = new Map<string, BattleState | null>([
        ["alpha", makeBattleState({ status })],
      ]);
      expect(extractBattleStatus(cache, "alpha")).toBeNull();
    }
  });

  it("returns battle info for active status", () => {
    const cache = new Map<string, BattleState | null>([
      ["alpha", makeBattleState({ status: "attacking", hull: 75, shields: 40 })],
    ]);
    const result = extractBattleStatus(cache, "alpha") as Record<string, unknown>;
    expect(result).not.toBeNull();
    expect(result.in_battle).toBe(true);
    expect(result.status).toBe("attacking");
    expect(result.hull).toBe(75);
  });
});

// ---------------------------------------------------------------------------
// Default injection: critical-events (priority 10)
// ---------------------------------------------------------------------------

describe("default injection: critical-events", () => {
  it("injects critical events from the event buffer", () => {
    const buf = new EventBuffer();
    buf.push({ type: "player_died", payload: { location: "orbit" }, receivedAt: Date.now() });

    const ctx = makeCtx({ eventBuffers: new Map([["alpha", buf]]) });
    const results = ctx.injectionRegistry.run(ctx, "alpha");

    expect(results.has("events")).toBe(true);
    const events = results.get("events") as Array<{ type: string; data: unknown }>;
    expect(events[0].type).toBe("player_died");
    expect(events[0].data).toEqual({ location: "orbit" });
  });

  it("returns no events key when buffer is empty", () => {
    const ctx = makeCtx({ eventBuffers: new Map([["alpha", new EventBuffer()]]) });
    const results = ctx.injectionRegistry.run(ctx, "alpha");
    expect(results.has("events")).toBe(false);
  });

  it("drains events from buffer after injection", () => {
    const buf = new EventBuffer();
    buf.push({ type: "player_died", payload: {}, receivedAt: Date.now() });

    const ctx = makeCtx({ eventBuffers: new Map([["alpha", buf]]) });
    ctx.injectionRegistry.run(ctx, "alpha");

    // Second run should have no events
    const second = ctx.injectionRegistry.run(ctx, "alpha");
    expect(second.has("events")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Default injection: fleet-orders (priority 20)
// ---------------------------------------------------------------------------

describe("default injection: fleet-orders", () => {
  it("injects fleet orders and marks them delivered", () => {
    const deliveredIds: number[] = [];
    const ctx = makeCtx({
      getFleetPendingOrders: () => [
        { id: 42, message: "Go to Sol", priority: "high" },
        { id: 43, message: "Mine asteroids", priority: "normal" },
      ],
      markOrderDelivered: (id) => deliveredIds.push(id),
    });

    const results = ctx.injectionRegistry.run(ctx, "alpha");

    expect(results.has("fleet_orders")).toBe(true);
    const orders = results.get("fleet_orders") as Array<{ id: number; message: string; priority: string }>;
    expect(orders).toHaveLength(2);
    expect(orders[0].id).toBe(42);
    expect(orders[1].message).toBe("Mine asteroids");
    expect(deliveredIds).toEqual([42, 43]);
  });

  it("returns no fleet_orders key when there are no pending orders", () => {
    const ctx = makeCtx({ getFleetPendingOrders: () => [] });
    const results = ctx.injectionRegistry.run(ctx, "alpha");
    expect(results.has("fleet_orders")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Default injection: battle-status (priority 30)
// ---------------------------------------------------------------------------

describe("default injection: battle-status", () => {
  it("injects _battle_status when agent is in active combat", () => {
    const battleCache = new Map<string, BattleState | null>([
      ["alpha", makeBattleState({ status: "attacking" })],
    ]);
    const ctx = makeCtx({ battleCache });
    const results = ctx.injectionRegistry.run(ctx, "alpha");

    expect(results.has("_battle_status")).toBe(true);
    const status = results.get("_battle_status") as Record<string, unknown>;
    expect(status.in_battle).toBe(true);
    expect(status.status).toBe("attacking");
  });

  it("does not inject _battle_status when no battle exists", () => {
    const ctx = makeCtx({ battleCache: new Map() });
    const results = ctx.injectionRegistry.run(ctx, "alpha");
    expect(results.has("_battle_status")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Default injection: instability-hint (priority 40)
// ---------------------------------------------------------------------------

describe("default injection: instability-hint", () => {
  it("does not inject server_notice when metrics are healthy", () => {
    const ctx = makeCtx({ serverMetrics: new MetricsWindow() }); // fresh = healthy
    const results = ctx.injectionRegistry.run(ctx, "alpha");
    expect(results.has("server_notice")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Default injection: storage-warning (priority 50)
// ---------------------------------------------------------------------------

describe("default injection: storage-warning", () => {
  it("injects _storage_warning when faction storage is over limit", () => {
    const statusCache = new Map([
      ["alpha", {
        data: { faction_storage_used: 9500, faction_storage_max: 10000 },
        fetchedAt: Date.now(),
      }],
    ]);
    const ctx = makeCtx({ statusCache });
    const results = ctx.injectionRegistry.run(ctx, "alpha");

    // checkStorageLimits fires when used >= 90% of max
    expect(results.has("_storage_warning")).toBe(true);
    expect(typeof results.get("_storage_warning")).toBe("string");
  });

  it("does not inject _storage_warning when storage is fine", () => {
    const statusCache = new Map([
      ["alpha", {
        data: { faction_storage_used: 100, faction_storage_max: 10000 },
        fetchedAt: Date.now(),
      }],
    ]);
    const ctx = makeCtx({ statusCache });
    const results = ctx.injectionRegistry.run(ctx, "alpha");
    expect(results.has("_storage_warning")).toBe(false);
  });

  it("does not inject _storage_warning when no statusCache entry", () => {
    const ctx = makeCtx({ statusCache: new Map() });
    const results = ctx.injectionRegistry.run(ctx, "alpha");
    expect(results.has("_storage_warning")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Default injection: cloak-advisory (priority 60)
// ---------------------------------------------------------------------------

describe("default injection: cloak-advisory", () => {
  it("is disabled when autoCloakEnabled is false", () => {
    const config = makeConfig({ survivability: { autoCloakEnabled: false } } as any);
    const statusCache = new Map([
      ["alpha", {
        data: { current_system: "Danger Zone", docked_at_base: false },
        fetchedAt: Date.now(),
      }],
    ]);
    const ctx = makeCtx({ config, statusCache });
    const results = ctx.injectionRegistry.run(ctx, "alpha");
    expect(results.has("_cloak_advisory")).toBe(false);
  });

  it("does not inject _cloak_advisory when no statusCache entry", () => {
    const config = makeConfig({ survivability: { autoCloakEnabled: true } } as any);
    const ctx = makeCtx({ config, statusCache: new Map() });
    const results = ctx.injectionRegistry.run(ctx, "alpha");
    expect(results.has("_cloak_advisory")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Default injection: directives (priority 70)
// ---------------------------------------------------------------------------

describe("default injection: directives", () => {
  it("injects standing_orders when directives are present", () => {
    const ctx = makeCtx({
      getActiveDirectives: () => [
        { priority: "critical", directive: "Avoid pirates", agentName: "alpha", id: 1 } as any,
      ],
    });
    const results = ctx.injectionRegistry.run(ctx, "alpha");

    expect(results.has("standing_orders")).toBe(true);
    const text = results.get("standing_orders") as string;
    expect(text).toContain("STANDING ORDERS:");
    expect(text).toContain("[critical] Avoid pirates");
  });

  it("injects critical directives on every call", () => {
    const counters = new Map<string, number>();
    const ctx = makeCtx({
      getActiveDirectives: () => [
        { priority: "critical", directive: "Always report", agentName: "alpha", id: 1 } as any,
      ],
      directivesCallCounters: counters,
    });

    // Critical directives should appear on every call
    const r1 = ctx.injectionRegistry.run(ctx, "alpha");
    const r2 = ctx.injectionRegistry.run(ctx, "alpha");
    expect(r1.has("standing_orders")).toBe(true);
    expect(r2.has("standing_orders")).toBe(true);
  });

  it("injects regular directives on first call and every 5th thereafter", () => {
    const counters = new Map<string, number>();
    const ctx = makeCtx({
      getActiveDirectives: () => [
        { priority: "normal", directive: "Trade efficiently", agentName: "alpha", id: 2 } as any,
      ],
      directivesCallCounters: counters,
    });

    // Call 1 (count becomes 1, 1 % 5 === 1) → inject
    const r1 = ctx.injectionRegistry.run(ctx, "alpha");
    expect(r1.has("standing_orders")).toBe(true);

    // Calls 2-4 → no inject
    ctx.injectionRegistry.run(ctx, "alpha");
    ctx.injectionRegistry.run(ctx, "alpha");
    ctx.injectionRegistry.run(ctx, "alpha");

    // Call 5 (count becomes 5, 5 % 5 === 0) → no inject
    const r5 = ctx.injectionRegistry.run(ctx, "alpha");
    expect(r5.has("standing_orders")).toBe(false);

    // Call 6 (count becomes 6, 6 % 5 === 1) → inject again
    const r6 = ctx.injectionRegistry.run(ctx, "alpha");
    expect(r6.has("standing_orders")).toBe(true);
  });

  it("skips directive injection when getActiveDirectives is not set", () => {
    const ctx = makeCtx(); // no getActiveDirectives
    const results = ctx.injectionRegistry.run(ctx, "alpha");
    expect(results.has("standing_orders")).toBe(false);
  });

  it("does not inject standing_orders when directive list is empty", () => {
    const ctx = makeCtx({ getActiveDirectives: () => [] });
    const results = ctx.injectionRegistry.run(ctx, "alpha");
    expect(results.has("standing_orders")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createDefaultInjections: priority and name ordering
// ---------------------------------------------------------------------------

describe("createDefaultInjections", () => {
  it("returns 12 injections in the correct priority order", () => {
    const injections = createDefaultInjections();
    expect(injections).toHaveLength(12);

    const names = injections.map((i) => i.name);
    expect(names).toEqual([
      "critical-events",
      "location-context",
      "fleet-orders",
      "battle-status",
      "instability-hint",
      "threat-assessment",
      "storage-warning",
      "cloak-advisory",
      "poi-lore",
      "directives",
      "stale-strategy",
      "shutdown-warning",
    ]);

    const priorities = injections.map((i) => i.priority);
    expect(priorities).toEqual([10, 11, 20, 30, 40, 45, 50, 60, 62, 70, 75, 80]);
  });

  it("location-context injection returns current system from statusCache", () => {
    const injections = createDefaultInjections();
    const locCtx = injections.find((i) => i.name === "location-context")!;
    expect(locCtx).toBeDefined();
    expect(locCtx.key).toBe("_current_system");

    const ctx = makeCtx({
      statusCache: new Map([
        ["agent-a", {
          data: { player: { current_system: "Krynn" } },
          fetchedAt: Date.now(),
        }],
      ]),
    });

    expect(locCtx.gather(ctx, "agent-a")).toBe("Krynn");
    expect(locCtx.gather(ctx, "unknown-agent")).toBeNull();
  });

  it("location-context injection returns null when statusCache has no system", () => {
    const injections = createDefaultInjections();
    const locCtx = injections.find((i) => i.name === "location-context")!;

    // Empty system string
    const ctx = makeCtx({
      statusCache: new Map([
        ["agent-a", { data: { player: { current_system: "" } }, fetchedAt: Date.now() }],
      ]),
    });
    expect(locCtx.gather(ctx, "agent-a")).toBeNull();

    // No statusCache
    const ctxNoCache = makeCtx({ statusCache: undefined });
    expect(locCtx.gather(ctxNoCache, "agent-a")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Default injection: shutdown-warning (priority 80)
// ---------------------------------------------------------------------------

function makeSessionStoreMock(turnStartedAt: string | null = null) {
  return {
    getTurnStartedAt: (_id: string) => turnStartedAt,
    getSession: (_id: string) => null,
  } as unknown as import("./session-store.js").SessionStore;
}

describe("default injection: shutdown-warning", () => {
  it("injects _shutdown_warning when elapsed time exceeds threshold", () => {
    const turnStartedAt = new Date(Date.now() - 1200 * 1000).toISOString(); // 1200s ago
    const sessionAgentMap = new Map([["sess-1", "alpha"]]);
    const ctx = makeCtx({
      sessionAgentMap,
      sessionStore: makeSessionStoreMock(turnStartedAt),
      shutdownWarningFired: new Set<string>(),
    });

    const results = ctx.injectionRegistry.run(ctx, "alpha");

    expect(results.has("_shutdown_warning")).toBe(true);
    const msg = results.get("_shutdown_warning") as string;
    expect(msg).toContain("SHUTDOWN_SIGNAL");
    expect(msg).toContain("captains_log_add");
  });

  it("does not inject when elapsed time is below threshold", () => {
    const turnStartedAt = new Date(Date.now() - 500 * 1000).toISOString(); // 500s ago
    const sessionAgentMap = new Map([["sess-1", "alpha"]]);
    const ctx = makeCtx({
      sessionAgentMap,
      sessionStore: makeSessionStoreMock(turnStartedAt),
      shutdownWarningFired: new Set<string>(),
    });

    const results = ctx.injectionRegistry.run(ctx, "alpha");
    expect(results.has("_shutdown_warning")).toBe(false);
  });

  it("fires only once per turn (idempotent across multiple tool calls)", () => {
    const turnStartedAt = new Date(Date.now() - 1200 * 1000).toISOString();
    const sessionAgentMap = new Map([["sess-1", "alpha"]]);
    const ctx = makeCtx({
      sessionAgentMap,
      sessionStore: makeSessionStoreMock(turnStartedAt),
      shutdownWarningFired: new Set<string>(),
    });

    const r1 = ctx.injectionRegistry.run(ctx, "alpha");
    expect(r1.has("_shutdown_warning")).toBe(true);

    // Second call — already fired, should not inject again
    const r2 = ctx.injectionRegistry.run(ctx, "alpha");
    expect(r2.has("_shutdown_warning")).toBe(false);
  });

  it("respects custom shutdownWarningMs from config", () => {
    // Elapsed 600s, threshold set to 500s → should fire
    const turnStartedAt = new Date(Date.now() - 600 * 1000).toISOString();
    const sessionAgentMap = new Map([["sess-1", "alpha"]]);
    const ctx = makeCtx({
      config: makeConfig({ shutdownWarningMs: 500 * 1000 }),
      sessionAgentMap,
      sessionStore: makeSessionStoreMock(turnStartedAt),
      shutdownWarningFired: new Set<string>(),
    });

    const results = ctx.injectionRegistry.run(ctx, "alpha");
    expect(results.has("_shutdown_warning")).toBe(true);
  });

  it("does not inject when sessionStore is absent (disabled)", () => {
    const sessionAgentMap = new Map([["sess-1", "alpha"]]);
    const ctx = makeCtx({
      sessionAgentMap,
      // No sessionStore
      shutdownWarningFired: new Set<string>(),
    });

    const results = ctx.injectionRegistry.run(ctx, "alpha");
    expect(results.has("_shutdown_warning")).toBe(false);
  });

  it("does not inject when agent has no session in sessionAgentMap", () => {
    const turnStartedAt = new Date(Date.now() - 1200 * 1000).toISOString();
    const sessionAgentMap = new Map<string, string>(); // empty — no mapping for agent
    const ctx = makeCtx({
      sessionAgentMap,
      sessionStore: makeSessionStoreMock(turnStartedAt),
      shutdownWarningFired: new Set<string>(),
    });

    const results = ctx.injectionRegistry.run(ctx, "alpha");
    expect(results.has("_shutdown_warning")).toBe(false);
  });

  it("does not inject when turn_started_at is null", () => {
    const sessionAgentMap = new Map([["sess-1", "alpha"]]);
    const ctx = makeCtx({
      sessionAgentMap,
      sessionStore: makeSessionStoreMock(null), // no turn start recorded
      shutdownWarningFired: new Set<string>(),
    });

    const results = ctx.injectionRegistry.run(ctx, "alpha");
    expect(results.has("_shutdown_warning")).toBe(false);
  });
});
