import { describe, it, expect, beforeEach, mock } from "bun:test";
import request from "supertest";
import express from "express";



// Import after mock
import { createServerStatusRouter } from "./server-status.js";
import type { GameHealthRef } from "../../services/health-status.js";
import { BreakerRegistry } from "../../proxy/circuit-breaker.js";
import { MetricsWindow } from "../../proxy/instability-metrics.js";

function makeApp(healthRef: GameHealthRef, breakerRegistry: BreakerRegistry, serverMetrics: MetricsWindow) {
  const app = express();
  app.use("/api/server-status", createServerStatusRouter(healthRef, breakerRegistry, serverMetrics));
  return app;
}

describe("GET /api/server-status", () => {
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

  it("returns 200 with status payload", async () => {
    const app = makeApp(
      {
        current: { tick: 100, version: "v0.140.0", fetchedAt: Date.now() - 3_000 },
      },
      breakerRegistry,
      serverMetrics
    );
    const res = await request(app).get("/api/server-status");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("up");
    expect(res.body.version).toBe("v0.140.0");
    expect(res.body.circuit_breaker.state).toBe("closed");
    expect(res.body.notes).toBe("All systems nominal");
  });

  it("returns DOWN when no health data", async () => {
    const app = makeApp({ current: null }, breakerRegistry, serverMetrics);
    const res = await request(app).get("/api/server-status");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("down");
    expect(res.body.version).toBeNull();
  });

  it("returns DOWN when circuit breaker open", async () => {
    mockGetAggregateStatus.mockReturnValue({ state: "open", failures: 3, cooldown_remaining_ms: 30_000 });
    const app = makeApp(
      {
        current: { tick: 100, version: "v0.140.0", fetchedAt: Date.now() - 5_000 },
      },
      breakerRegistry,
      serverMetrics
    );
    const res = await request(app).get("/api/server-status");
    expect(res.body.status).toBe("down");
    expect(res.body.circuit_breaker.state).toBe("open");
    expect(res.body.circuit_breaker.cooldown_remaining_ms).toBe(30_000);
  });

  it("returns DEGRADED when breaker half-open", async () => {
    mockGetAggregateStatus.mockReturnValue({ state: "half-open", failures: 3 });
    const app = makeApp(
      {
        current: { tick: 100, version: "v0.140.0", fetchedAt: Date.now() - 5_000 },
      },
      breakerRegistry,
      serverMetrics
    );
    const res = await request(app).get("/api/server-status");
    expect(res.body.status).toBe("degraded");
  });

  it("includes check_interval_seconds", async () => {
    const app = makeApp(
      {
        current: { tick: 100, version: "v0.140.0", fetchedAt: Date.now() - 3_000 },
      },
      breakerRegistry,
      serverMetrics
    );
    const res = await request(app).get("/api/server-status");
    expect(res.body.check_interval_seconds).toBe(10);
  });

  it("includes timestamp as ISO string", async () => {
    const app = makeApp(
      {
        current: { tick: 100, version: "v0.140.0", fetchedAt: Date.now() - 3_000 },
      },
      breakerRegistry,
      serverMetrics
    );
    const res = await request(app).get("/api/server-status");
    expect(res.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
