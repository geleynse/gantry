import { describe, it, expect } from "bun:test";
import {
  generateInstabilityHint,
  generatePendingHint,
  checkToolBlocked,
} from "./instability-hints.js";
import type { HealthMetrics } from "./instability-metrics.js";

function makeMetrics(overrides: Partial<HealthMetrics> = {}): HealthMetrics {
  return {
    window: { startTime: Date.now() - 600_000, durationMs: 600_000 },
    errors: { total: 0, count504: 0, count503: 0, count502: 0, count409: 0, countTimeout: 0, countRateLimit: 0, countConnection: 0, countOther: 0 },
    requests: { total: 100, successful: 100 },
    circuitBreaker: { state: "closed", consecutiveErrors: 0 },
    status: "healthy",
    reason: "",
    ...overrides,
  };
}

describe("generateInstabilityHint", () => {
  it("returns empty string for healthy status", () => {
    expect(generateInstabilityHint(makeMetrics())).toBe("");
  });

  it("returns degradation notice for degraded status", () => {
    const hint = generateInstabilityHint(makeMetrics({
      status: "degraded",
      errors: { total: 4, count504: 4, count503: 0, count502: 0, count409: 0, countTimeout: 0, countRateLimit: 0, countConnection: 0, countOther: 0 },
      requests: { total: 100, successful: 96 },
    }));
    expect(hint).toContain("4.0%");
    expect(hint).toContain("Continue your session normally");
  });

  it("returns instability notice for unstable status", () => {
    const hint = generateInstabilityHint(makeMetrics({
      status: "unstable",
      errors: { total: 12, count504: 12, count503: 0, count502: 0, count409: 0, countTimeout: 0, countRateLimit: 0, countConnection: 0, countOther: 0 },
      requests: { total: 100, successful: 88 },
    }));
    expect(hint).toContain("12.0%");
    expect(hint).toContain("Continue your session");
  });

  it("returns server down notice for down status", () => {
    const hint = generateInstabilityHint(makeMetrics({
      status: "down",
      reason: "No successful calls in 120s",
    }));
    expect(hint).toContain("SERVER DOWN");
    expect(hint).toContain("No successful calls");
  });

  it("includes error rate in degraded hint", () => {
    const hint = generateInstabilityHint(makeMetrics({
      status: "degraded",
      errors: { total: 3, count504: 3, count503: 0, count502: 0, count409: 0, countTimeout: 0, countRateLimit: 0, countConnection: 0, countOther: 0 },
      requests: { total: 100, successful: 97 },
    }));
    expect(hint).toContain("3.0%");
  });
});

describe("generatePendingHint", () => {
  it("includes retry count and wait time", () => {
    const hint = generatePendingHint(2, 5);
    expect(hint).toContain("retry 2");
    expect(hint).toContain("5s");
    expect(hint).toContain("Action Pending");
  });
});

describe("checkToolBlocked", () => {
  it("returns empty for healthy status", () => {
    expect(checkToolBlocked("mine", "healthy")).toBe("");
  });

  it("returns empty for degraded status", () => {
    expect(checkToolBlocked("mine", "degraded")).toBe("");
  });

  it("does NOT block non-safe tools when unstable (warn only)", () => {
    // unstable no longer blocks tools — only "down" blocks
    const result = checkToolBlocked("mine", "unstable");
    expect(result).toBe("");
  });

  it("blocks non-safe tools when down", () => {
    const result = checkToolBlocked("sell", "down");
    expect(result).toContain("down");
    expect(result).toContain("sell");
  });

  it("allows safe tools when unstable", () => {
    expect(checkToolBlocked("get_status", "unstable")).toBe("");
    expect(checkToolBlocked("get_cargo", "unstable")).toBe("");
    expect(checkToolBlocked("get_location", "unstable")).toBe("");
    expect(checkToolBlocked("get_system", "unstable")).toBe("");
  });

  it("allows safe tools when down", () => {
    expect(checkToolBlocked("get_status", "down")).toBe("");
    expect(checkToolBlocked("login", "down")).toBe("");
    expect(checkToolBlocked("logout", "down")).toBe("");
  });

  it("does NOT block various action tools when unstable (warn only)", () => {
    for (const tool of ["attack", "buy", "craft", "explore", "jump"]) {
      expect(checkToolBlocked(tool, "unstable")).toBe("");
    }
  });

  it("allows captains_log tools when unstable", () => {
    expect(checkToolBlocked("captains_log_add", "unstable")).toBe("");
    expect(checkToolBlocked("captains_log_get", "unstable")).toBe("");
    expect(checkToolBlocked("captains_log_list", "unstable")).toBe("");
  });

  it("allows captains_log tools when down", () => {
    expect(checkToolBlocked("captains_log_add", "down")).toBe("");
    expect(checkToolBlocked("captains_log_get", "down")).toBe("");
    expect(checkToolBlocked("captains_log_list", "down")).toBe("");
  });

  it("allows write_doc, write_diary, write_report when unstable", () => {
    expect(checkToolBlocked("write_doc", "unstable")).toBe("");
    expect(checkToolBlocked("write_diary", "unstable")).toBe("");
    expect(checkToolBlocked("write_report", "unstable")).toBe("");
  });

  it("allows get_state and v2 query tools when unstable", () => {
    expect(checkToolBlocked("get_state", "unstable")).toBe("");
    expect(checkToolBlocked("v2_get_player", "unstable")).toBe("");
    expect(checkToolBlocked("v2_get_ship", "unstable")).toBe("");
    expect(checkToolBlocked("v2_get_cargo", "unstable")).toBe("");
  });
});
