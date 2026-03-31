import { describe, it, expect, beforeEach, mock } from "bun:test";

// Import after mock
import { computeServerStatus, type GameHealthRef } from "./health-status.js";
import { BreakerRegistry } from "../proxy/circuit-breaker.js";
import { MetricsWindow } from "../proxy/instability-metrics.js";

function makeHealthRef(overrides?: Partial<NonNullable<GameHealthRef["current"]>>): GameHealthRef {
  return {
    current: {
      tick: 12345,
      version: "v0.140.0",
      fetchedAt: Date.now() - 5_000, // 5s ago
      ...overrides,
    },
  };
}

describe("computeServerStatus", () => {
  let breakerRegistry: BreakerRegistry;
  let serverMetrics: MetricsWindow;
  let mockGetAggregateStatus: any;

  beforeEach(() => {
    mockGetAggregateStatus = mock(() => ({ state: "closed", failures: 0 }));
    breakerRegistry = {
      getAggregateStatus: mockGetAggregateStatus,
    } as any;
    serverMetrics = new MetricsWindow();
  });

  // --- Status: UP ---

  it("returns UP when server healthy and circuit closed", () => {
    const result = computeServerStatus(makeHealthRef(), breakerRegistry, serverMetrics);
    expect(result.status).toBe("up");
    expect(result.notes).toBe("All systems nominal");
  });

  it("includes version from health ref", () => {
    const result = computeServerStatus(makeHealthRef({ version: "v0.141.0" }), breakerRegistry, serverMetrics);
    expect(result.version).toBe("v0.141.0");
  });

  it("includes circuit breaker state", () => {
    const result = computeServerStatus(makeHealthRef(), breakerRegistry, serverMetrics);
    expect(result.circuit_breaker.state).toBe("closed");
    expect(result.circuit_breaker.consecutive_failures).toBe(0);
  });

  it("includes last_health_check as ISO string", () => {
    const ref = makeHealthRef();
    const result = computeServerStatus(ref, breakerRegistry, serverMetrics);
    expect(result.last_health_check).not.toBeNull();
    expect(new Date(result.last_health_check!).getTime()).toBeCloseTo(ref.current!.fetchedAt, -2);
  });

  it("sets check_interval_seconds to 10", () => {
    const result = computeServerStatus(makeHealthRef(), breakerRegistry, serverMetrics);
    expect(result.check_interval_seconds).toBe(10);
  });

  // --- Status: DEGRADED ---

  it("returns DEGRADED when circuit breaker is half-open", () => {
    mockGetAggregateStatus.mockReturnValue({ state: "half-open", failures: 3 });
    const result = computeServerStatus(makeHealthRef(), breakerRegistry, serverMetrics);
    expect(result.status).toBe("degraded");
    expect(result.notes).toContain("probing");
  });

  it("returns DEGRADED when health check is stale (>60s)", () => {
    const result = computeServerStatus(makeHealthRef({ fetchedAt: Date.now() - 90_000 }), breakerRegistry, serverMetrics);
    expect(result.status).toBe("degraded");
    expect(result.notes).toContain("stale");
  });

  it("returns DEGRADED when failures > 0 but circuit still closed", () => {
    mockGetAggregateStatus.mockReturnValue({ state: "closed", failures: 2 });
    const result = computeServerStatus(makeHealthRef(), breakerRegistry, serverMetrics);
    expect(result.status).toBe("degraded");
    expect(result.notes).toContain("failure");
  });

  // --- Status: DOWN ---

  it("returns DOWN when no health data received", () => {
    const result = computeServerStatus({ current: null }, breakerRegistry, serverMetrics);
    expect(result.status).toBe("down");
    expect(result.version).toBeNull();
    expect(result.last_health_check).toBeNull();
    expect(result.notes).toContain("No health data");
  });

  it("returns DOWN when health check too old (>120s)", () => {
    const result = computeServerStatus(makeHealthRef({ fetchedAt: Date.now() - 150_000 }), breakerRegistry, serverMetrics);
    expect(result.status).toBe("down");
    expect(result.notes).toContain("threshold");
  });

  it("returns DOWN when circuit breaker is open", () => {
    mockGetAggregateStatus.mockReturnValue({
      state: "open",
      failures: 3,
      cooldown_remaining_ms: 45_000,
    });
    const result = computeServerStatus(makeHealthRef(), breakerRegistry, serverMetrics);
    expect(result.status).toBe("down");
    expect(result.notes).toContain("Circuit breaker OPEN");
    expect(result.circuit_breaker.cooldown_remaining_ms).toBe(45_000);
  });

  // --- Response shape ---

  it("always includes timestamp as ISO string", () => {
    const result = computeServerStatus(makeHealthRef(), breakerRegistry, serverMetrics);
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("omits cooldown_remaining_ms when circuit is closed", () => {
    const result = computeServerStatus(makeHealthRef(), breakerRegistry, serverMetrics);
    expect(result.circuit_breaker.cooldown_remaining_ms).toBeUndefined();
  });
});
