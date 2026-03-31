import { describe, it, expect, beforeEach, setSystemTime, mock } from "bun:test";
import { MetricsWindow, type MetricsConfig } from "./instability-metrics.js";

describe("MetricsWindow", () => {
  let metrics: MetricsWindow;

  beforeEach(() => {
    setSystemTime();
    metrics = new MetricsWindow({
      windowMs: 60_000, // 1 minute for fast tests
      downTimeoutMs: 5_000,
    });
  });

  describe("recording", () => {
    it("starts with zero counts", () => {
      const m = metrics.getMetrics();
      expect(m.errors.total).toBe(0);
      expect(m.requests.total).toBe(0);
      expect(m.status).toBe("healthy");
    });

    it("records successful requests", () => {
      metrics.recordSuccess();
      metrics.recordSuccess();
      metrics.recordSuccess();

      const m = metrics.getMetrics();
      expect(m.requests.total).toBe(3);
      expect(m.requests.successful).toBe(3);
    });

    it("records errors with codes", () => {
      metrics.recordError(504);
      metrics.recordError(503);
      metrics.recordError("action_pending");

      const m = metrics.getMetrics();
      expect(m.errors.total).toBe(3);
      expect(m.errors.count504).toBe(1);
      expect(m.errors.count503).toBe(1);
      expect(m.errors.count409).toBe(1); // action_pending maps to 409
      expect(m.requests.total).toBe(3);
      expect(m.requests.successful).toBe(0);
    });

    it("tracks consecutive errors", () => {
      metrics.recordError(504);
      metrics.recordError(504);
      expect(metrics.getConsecutiveErrors()).toBe(2);

      metrics.recordSuccess();
      expect(metrics.getConsecutiveErrors()).toBe(0);
    });
  });

  describe("sliding window", () => {
    it("prunes records older than window", () => {
      const now = new Date(2026, 0, 1, 12, 0, 0);
      setSystemTime(now);

      metrics.recordSuccess();
      metrics.recordError(504);

      // Advance past window
      setSystemTime(new Date(now.getTime() + 120_000));

      const m = metrics.getMetrics();
      expect(m.requests.total).toBe(0);
      expect(m.errors.total).toBe(0);

      setSystemTime();
    });
  });

  describe("error categorization", () => {
    it("counts 502 errors", () => {
      metrics.recordError(502);
      expect(metrics.getMetrics().errors.count502).toBe(1);
    });

    it("counts timeout errors", () => {
      metrics.recordError("timeout");
      metrics.recordError(408);
      expect(metrics.getMetrics().errors.countTimeout).toBe(2);
    });

    it("counts rate limit errors", () => {
      metrics.recordError(429);
      metrics.recordError("rate_limited");
      expect(metrics.getMetrics().errors.countRateLimit).toBe(2);
    });

    it("counts connection_failed errors (legacy code)", () => {
      metrics.recordError("connection_failed");
      expect(metrics.getMetrics().errors.countConnection).toBe(1);
    });

    it("counts connection_lost errors", () => {
      metrics.recordError("connection_lost");
      expect(metrics.getMetrics().errors.countConnection).toBe(1);
    });

    it("counts connection_timeout errors", () => {
      metrics.recordError("connection_timeout");
      expect(metrics.getMetrics().errors.countConnection).toBe(1);
    });

    it("counts connection_refused errors", () => {
      metrics.recordError("connection_refused");
      expect(metrics.getMetrics().errors.countConnection).toBe(1);
    });

    it("counts connection_retry_failed errors", () => {
      metrics.recordError("connection_retry_failed");
      expect(metrics.getMetrics().errors.countConnection).toBe(1);
    });

    it("counts all connection sub-types in countConnection", () => {
      metrics.recordError("connection_lost");
      metrics.recordError("connection_timeout");
      metrics.recordError("connection_refused");
      metrics.recordError("connection_retry_failed");
      expect(metrics.getMetrics().errors.countConnection).toBe(4);
    });

    it("categorizes string HTTP codes correctly", () => {
      // game-client always passes string codes — verify String() coercion works
      metrics.recordError("504");
      metrics.recordError("503");
      metrics.recordError("429");
      const m = metrics.getMetrics();
      expect(m.errors.count504).toBe(1);
      expect(m.errors.count503).toBe(1);
      expect(m.errors.countRateLimit).toBe(1);
      expect(m.errors.countOther).toBe(0);
    });

    it("counts other errors", () => {
      metrics.recordError(500);
      metrics.recordError("unknown_thing");
      expect(metrics.getMetrics().errors.countOther).toBe(2);
    });
  });

  describe("status derivation", () => {
    it("returns healthy with no errors", () => {
      metrics.recordSuccess();
      expect(metrics.getMetrics().status).toBe("healthy");
    });

    it("returns degraded with moderate error rate", () => {
      // Need >3% error rate (new threshold). 4 errors out of 100 = 4%
      for (let i = 0; i < 96; i++) metrics.recordSuccess();
      for (let i = 0; i < 4; i++) metrics.recordError(504);

      expect(metrics.getMetrics().status).toBe("degraded");
    });

    it("returns unstable with high error rate", () => {
      // Need >10% error rate (new threshold). 12 errors out of 100 = 12%
      for (let i = 0; i < 88; i++) metrics.recordSuccess();
      for (let i = 0; i < 12; i++) metrics.recordError(504);

      const m = metrics.getMetrics();
      expect(m.status).toBe("unstable");
    });









    it("returns down when no successful calls in downTimeoutMs", () => {
      const now = new Date(2026, 0, 1, 12, 0, 0);
      setSystemTime(now);

      // Create fresh metrics with system time locked, so lastSuccessTime = now
      const freshMetrics = new MetricsWindow({ windowMs: 60_000, downTimeoutMs: 5_000 });
      freshMetrics.recordError(504);

      // Advance past downTimeoutMs (5s in our test config)
      setSystemTime(new Date(now.getTime() + 6_000));
      freshMetrics.recordError(504);

      expect(freshMetrics.getMetrics().status).toBe("down");

      setSystemTime();
    });

    it("returns unstable when circuit breaker is open", () => {
      metrics.recordSuccess();
      metrics.setCircuitBreakerState("open");
      expect(metrics.getMetrics().status).toBe("unstable");
    });

    it("returns degraded when circuit breaker is half-open", () => {
      for (let i = 0; i < 10; i++) metrics.recordSuccess();
      metrics.setCircuitBreakerState("half-open");
      expect(metrics.getMetrics().status).toBe("degraded");
    });

    it("includes reason string for non-healthy status", () => {
      metrics.setCircuitBreakerState("open");
      metrics.recordSuccess();
      const m = metrics.getMetrics();
      expect(m.reason).toContain("Circuit breaker");
    });
  });

  describe("recovery probe", () => {
    it("setProbeCallback stores the callback without errors", () => {
      const probe = mock(async () => {});
      metrics.setProbeCallback(probe);
      // Should not throw — callback registered
      expect(probe).not.toHaveBeenCalled();
    });

    it("can start and stop probe without throwing", () => {
      const probe = mock(async () => {});
      metrics.setProbeCallback(probe);
      metrics.startRecoveryProbe();
      metrics.stopRecoveryProbe(); // Should not throw
    });

    it("records success and transitions back to healthy from down", () => {
      const now = new Date(2026, 0, 1, 12, 0, 0);
      setSystemTime(now);
      const freshMetrics = new MetricsWindow({ windowMs: 60_000, downTimeoutMs: 5_000 });

      // Drive to down (one error to have some traffic, then advance past timeout)
      freshMetrics.recordError(504);
      setSystemTime(new Date(now.getTime() + 6_000));
      freshMetrics.recordError(504);
      expect(freshMetrics.getMetrics().status).toBe("down");

      // Simulate probe successes — enough to push error rate below all thresholds
      // (2 errors + 300 successes = ~0.66% error rate, below 1% degraded threshold)
      const probeTime = new Date(now.getTime() + 7_000);
      setSystemTime(probeTime);
      for (let i = 0; i < 300; i++) freshMetrics.recordSuccess();
      expect(freshMetrics.getMetrics().status).toBe("healthy");

      setSystemTime();
    });
  });

  describe("circuit breaker integration", () => {
    it("reflects CB state in metrics", () => {
      metrics.setCircuitBreakerState("open");
      expect(metrics.getMetrics().circuitBreaker.state).toBe("open");

      metrics.setCircuitBreakerState("closed");
      expect(metrics.getMetrics().circuitBreaker.state).toBe("closed");
    });

    it("reports consecutive errors in CB metrics", () => {
      metrics.recordError(504);
      metrics.recordError(504);
      metrics.recordError(504);
      expect(metrics.getMetrics().circuitBreaker.consecutiveErrors).toBe(3);
    });
  });
});
