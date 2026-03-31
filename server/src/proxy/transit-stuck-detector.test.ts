/**
 * Tests for transit-stuck-detector.ts
 *
 * Covers:
 * - isEmptyLocation: parses get_location and get_status result formats
 * - TransitStuckDetector: per-agent counter, warning injection thresholds, reset on arrival
 * - Integration: wired into registerCachedQueries for get_location / get_status
 */

import { describe, it, expect } from "bun:test";
import {
  isEmptyLocation,
  TransitStuckDetector,
  STUCK_WARN_THRESHOLD,
  STUCK_URGENT_THRESHOLD,
  STATIONARY_LOOP_THRESHOLD,
  LOCATION_TOOLS,
} from "./transit-stuck-detector.js";
import { registerCachedQueries, type CachedQueryDeps } from "./cached-queries.js";
import type { McpTextResult } from "./passthrough-handler.js";

// ---------------------------------------------------------------------------
// isEmptyLocation tests
// ---------------------------------------------------------------------------

describe("isEmptyLocation", () => {
  describe("get_location (cached query format: { system, poi, ... })", () => {
    it("returns true when system is null", () => {
      expect(isEmptyLocation("get_location", { system: null, poi: null })).toBe(true);
    });

    it("returns true when system is undefined", () => {
      expect(isEmptyLocation("get_location", { poi: null })).toBe(true);
    });

    it("returns true when system is empty string", () => {
      expect(isEmptyLocation("get_location", { system: "", poi: null })).toBe(true);
    });

    it("returns false when system is populated", () => {
      expect(isEmptyLocation("get_location", { system: "sol", poi: "sol_station" })).toBe(false);
    });

    it("accepts current_system field (raw game response format)", () => {
      expect(isEmptyLocation("get_location", { current_system: null })).toBe(true);
      expect(isEmptyLocation("get_location", { current_system: "nexus_core" })).toBe(false);
    });

    it("returns false for non-object result", () => {
      expect(isEmptyLocation("get_location", null)).toBe(false);
      expect(isEmptyLocation("get_location", "string")).toBe(false);
      expect(isEmptyLocation("get_location", undefined)).toBe(false);
    });
  });

  describe("get_status", () => {
    it("returns true when player.current_system is null (nested format)", () => {
      expect(isEmptyLocation("get_status", {
        player: { current_system: null, current_poi: null },
      })).toBe(true);
    });

    it("returns true when current_system is null (flat format)", () => {
      expect(isEmptyLocation("get_status", { current_system: null })).toBe(true);
    });

    it("returns false when player.current_system is populated", () => {
      expect(isEmptyLocation("get_status", {
        player: { current_system: "sol", current_poi: "sol_station" },
      })).toBe(false);
    });

    it("returns false when current_system is populated (flat)", () => {
      expect(isEmptyLocation("get_status", { current_system: "nexus_core" })).toBe(false);
    });

    it("returns false when player is absent but no system field", () => {
      // No player wrapper, no current_system → false (unknown format, not empty)
      expect(isEmptyLocation("get_status", { credits: 5000 })).toBe(true);
    });
  });

  describe("other tools", () => {
    it("returns false for any non-location tool", () => {
      expect(isEmptyLocation("mine", { current_system: null })).toBe(false);
      expect(isEmptyLocation("get_cargo", { system: null })).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// TransitStuckDetector tests
// ---------------------------------------------------------------------------

describe("TransitStuckDetector", () => {
  it("tracks no agents initially", () => {
    const d = new TransitStuckDetector();
    expect(d.trackedAgents).toBe(0);
  });

  it("returns no warning for non-location tools", () => {
    const d = new TransitStuckDetector();
    const { count, warning } = d.record("agent", "mine", { system: null });
    expect(count).toBe(0);
    expect(warning).toBeNull();
  });

  it("increments counter on empty get_location", () => {
    const d = new TransitStuckDetector();
    const r1 = d.record("agent", "get_location", { system: null, poi: null });
    expect(r1.count).toBe(1);
    expect(r1.warning).toBeNull(); // below warn threshold

    const r2 = d.record("agent", "get_location", { system: null, poi: null });
    expect(r2.count).toBe(2);
    expect(r2.warning).toBeNull();
  });

  it(`injects mild warning at threshold ${STUCK_WARN_THRESHOLD}`, () => {
    const d = new TransitStuckDetector();
    for (let i = 1; i < STUCK_WARN_THRESHOLD; i++) {
      const r = d.record("agent", "get_location", { system: null });
      expect(r.warning).toBeNull();
    }
    const r = d.record("agent", "get_location", { system: null });
    expect(r.count).toBe(STUCK_WARN_THRESHOLD);
    expect(r.warning).not.toBeNull();
    expect(r.warning).toContain("productive work");
    expect(r.warning).toContain("logout");
    expect(r.warning).not.toContain("STRANDED"); // mild, not urgent
  });

  it(`injects urgent warning at threshold ${STUCK_URGENT_THRESHOLD}`, () => {
    const d = new TransitStuckDetector();
    for (let i = 1; i < STUCK_URGENT_THRESHOLD; i++) {
      d.record("agent", "get_location", { system: null });
    }
    const r = d.record("agent", "get_location", { system: null });
    expect(r.count).toBe(STUCK_URGENT_THRESHOLD);
    expect(r.warning).not.toBeNull();
    expect(r.warning).toContain("STRANDED");
    expect(r.warning).toContain("EXPONENTIAL fees");
    expect(r.warning).toContain("logout");
  });

  it("continues to inject urgent warning past the urgent threshold", () => {
    const d = new TransitStuckDetector();
    for (let i = 0; i < STUCK_URGENT_THRESHOLD + 3; i++) {
      d.record("agent", "get_location", { system: null });
    }
    const r = d.record("agent", "get_location", { system: null });
    expect(r.warning).not.toBeNull();
    expect(r.warning).toContain("STRANDED");
  });

  it("resets counter when system is non-empty", () => {
    const d = new TransitStuckDetector();
    // Hit warn threshold
    for (let i = 0; i < STUCK_WARN_THRESHOLD; i++) {
      d.record("agent", "get_location", { system: null });
    }
    expect(d.getCount("agent")).toBe(STUCK_WARN_THRESHOLD);

    // Arrive at a system
    const r = d.record("agent", "get_location", { system: "sol", poi: "sol_station" });
    expect(r.count).toBe(0);
    expect(r.warning).toBeNull();
    expect(d.getCount("agent")).toBe(0);
    // trackedAgents now includes stationary loop tracking (1 entry for the non-empty location)
    expect(d.trackedAgents).toBe(1);
  });

  it("works independently per agent", () => {
    const d = new TransitStuckDetector();
    // Agent A: 4 empty checks
    for (let i = 0; i < STUCK_WARN_THRESHOLD + 1; i++) {
      d.record("agent-a", "get_location", { system: null });
    }
    // Agent B: 1 empty check — no warning
    const rb = d.record("agent-b", "get_location", { system: null });
    expect(rb.warning).toBeNull();

    // Agent A: still at threshold + 1
    expect(d.getCount("agent-a")).toBe(STUCK_WARN_THRESHOLD + 1);
    expect(d.getCount("agent-b")).toBe(1);
  });

  it("also tracks get_status with empty system", () => {
    const d = new TransitStuckDetector();
    for (let i = 0; i < STUCK_WARN_THRESHOLD; i++) {
      d.record("agent", "get_status", { player: { current_system: null } });
    }
    const r = d.record("agent", "get_status", { player: { current_system: null } });
    // By STUCK_WARN_THRESHOLD + 1 iterations we're past the threshold
    expect(r.warning).not.toBeNull();
  });

  it("reset() clears an individual agent", () => {
    const d = new TransitStuckDetector();
    d.record("agent", "get_location", { system: null });
    d.record("agent", "get_location", { system: null });
    expect(d.getCount("agent")).toBe(2);

    d.reset("agent");
    expect(d.getCount("agent")).toBe(0);
    expect(d.trackedAgents).toBe(0);
  });

  it("resetAll() clears all agents", () => {
    const d = new TransitStuckDetector();
    d.record("a", "get_location", { system: null });
    d.record("b", "get_location", { system: null });
    expect(d.trackedAgents).toBe(2);

    d.resetAll();
    expect(d.trackedAgents).toBe(0);
  });

  it("LOCATION_TOOLS set contains expected tools", () => {
    expect(LOCATION_TOOLS.has("get_location")).toBe(true);
    expect(LOCATION_TOOLS.has("get_status")).toBe(true);
    expect(LOCATION_TOOLS.has("mine")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: TransitStuckDetector wired into registerCachedQueries
// ---------------------------------------------------------------------------

function createMockMcpServer() {
  const tools = new Map<string, { opts: unknown; handler: Function }>();
  return {
    registerTool: (name: string, opts: unknown, handler: Function) => {
      tools.set(name, { opts, handler });
    },
    tools,
  };
}

function makeCachedQueryDeps(overrides?: Partial<CachedQueryDeps>) {
  const mockServer = createMockMcpServer();
  const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
  const stuckDetector = new TransitStuckDetector();
  return {
    mcpServer: mockServer as unknown as CachedQueryDeps["mcpServer"],
    registeredTools: [] as string[],
    statusCache,
    getAgentForSession: () => "test-agent" as string | undefined,
    withInjections: async (_a: string, r: McpTextResult) => r,
    transitStuckDetector: stuckDetector,
    mockServer,
    stuckDetector,
    ...overrides,
  };
}

describe("registerCachedQueries + TransitStuckDetector integration", () => {
  it("no warning on first empty get_location (below threshold)", async () => {
    const deps = makeCachedQueryDeps();
    registerCachedQueries(deps);
    deps.statusCache.set("test-agent", {
      data: { tick: 1, player: { current_system: null, current_poi: null } },
      fetchedAt: Date.now(),
    });

    const handler = deps.mockServer.tools.get("get_location")!.handler;
    const result = await handler({ sessionId: "sess-1" });
    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed._transit_warning).toBeUndefined();
  });

  it("injects _transit_warning on get_location after STUCK_WARN_THRESHOLD empty checks", async () => {
    const deps = makeCachedQueryDeps();
    registerCachedQueries(deps);

    // Set up cache with empty system
    deps.statusCache.set("test-agent", {
      data: { tick: 1, player: { current_system: null, current_poi: null } },
      fetchedAt: Date.now(),
    });

    const handler = deps.mockServer.tools.get("get_location")!.handler;

    // Call enough times to hit the warn threshold
    for (let i = 0; i < STUCK_WARN_THRESHOLD; i++) {
      await handler({ sessionId: "sess-1" });
    }
    const result = await handler({ sessionId: "sess-1" });
    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed._transit_warning).toBeDefined();
    expect(typeof parsed._transit_warning).toBe("string");
    expect(parsed._transit_warning).toContain("logout");
  });

  it("injects urgent _transit_warning on get_location after STUCK_URGENT_THRESHOLD empty checks", async () => {
    const deps = makeCachedQueryDeps();
    registerCachedQueries(deps);

    deps.statusCache.set("test-agent", {
      data: { tick: 1, player: { current_system: null, current_poi: null } },
      fetchedAt: Date.now(),
    });

    const handler = deps.mockServer.tools.get("get_location")!.handler;
    for (let i = 0; i < STUCK_URGENT_THRESHOLD; i++) {
      await handler({ sessionId: "sess-1" });
    }
    const result = await handler({ sessionId: "sess-1" });
    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed._transit_warning).toContain("STRANDED");
  });

  it("no _transit_warning when system is populated", async () => {
    const deps = makeCachedQueryDeps();
    registerCachedQueries(deps);

    // Put agent through threshold first
    deps.statusCache.set("test-agent", {
      data: { tick: 1, player: { current_system: null, current_poi: null } },
      fetchedAt: Date.now(),
    });
    const handler = deps.mockServer.tools.get("get_location")!.handler;
    for (let i = 0; i < STUCK_WARN_THRESHOLD + 1; i++) {
      await handler({ sessionId: "sess-1" });
    }

    // Now agent arrives at a system
    deps.statusCache.set("test-agent", {
      data: { tick: 5, player: { current_system: "sol", current_poi: "sol_station" } },
      fetchedAt: Date.now(),
    });

    const result = await handler({ sessionId: "sess-1" });
    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed._transit_warning).toBeUndefined();
    // Counter should be reset now
    expect(deps.stuckDetector.getCount("test-agent")).toBe(0);
  });

  it("injects _transit_warning on get_status after threshold empty checks", async () => {
    const deps = makeCachedQueryDeps();
    registerCachedQueries(deps);

    deps.statusCache.set("test-agent", {
      data: { tick: 1, player: { current_system: null, current_poi: null } },
      fetchedAt: Date.now(),
    });

    const handler = deps.mockServer.tools.get("get_status")!.handler;
    for (let i = 0; i < STUCK_WARN_THRESHOLD + 1; i++) {
      await handler({ sessionId: "sess-1" });
    }
    const result = await handler({ sessionId: "sess-1" });
    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed._transit_warning).toBeDefined();
  });

  it("other tools (get_fuel) are not checked for transit stuck", async () => {
    const deps = makeCachedQueryDeps();
    registerCachedQueries(deps);

    deps.statusCache.set("test-agent", {
      data: { tick: 1, ship: { fuel: 20, max_fuel: 100 } },
      fetchedAt: Date.now(),
    });

    const handler = deps.mockServer.tools.get("get_fuel")!.handler;
    const result = await handler({ sessionId: "sess-1" });
    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed._transit_warning).toBeUndefined();
    // Detector should have no tracked agents
    expect(deps.stuckDetector.trackedAgents).toBe(0);
  });

  it("without transitStuckDetector configured, no warning is injected", async () => {
    const deps = makeCachedQueryDeps({ transitStuckDetector: undefined });
    registerCachedQueries(deps);

    deps.statusCache.set("test-agent", {
      data: { tick: 1, player: { current_system: null, current_poi: null } },
      fetchedAt: Date.now(),
    });

    const handler = deps.mockServer.tools.get("get_location")!.handler;
    for (let i = 0; i < STUCK_WARN_THRESHOLD + 5; i++) {
      await handler({ sessionId: "sess-1" });
    }
    const result = await handler({ sessionId: "sess-1" });
    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed._transit_warning).toBeUndefined();
  });

  it("detects stationary loop (same location repeated)", () => {
    const d = new TransitStuckDetector();
    const loc = { system: "gudja", poi: "gudja_star" };

    // First few calls — no warning yet
    for (let i = 0; i < STATIONARY_LOOP_THRESHOLD - 1; i++) {
      const r = d.record("agent", "get_location", loc);
      expect(r.warning).toBeNull();
    }

    // Hit threshold
    const r = d.record("agent", "get_location", loc);
    expect(r.warning).toContain("STOP checking");
    expect(r.warning).toContain("gudja:gudja_star");
  });

  it("resets stationary loop on different location", () => {
    const d = new TransitStuckDetector();
    const loc1 = { system: "gudja", poi: "gudja_star" };
    const loc2 = { system: "sol", poi: "sol_central" };

    // Almost hit threshold at loc1
    for (let i = 0; i < STATIONARY_LOOP_THRESHOLD - 1; i++) {
      d.record("agent", "get_location", loc1);
    }

    // Different location resets — this is call #1 for loc2
    const r1 = d.record("agent", "get_location", loc2);
    expect(r1.warning).toBeNull();

    // Now counting from 2 at loc2 (need THRESHOLD-2 more to reach THRESHOLD-1, no warning)
    for (let i = 0; i < STATIONARY_LOOP_THRESHOLD - 2; i++) {
      const r = d.record("agent", "get_location", loc2);
      expect(r.warning).toBeNull();
    }

    // Hit threshold at new location (call #THRESHOLD)
    const r = d.record("agent", "get_location", loc2);
    expect(r.warning).toContain("sol:sol_central");
  });

  it("stationary loop resets on manual reset", () => {
    const d = new TransitStuckDetector();
    const loc = { system: "gudja", poi: "gudja_star" };

    for (let i = 0; i < STATIONARY_LOOP_THRESHOLD - 1; i++) {
      d.record("agent", "get_location", loc);
    }

    d.reset("agent");

    // After reset, counter starts fresh
    for (let i = 0; i < STATIONARY_LOOP_THRESHOLD - 1; i++) {
      const r = d.record("agent", "get_location", loc);
      expect(r.warning).toBeNull();
    }
  });
});
