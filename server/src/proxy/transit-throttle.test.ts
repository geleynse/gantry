/**
 * Tests for transit check throttle (transit-throttle.ts).
 *
 * Verifies:
 *  - Transit detection from statusCache state
 *  - Throttle blocks rapid calls during transit
 *  - First call always allowed (cooldown start)
 *  - Calls allowed after cooldown expires
 *  - Non-throttled tools pass through
 *  - Throttle clears when agent exits transit
 *  - Synthetic response includes destination/ETA info
 *  - Integration with checkGuardrailsV1 and checkGuardrailsV2
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  TransitThrottle,
  detectTransitState,
  TRANSIT_THROTTLED_TOOLS,
  THROTTLE_INTERVAL_MS,
  type StatusCacheEntry,
} from "./transit-throttle.js";
import {
  checkGuardrailsV1,
  checkGuardrailsV2,
  type PipelineContext,
} from "./pipeline.js";
import { MetricsWindow } from "./instability-metrics.js";
import { InjectionRegistry, createDefaultInjections } from "./injection-registry.js";
import { createDatabase, closeDb } from "../services/database.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStatusEntry(overrides: Record<string, unknown> = {}): StatusCacheEntry {
  return {
    data: {
      player: {
        current_system: "Sol",
        current_poi: "sol_station_1",
        credits: 1000,
        ...overrides,
      },
      ship: { hull: 100, fuel: 50 },
    },
    fetchedAt: Date.now(),
  };
}

function makeTransitEntry(overrides: Record<string, unknown> = {}): StatusCacheEntry {
  return {
    data: {
      player: {
        current_system: "Sol",
        current_poi: null,  // null POI = in transit
        credits: 1000,
        ...overrides,
      },
      ship: { hull: 100, fuel: 50 },
    },
    fetchedAt: Date.now(),
  };
}

function makeDefaultRegistry(): InjectionRegistry {
  const registry = new InjectionRegistry();
  for (const injection of createDefaultInjections()) {
    registry.register(injection);
  }
  return registry;
}

function makePipelineCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    config: {
      agents: [{ name: "test-agent" }],
      gameUrl: "http://localhost:9999",
      gameApiUrl: "http://localhost:9999/api",
      agentDeniedTools: {},
      callLimits: {},
      turnSleepMs: 0,
      staggerDelay: 0,
    },
    sessionAgentMap: new Map(),
    callTrackers: new Map(),
    eventBuffers: new Map(),
    battleCache: new Map(),
    callLimits: {},
    serverMetrics: new MetricsWindow(),
    getFleetPendingOrders: () => [],
    markOrderDelivered: () => {},
    reformatResponse: (text) => text,
    injectionRegistry: makeDefaultRegistry(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// detectTransitState
// ---------------------------------------------------------------------------

describe("detectTransitState", () => {
  it("returns null when agent has a current_poi (not in transit)", () => {
    const entry = makeStatusEntry();
    expect(detectTransitState(entry)).toBeNull();
  });

  it("returns transit info when current_poi is null", () => {
    const entry = makeTransitEntry();
    const result = detectTransitState(entry);
    expect(result).not.toBeNull();
    expect(result!.destination).toContain("Sol");
  });

  it("returns transit info when current_poi is empty string", () => {
    const entry = makeTransitEntry({ current_poi: "" });
    const result = detectTransitState(entry);
    expect(result).not.toBeNull();
  });

  it("returns transit info when current_poi is whitespace", () => {
    const entry = makeTransitEntry({ current_poi: "  " });
    const result = detectTransitState(entry);
    expect(result).not.toBeNull();
  });

  it("includes transit_destination when available in state", () => {
    const entry = makeTransitEntry({ transit_destination: "Alpha Centauri" });
    const result = detectTransitState(entry);
    expect(result).not.toBeNull();
    expect(result!.destination).toBe("Alpha Centauri");
  });

  it("includes ticks_remaining when available in state", () => {
    const entry = makeTransitEntry({ ticks_remaining: 3 });
    const result = detectTransitState(entry);
    expect(result).not.toBeNull();
    expect(result!.ticksRemaining).toBe(3);
  });

  it("returns 'unknown destination' when current_system is also null", () => {
    const entry = makeTransitEntry({ current_system: null });
    const result = detectTransitState(entry);
    expect(result).not.toBeNull();
    expect(result!.destination).toBe("unknown destination");
  });

  it("returns null when no cached data", () => {
    expect(detectTransitState(undefined)).toBeNull();
  });

  it("handles flat data shape (no player wrapper)", () => {
    const entry: StatusCacheEntry = {
      data: { current_system: "Sol", current_poi: null, credits: 100 },
      fetchedAt: Date.now(),
    };
    const result = detectTransitState(entry);
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TransitThrottle
// ---------------------------------------------------------------------------

describe("TransitThrottle", () => {
  let throttle: TransitThrottle;
  let statusCache: Map<string, StatusCacheEntry>;

  beforeEach(() => {
    // Use a short interval for testing
    throttle = new TransitThrottle(1000); // 1 second
    statusCache = new Map();
  });

  it("allows non-throttled tools through even during transit", () => {
    statusCache.set("agent-1", makeTransitEntry());
    expect(throttle.check("agent-1", "mine", statusCache)).toBeNull();
    expect(throttle.check("agent-1", "sell", statusCache)).toBeNull();
    expect(throttle.check("agent-1", "get_cargo", statusCache)).toBeNull();
  });

  it("allows throttled tools when agent is NOT in transit", () => {
    statusCache.set("agent-1", makeStatusEntry());
    expect(throttle.check("agent-1", "get_location", statusCache)).toBeNull();
    expect(throttle.check("agent-1", "get_location", statusCache)).toBeNull(); // immediate repeat
  });

  it("allows first call to throttled tool during transit", () => {
    statusCache.set("agent-1", makeTransitEntry());
    expect(throttle.check("agent-1", "get_location", statusCache)).toBeNull();
  });

  it("blocks second call to throttled tool during transit within cooldown", () => {
    statusCache.set("agent-1", makeTransitEntry());
    // First call allowed
    expect(throttle.check("agent-1", "get_location", statusCache)).toBeNull();
    // Second call blocked
    const result = throttle.check("agent-1", "get_location", statusCache);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.in_transit).toBe(true);
    expect(parsed._cached).toBe(true);
  });

  it("blocks get_system during transit after first call", () => {
    statusCache.set("agent-1", makeTransitEntry());
    expect(throttle.check("agent-1", "get_system", statusCache)).toBeNull();
    const result = throttle.check("agent-1", "get_system", statusCache);
    expect(result).not.toBeNull();
    expect(JSON.parse(result!).in_transit).toBe(true);
  });

  it("blocks get_poi during transit after first call", () => {
    statusCache.set("agent-1", makeTransitEntry());
    expect(throttle.check("agent-1", "get_poi", statusCache)).toBeNull();
    const result = throttle.check("agent-1", "get_poi", statusCache);
    expect(result).not.toBeNull();
    expect(JSON.parse(result!).in_transit).toBe(true);
  });

  it("shares cooldown across different throttled tools for same agent", () => {
    statusCache.set("agent-1", makeTransitEntry());
    // First call (get_location) allowed
    expect(throttle.check("agent-1", "get_location", statusCache)).toBeNull();
    // Second call (get_system) — different tool but same agent — blocked
    const result = throttle.check("agent-1", "get_system", statusCache);
    expect(result).not.toBeNull();
  });

  it("tracks agents independently", () => {
    statusCache.set("agent-1", makeTransitEntry());
    statusCache.set("agent-2", makeTransitEntry());
    // First call for each agent allowed
    expect(throttle.check("agent-1", "get_location", statusCache)).toBeNull();
    expect(throttle.check("agent-2", "get_location", statusCache)).toBeNull();
    // Second call for each blocked
    expect(throttle.check("agent-1", "get_location", statusCache)).not.toBeNull();
    expect(throttle.check("agent-2", "get_location", statusCache)).not.toBeNull();
  });

  it("allows call after cooldown expires", async () => {
    throttle = new TransitThrottle(50); // 50ms for fast test
    statusCache.set("agent-1", makeTransitEntry());
    // First call
    expect(throttle.check("agent-1", "get_location", statusCache)).toBeNull();
    // Wait for cooldown
    await new Promise(r => setTimeout(r, 60));
    // Should be allowed again
    expect(throttle.check("agent-1", "get_location", statusCache)).toBeNull();
  });

  it("clears throttle when agent exits transit", () => {
    statusCache.set("agent-1", makeTransitEntry());
    // First call allowed, second blocked
    expect(throttle.check("agent-1", "get_location", statusCache)).toBeNull();
    expect(throttle.check("agent-1", "get_location", statusCache)).not.toBeNull();

    // Agent arrives (now has a POI)
    statusCache.set("agent-1", makeStatusEntry());

    // Should be allowed immediately
    expect(throttle.check("agent-1", "get_location", statusCache)).toBeNull();
    // And again (not in transit, no throttle)
    expect(throttle.check("agent-1", "get_location", statusCache)).toBeNull();
  });

  it("includes destination in throttle response", () => {
    statusCache.set("agent-1", makeTransitEntry({ transit_destination: "Alpha Centauri" }));
    throttle.check("agent-1", "get_location", statusCache);
    const result = throttle.check("agent-1", "get_location", statusCache);
    const parsed = JSON.parse(result!);
    expect(parsed.destination).toBe("Alpha Centauri");
  });

  it("includes ETA in throttle response when ticks_remaining available", () => {
    statusCache.set("agent-1", makeTransitEntry({ ticks_remaining: 5 }));
    throttle.check("agent-1", "get_location", statusCache);
    const result = throttle.check("agent-1", "get_location", statusCache);
    const parsed = JSON.parse(result!);
    expect(parsed.eta_ticks).toBe(5);
  });

  it("clear() removes throttle state for specific agent", () => {
    statusCache.set("agent-1", makeTransitEntry());
    throttle.check("agent-1", "get_location", statusCache);
    throttle.clear("agent-1");
    // Should be allowed again
    expect(throttle.check("agent-1", "get_location", statusCache)).toBeNull();
  });

  it("clearAll() removes all throttle state", () => {
    statusCache.set("agent-1", makeTransitEntry());
    statusCache.set("agent-2", makeTransitEntry());
    throttle.check("agent-1", "get_location", statusCache);
    throttle.check("agent-2", "get_location", statusCache);
    throttle.clearAll();
    expect(throttle.check("agent-1", "get_location", statusCache)).toBeNull();
    expect(throttle.check("agent-2", "get_location", statusCache)).toBeNull();
  });

  it("trackedAgents returns count of tracked agents", () => {
    statusCache.set("agent-1", makeTransitEntry());
    statusCache.set("agent-2", makeTransitEntry());
    expect(throttle.trackedAgents).toBe(0);
    throttle.check("agent-1", "get_location", statusCache);
    expect(throttle.trackedAgents).toBe(1);
    throttle.check("agent-2", "get_location", statusCache);
    expect(throttle.trackedAgents).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Integration with pipeline guardrails
// ---------------------------------------------------------------------------

describe("transit throttle pipeline integration", () => {
  // Need database for signals-db
  beforeEach(() => {
    createDatabase(":memory:");
  });

  afterEach(() => {
    closeDb();
  });

  it("checkGuardrailsV1 blocks throttled tool during transit", () => {
    const transitThrottle = new TransitThrottle(30_000);
    const statusCache = new Map<string, StatusCacheEntry>();
    statusCache.set("test-agent", makeTransitEntry());

    const ctx = makePipelineCtx({ transitThrottle, statusCache });

    // First call allowed
    const result1 = checkGuardrailsV1(ctx, "test-agent", "get_location");
    expect(result1).toBeNull();

    // Second call blocked
    const result2 = checkGuardrailsV1(ctx, "test-agent", "get_location");
    expect(result2).not.toBeNull();
    expect(JSON.parse(result2!).in_transit).toBe(true);
  });

  it("checkGuardrailsV1 allows non-throttled tools during transit", () => {
    const transitThrottle = new TransitThrottle(30_000);
    const statusCache = new Map<string, StatusCacheEntry>();
    statusCache.set("test-agent", makeTransitEntry());

    const ctx = makePipelineCtx({ transitThrottle, statusCache });

    expect(checkGuardrailsV1(ctx, "test-agent", "mine")).toBeNull();
    expect(checkGuardrailsV1(ctx, "test-agent", "sell")).toBeNull();
  });

  it("checkGuardrailsV2 blocks throttled action during transit", () => {
    const transitThrottle = new TransitThrottle(30_000);
    const statusCache = new Map<string, StatusCacheEntry>();
    statusCache.set("test-agent", makeTransitEntry());

    const ctx = makePipelineCtx({ transitThrottle, statusCache });

    // First call allowed
    const result1 = checkGuardrailsV2(ctx, "test-agent", "spacemolt", "get_location");
    expect(result1).toBeNull();

    // Second call blocked (action is "get_location")
    const result2 = checkGuardrailsV2(ctx, "test-agent", "spacemolt", "get_location");
    expect(result2).not.toBeNull();
    expect(JSON.parse(result2!).in_transit).toBe(true);
  });

  it("checkGuardrailsV2 checks action name, not wrapper tool name", () => {
    const transitThrottle = new TransitThrottle(30_000);
    const statusCache = new Map<string, StatusCacheEntry>();
    statusCache.set("test-agent", makeTransitEntry());

    const ctx = makePipelineCtx({ transitThrottle, statusCache });

    // "spacemolt" is the wrapper — should NOT be throttled on its own
    // "get_system" is the action — should be throttled
    expect(checkGuardrailsV2(ctx, "test-agent", "spacemolt", "get_system")).toBeNull();
    const blocked = checkGuardrailsV2(ctx, "test-agent", "spacemolt", "get_system");
    expect(JSON.parse(blocked!).in_transit).toBe(true);
  });

  it("guardrails allow through when no transitThrottle configured", () => {
    const statusCache = new Map<string, StatusCacheEntry>();
    statusCache.set("test-agent", makeTransitEntry());

    // No transitThrottle in context
    const ctx = makePipelineCtx({ statusCache });

    // First call always allowed
    expect(checkGuardrailsV1(ctx, "test-agent", "get_location")).toBeNull();
    // Second identical call is blocked by DUPLICATE detection, not transit throttle
    const result = checkGuardrailsV1(ctx, "test-agent", "get_location");
    // If blocked, it should be duplicate detection, not transit
    if (result !== null) {
      expect(result).toContain("Duplicate");
      expect(result).not.toContain("in_transit");
    }
  });

  it("throttle response is JSON with transit data, not an error message", () => {
    const transitThrottle = new TransitThrottle(30_000);
    const statusCache = new Map<string, StatusCacheEntry>();
    statusCache.set("test-agent", makeTransitEntry());

    const ctx = makePipelineCtx({ transitThrottle, statusCache });

    // First call allowed
    checkGuardrailsV1(ctx, "test-agent", "get_location");
    // Second call returns cached transit status as JSON
    const result = checkGuardrailsV2(ctx, "test-agent", "spacemolt", "get_location");
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.in_transit).toBe(true);
    expect(parsed._cached).toBe(true);
    expect(parsed.system).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Persistence across session restarts
// ---------------------------------------------------------------------------

describe("transit throttle persistence across session restarts", () => {
  beforeEach(() => {
    createDatabase(":memory:");
  });

  afterEach(() => {
    closeDb();
  });

  it("shared throttle persists state when pipelineCtx is recreated (simulates new MCP session)", () => {
    // This tests the fix: a single TransitThrottle instance shared across
    // multiple PipelineContext instances (one per MCP session/connection).
    const sharedThrottle = new TransitThrottle(30_000);
    const statusCache = new Map<string, StatusCacheEntry>();
    statusCache.set("test-agent", makeTransitEntry());

    // Session 1: agent calls get_location, uses up the allowance
    const ctx1 = makePipelineCtx({ transitThrottle: sharedThrottle, statusCache });
    expect(checkGuardrailsV1(ctx1, "test-agent", "get_location")).toBeNull(); // allowed

    // Session 2: agent starts a new turn (new PipelineContext), same shared throttle
    const ctx2 = makePipelineCtx({ transitThrottle: sharedThrottle, statusCache });
    const result = checkGuardrailsV1(ctx2, "test-agent", "get_location");

    // Should still be blocked — throttle state survived the "session restart"
    expect(result).not.toBeNull();
    expect(JSON.parse(result!).in_transit).toBe(true);
  });

  it("per-session throttle (bug: new instance) does NOT persist across sessions", () => {
    // Documents the old buggy behavior for contrast.
    // With per-session throttle, each new context gets a fresh throttle → no blocking.
    const statusCache = new Map<string, StatusCacheEntry>();
    statusCache.set("test-agent", makeTransitEntry());

    // Session 1: agent uses up the allowance
    const ctx1 = makePipelineCtx({ transitThrottle: new TransitThrottle(30_000), statusCache });
    expect(checkGuardrailsV1(ctx1, "test-agent", "get_location")).toBeNull();

    // Session 2: new context with NEW throttle instance (the old bug)
    const ctx2 = makePipelineCtx({ transitThrottle: new TransitThrottle(30_000), statusCache });
    const result = checkGuardrailsV1(ctx2, "test-agent", "get_location");

    // NOT blocked — old behavior: each session gets a fresh slate
    expect(result).toBeNull();
  });

  it("shared throttle clears agent state when agent exits transit (even across sessions)", () => {
    const sharedThrottle = new TransitThrottle(30_000);
    const statusCache = new Map<string, StatusCacheEntry>();
    statusCache.set("test-agent", makeTransitEntry());

    // Session 1: use the allowance during transit
    const ctx1 = makePipelineCtx({ transitThrottle: sharedThrottle, statusCache });
    expect(checkGuardrailsV1(ctx1, "test-agent", "get_location")).toBeNull();
    expect(checkGuardrailsV1(ctx1, "test-agent", "get_location")).not.toBeNull(); // blocked

    // Agent arrives — update cache to show POI
    statusCache.set("test-agent", makeStatusEntry());

    // Session 2: agent is now at a POI — throttle should clear and allow
    const ctx2 = makePipelineCtx({ transitThrottle: sharedThrottle, statusCache });
    expect(checkGuardrailsV1(ctx2, "test-agent", "get_location")).toBeNull(); // allowed — arrived
    // Use get_system (different tool, avoids duplicate detection) to verify no throttle at POI
    expect(checkGuardrailsV1(ctx2, "test-agent", "get_system")).toBeNull(); // still allowed — not throttled
  });

  it("shared throttle tracks multiple agents independently across sessions", () => {
    const sharedThrottle = new TransitThrottle(30_000);
    const statusCache = new Map<string, StatusCacheEntry>();
    statusCache.set("agent-a", makeTransitEntry());
    statusCache.set("agent-b", makeTransitEntry());

    // Both agents use up their allowance in session 1
    const ctx1 = makePipelineCtx({ transitThrottle: sharedThrottle, statusCache });
    expect(checkGuardrailsV1(ctx1, "agent-a", "get_location")).toBeNull();
    expect(checkGuardrailsV1(ctx1, "agent-b", "get_location")).toBeNull();

    // Session 2: both should still be throttled
    const ctx2 = makePipelineCtx({ transitThrottle: sharedThrottle, statusCache });
    expect(checkGuardrailsV1(ctx2, "agent-a", "get_location")).not.toBeNull();
    expect(checkGuardrailsV1(ctx2, "agent-b", "get_location")).not.toBeNull();
  });
});

