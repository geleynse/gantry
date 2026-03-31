import { describe, it, expect } from "bun:test";
import { SessionManager } from "./session-manager.js";
import { BreakerRegistry } from "./circuit-breaker.js";
import { MetricsWindow } from "./instability-metrics.js";
import { createMockConfig } from "../test/helpers.js";

const testConfig = createMockConfig({
  agents: [
    { name: "test-agent", proxy: "general", socksPort: 1081 },
    { name: "test-direct" },
  ],
  gameUrl: "https://game.spacemolt.com/mcp",
  gameApiUrl: "https://game.spacemolt.com/api/v1",
});

describe("SessionManager", () => {
  it("creates a GameClient with SOCKS for proxied agents", () => {
    const mgr = new SessionManager(testConfig, new BreakerRegistry(), new MetricsWindow());
    const client = mgr.getOrCreateClient("test-agent");
    expect(client.hasSocksProxy).toBe(true);
  });

  it("creates a GameClient without SOCKS proxy for direct agents", () => {
    const mgr = new SessionManager(testConfig, new BreakerRegistry(), new MetricsWindow());
    const client = mgr.getOrCreateClient("test-direct");
    expect(client.hasSocksProxy).toBe(false);
  });

  it("reuses the same GameClient across calls", () => {
    const mgr = new SessionManager(testConfig, new BreakerRegistry(), new MetricsWindow());
    const a = mgr.getOrCreateClient("test-agent");
    const b = mgr.getOrCreateClient("test-agent");
    expect(a).toBe(b);
  });

  it("throws for unknown agents", () => {
    const mgr = new SessionManager(testConfig, new BreakerRegistry(), new MetricsWindow());
    expect(() => mgr.getOrCreateClient("nobody")).toThrow("Unknown agent");
  });

  it("lists active clients", () => {
    const mgr = new SessionManager(testConfig, new BreakerRegistry(), new MetricsWindow());
    expect(mgr.listActive()).toEqual([]);
    mgr.getOrCreateClient("test-agent");
    expect(mgr.listActive()).toEqual(["test-agent"]);
  });

  it("removes clients", () => {
    const mgr = new SessionManager(testConfig, new BreakerRegistry(), new MetricsWindow());
    mgr.getOrCreateClient("test-agent");
    mgr.removeClient("test-agent");
    expect(mgr.listActive()).toEqual([]);
    expect(mgr.getClient("test-agent")).toBeUndefined();
  });

  it("logoutAll clears all active clients", async () => {
    const mgr = new SessionManager(testConfig, new BreakerRegistry(), new MetricsWindow());
    mgr.getOrCreateClient("test-agent");
    mgr.getOrCreateClient("test-direct");
    expect(mgr.listActive()).toHaveLength(2);
    // logoutAll will fail network calls (no real server), but should still clear clients
    await mgr.logoutAll();
    expect(mgr.listActive()).toEqual([]);
  });

  it("records activity on getOrCreateClient", () => {
    const mgr = new SessionManager(testConfig, new BreakerRegistry(), new MetricsWindow());
    expect(mgr.getLastActivity("test-agent")).toBe(0);
    const before = Date.now();
    mgr.getOrCreateClient("test-agent");
    const after = Date.now();
    const activity = mgr.getLastActivity("test-agent");
    expect(activity).toBeGreaterThanOrEqual(before);
    expect(activity).toBeLessThanOrEqual(after);
  });

  it("recordActivity updates timestamp", () => {
    const mgr = new SessionManager(testConfig, new BreakerRegistry(), new MetricsWindow());
    mgr.getOrCreateClient("test-agent");
    const firstActivity = mgr.getLastActivity("test-agent");
    mgr.recordActivity("test-agent");
    const secondActivity = mgr.getLastActivity("test-agent");
    expect(secondActivity).toBeGreaterThanOrEqual(firstActivity);
  });

  it("removeClient clears activity tracking", () => {
    const mgr = new SessionManager(testConfig, new BreakerRegistry(), new MetricsWindow());
    mgr.getOrCreateClient("test-agent");
    expect(mgr.getLastActivity("test-agent")).toBeGreaterThan(0);
    mgr.removeClient("test-agent");
    expect(mgr.getLastActivity("test-agent")).toBe(0);
  });

  it("logoutAll skips stale sessions (no activity recorded)", async () => {
    const mgr = new SessionManager(testConfig, new BreakerRegistry(), new MetricsWindow());
    // Manually add client without recording activity by calling getOrCreateClient
    // then resetting last activity via a very short threshold
    mgr.getOrCreateClient("test-agent");
    mgr.getOrCreateClient("test-direct");
    expect(mgr.listActive()).toHaveLength(2);
    // Use 0ms threshold so all sessions appear stale
    const start = Date.now();
    await mgr.logoutAll(5_000, 0);
    const elapsed = Date.now() - start;
    // Should complete very quickly (no network calls for stale sessions)
    expect(elapsed).toBeLessThan(1_000);
    expect(mgr.listActive()).toEqual([]);
  });

  it("logoutAll completes within timeout for sessions with no network", async () => {
    const mgr = new SessionManager(testConfig, new BreakerRegistry(), new MetricsWindow());
    mgr.getOrCreateClient("test-agent");
    mgr.getOrCreateClient("test-direct");
    // Simulate recently-active sessions by recording activity
    mgr.recordActivity("test-agent");
    mgr.recordActivity("test-direct");
    const start = Date.now();
    // Use 200ms timeout so it fails fast (no real server)
    await mgr.logoutAll(200, 60_000); // 60s threshold means sessions are NOT stale
    const elapsed = Date.now() - start;
    // Should complete within 2s even with per-session timeout of 200ms
    expect(elapsed).toBeLessThan(2_000);
    expect(mgr.listActive()).toEqual([]);
  });
});
