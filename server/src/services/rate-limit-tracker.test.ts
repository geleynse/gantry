/**
 * Tests for RateLimitTracker service.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  RateLimitTracker,
  GAME_RATE_LIMIT,
  resolveIpLabel,
  buildTrackerDeps,
  resetTracker,
  initTracker,
  getTracker,
} from "./rate-limit-tracker.js";
import type { RateLimitTrackerDeps } from "./rate-limit-tracker.js";
import type { GantryConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTracker(overrides?: Partial<RateLimitTrackerDeps>): RateLimitTracker {
  const agentToIp = new Map([
    ["drifter-gale", "direct"],
    ["rust-vane", "direct"],
    ["cinder-wake", "socks5-1081"],
    ["sable-thorn", "socks5-1082"],
    ["lumen-shoal", "socks5-1083"],
  ]);
  const ipToAgents = new Map([
    ["direct", ["drifter-gale", "rust-vane"]],
    ["socks5-1081", ["cinder-wake"]],
    ["socks5-1082", ["sable-thorn"]],
    ["socks5-1083", ["lumen-shoal"]],
  ]);

  return new RateLimitTracker({ agentToIp, ipToAgents, ...overrides });
}

function makeConfig(): GantryConfig {
  return {
    agents: [
      { name: "drifter-gale" },
      { name: "rust-vane" },
      { name: "cinder-wake", proxy: "general", socksPort: 1081 },
      { name: "sable-thorn", proxy: "micro", socksPort: 1082 },
      { name: "lumen-shoal", proxy: "bastion", socksPort: 1083 },
    ],
    // Minimal required fields
    gameUrl: "ws://localhost:9999",
    gameApiUrl: "http://localhost:9999",
    turnSleepMs: 90_000,
    staggerDelay: 20_000,
    mockMode: { enabled: false },
  } as unknown as GantryConfig;
}

// ---------------------------------------------------------------------------
// resolveIpLabel
// ---------------------------------------------------------------------------

describe("resolveIpLabel", () => {
  it("returns 'direct' for agents with no proxy", () => {
    expect(resolveIpLabel({})).toBe("direct");
    expect(resolveIpLabel({ proxy: undefined })).toBe("direct");
  });

  it("returns 'socks5-{port}' for agents with socksPort", () => {
    expect(resolveIpLabel({ proxy: "general", socksPort: 1081 })).toBe("socks5-1081");
    expect(resolveIpLabel({ proxy: "micro", socksPort: 1082 })).toBe("socks5-1082");
    expect(resolveIpLabel({ proxy: "bastion", socksPort: 1083 })).toBe("socks5-1083");
  });

  it("returns proxy-{name} fallback when no socksPort", () => {
    expect(resolveIpLabel({ proxy: "unknown" })).toBe("proxy-unknown");
  });
});

// ---------------------------------------------------------------------------
// buildTrackerDeps
// ---------------------------------------------------------------------------

describe("buildTrackerDeps", () => {
  it("maps agents to correct IP labels", () => {
    const config = makeConfig();
    const deps = buildTrackerDeps(config);
    expect(deps.agentToIp.get("drifter-gale")).toBe("direct");
    expect(deps.agentToIp.get("rust-vane")).toBe("direct");
    expect(deps.agentToIp.get("cinder-wake")).toBe("socks5-1081");
    expect(deps.agentToIp.get("sable-thorn")).toBe("socks5-1082");
    expect(deps.agentToIp.get("lumen-shoal")).toBe("socks5-1083");
  });

  it("groups agents by IP correctly", () => {
    const config = makeConfig();
    const deps = buildTrackerDeps(config);
    expect(deps.ipToAgents.get("direct")).toEqual(["drifter-gale", "rust-vane"]);
    expect(deps.ipToAgents.get("socks5-1081")).toEqual(["cinder-wake"]);
  });
});

// ---------------------------------------------------------------------------
// RateLimitTracker.recordRequest / getSnapshot
// ---------------------------------------------------------------------------

describe("RateLimitTracker", () => {
  let now: number;

  beforeEach(() => {
    now = Date.now();
  });

  it("returns correct limit and window_seconds", () => {
    const tracker = makeTracker({ now: () => now });
    const snap = tracker.getSnapshot();
    expect(snap.limit).toBe(GAME_RATE_LIMIT);
    expect(snap.window_seconds).toBe(60);
  });

  it("starts with zero RPM for all agents and IPs", () => {
    const tracker = makeTracker({ now: () => now });
    const snap = tracker.getSnapshot();

    expect(snap.by_agent["drifter-gale"].rpm).toBe(0);
    expect(snap.by_agent["cinder-wake"].rpm).toBe(0);
    expect(snap.by_ip["direct"].rpm).toBe(0);
    expect(snap.by_ip["socks5-1081"].rpm).toBe(0);
  });

  it("counts requests in current minute", () => {
    const tracker = makeTracker({ now: () => now });
    tracker.recordRequest("drifter-gale", "jump");
    tracker.recordRequest("drifter-gale", "get_status");
    tracker.recordRequest("rust-vane", "mine");

    const snap = tracker.getSnapshot();
    expect(snap.by_agent["drifter-gale"].rpm).toBe(2);
    expect(snap.by_agent["rust-vane"].rpm).toBe(1);
    expect(snap.by_ip["direct"].rpm).toBe(3);
  });

  it("does not count requests from previous minutes in current RPM", () => {
    // Start in minute N
    let t = now;
    const tracker = makeTracker({ now: () => t });

    tracker.recordRequest("drifter-gale", "jump");

    // Advance to minute N+1
    t = now + 61_000;
    tracker.recordRequest("drifter-gale", "mine");

    const snap = tracker.getSnapshot();
    // Only the current minute's request should count in rpm
    expect(snap.by_agent["drifter-gale"].rpm).toBe(1);
  });

  it("tracks 429 events and rate_limited count", () => {
    const tracker = makeTracker({ now: () => now });
    tracker.recordRequest("rust-vane", "sell", true);
    tracker.recordRequest("rust-vane", "buy", true);

    const snap = tracker.getSnapshot();
    expect(snap.by_agent["rust-vane"].rate_limited).toBe(2);
    expect(snap.by_agent["rust-vane"].last_429).not.toBeNull();
    expect(snap.recent_429s).toHaveLength(2);
    // Most recent first
    expect(snap.recent_429s[0].tool).toBe("buy");
  });

  it("captures agent and tool in 429 events", () => {
    const tracker = makeTracker({ now: () => now });
    tracker.recordRequest("sable-thorn", "attack", true);

    const snap = tracker.getSnapshot();
    const ev = snap.recent_429s[0];
    expect(ev.agent).toBe("sable-thorn");
    expect(ev.tool).toBe("attack");
    expect(typeof ev.timestamp).toBe("string");
  });

  it("history array has HISTORY_WINDOW_MINUTES entries", () => {
    const tracker = makeTracker({ now: () => now });
    const snap = tracker.getSnapshot();
    expect(snap.by_ip["direct"].history).toHaveLength(10);
  });

  it("history reflects past minute counts", () => {
    let t = now;
    const tracker = makeTracker({ now: () => t });

    // Record in minute 0
    tracker.recordRequest("drifter-gale", "jump");
    tracker.recordRequest("drifter-gale", "mine");

    // Advance 1 minute
    t = now + 60_000;
    tracker.recordRequest("drifter-gale", "sell");

    const snap = tracker.getSnapshot();
    // history[9] = current minute = 1 request
    // history[8] = previous minute = 2 requests
    expect(snap.by_ip["direct"].history[9]).toBe(1);
    expect(snap.by_ip["direct"].history[8]).toBe(2);
  });

  it("agents list in by_ip matches config", () => {
    const tracker = makeTracker({ now: () => now });
    const snap = tracker.getSnapshot();
    expect(snap.by_ip["direct"].agents).toEqual(["drifter-gale", "rust-vane"]);
    expect(snap.by_ip["socks5-1081"].agents).toEqual(["cinder-wake"]);
  });

  it("prunes records older than 10 minutes", () => {
    let t = now;
    const tracker = makeTracker({ now: () => t });

    tracker.recordRequest("drifter-gale", "jump");

    // Advance 11 minutes — record should be pruned
    t = now + 11 * 60_000;
    tracker.recordRequest("drifter-gale", "mine"); // trigger prune

    const snap = tracker.getSnapshot();
    // history[9] has 1 (current), rest zero. The original should be gone.
    expect(snap.by_agent["drifter-gale"].rpm).toBe(1);
  });

  it("recent_429s is empty when no 429s recorded", () => {
    const tracker = makeTracker({ now: () => now });
    tracker.recordRequest("drifter-gale", "jump"); // success
    expect(tracker.getSnapshot().recent_429s).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Singleton: initTracker / getTracker / resetTracker
// ---------------------------------------------------------------------------

describe("singleton tracker", () => {
  beforeEach(() => {
    resetTracker();
  });

  it("getTracker returns null before init", () => {
    expect(getTracker()).toBeNull();
  });

  it("initTracker creates and returns a tracker", () => {
    const config = makeConfig();
    const tracker = initTracker(config);
    expect(tracker).toBeInstanceOf(RateLimitTracker);
    expect(getTracker()).toBe(tracker);
  });

  it("initTracker is idempotent — returns same instance on second call", () => {
    const config = makeConfig();
    const t1 = initTracker(config);
    const t2 = initTracker(config);
    expect(t1).toBe(t2);
  });

  it("resetTracker clears the singleton", () => {
    initTracker(makeConfig());
    resetTracker();
    expect(getTracker()).toBeNull();
  });
});
