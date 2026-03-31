/**
 * Integration tests for GET /api/rate-limits (game API rate limit tracker route).
 *
 * Tests cover:
 * - Empty snapshot when tracker is not initialized
 * - Populated snapshot after recording requests
 * - 429 events reflected in snapshot
 */
import { describe, it, expect, beforeEach } from "bun:test";
import request from "supertest";
import express from "express";
import rateLimitsGameRouter from "./rate-limits-game.js";
import {
  resetTracker,
  initTracker,
  getTracker,
} from "../../services/rate-limit-tracker.js";
import type { GantryConfig } from "../../config.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/", rateLimitsGameRouter);
  return app;
}

function makeConfig(): GantryConfig {
  return {
    agents: [
      { name: "drifter-gale" },
      { name: "rust-vane" },
      { name: "sable-thorn", proxy: "micro" },
    ],
    gameUrl: "ws://localhost:9999",
    gameApiUrl: "http://localhost:9999",
    turnSleepMs: 90_000,
    staggerDelay: 20_000,
    mockMode: { enabled: false },
  } as unknown as GantryConfig;
}

beforeEach(() => {
  resetTracker();
});

describe("GET /api/rate-limits — no tracker", () => {
  it("returns 200 with empty snapshot when tracker not initialized", async () => {
    const app = makeApp();
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      limit: 30,
      window_seconds: 60,
      by_ip: {},
      by_agent: {},
      recent_429s: [],
    });
  });
});

describe("GET /api/rate-limits — with tracker", () => {
  it("returns populated snapshot after recording requests", async () => {
    const tracker = initTracker(makeConfig());
    tracker.recordRequest("drifter-gale", "get_status", false);
    tracker.recordRequest("drifter-gale", "batch_mine", false);
    tracker.recordRequest("rust-vane", "multi_sell", false);

    const app = makeApp();
    const res = await request(app).get("/");
    expect(res.status).toBe(200);

    const { by_ip, by_agent } = res.body;
    expect(by_ip["direct"]).toBeDefined();
    expect(by_ip["direct"].rpm).toBe(3);
    expect(by_agent["drifter-gale"].rpm).toBe(2);
    expect(by_agent["rust-vane"].rpm).toBe(1);
  });

  it("reflects 429 events in snapshot", async () => {
    const tracker = initTracker(makeConfig());
    tracker.recordRequest("sable-thorn", "trade", true);

    const app = makeApp();
    const res = await request(app).get("/");
    expect(res.status).toBe(200);

    expect(res.body.recent_429s).toHaveLength(1);
    expect(res.body.recent_429s[0].agent).toBe("sable-thorn");
    expect(res.body.recent_429s[0].tool).toBe("trade");
    expect(res.body.by_agent["sable-thorn"].rate_limited).toBe(1);
  });

  it("snapshot has correct shape", async () => {
    initTracker(makeConfig());

    const app = makeApp();
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(typeof res.body.limit).toBe("number");
    expect(typeof res.body.window_seconds).toBe("number");
    expect(typeof res.body.by_ip).toBe("object");
    expect(typeof res.body.by_agent).toBe("object");
    expect(Array.isArray(res.body.recent_429s)).toBe(true);
  });

  it("all configured agents appear in by_agent even with no calls", async () => {
    initTracker(makeConfig());

    const app = makeApp();
    const res = await request(app).get("/");
    expect(res.body.by_agent["drifter-gale"]).toBeDefined();
    expect(res.body.by_agent["rust-vane"]).toBeDefined();
    expect(res.body.by_agent["sable-thorn"]).toBeDefined();
    expect(res.body.by_agent["drifter-gale"].rpm).toBe(0);
  });
});
