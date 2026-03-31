/**
 * Tests for GET /api/agents/:name/context-summary
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import request from "supertest";
import { createDatabase, closeDb, getDb } from "../../services/database.js";
import { EventBuffer } from "../../proxy/event-buffer.js";
import { createContextSummaryRouter } from "./context-summary.js";
import { setConfigForTesting } from "../../config/index.js";
import type { GantryConfig } from "../../config/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type StatusCache = Map<string, { data: Record<string, unknown>; fetchedAt: number }>;
type EventBufferMap = Map<string, EventBuffer>;

function buildApp(statusCache: StatusCache, eventBuffers: EventBufferMap) {
  const app = express();
  app.use(express.json());
  app.use("/api/agents", createContextSummaryRouter(statusCache, eventBuffers));
  return app;
}

function seedToolCalls(agent: string, count: number) {
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO proxy_tool_calls (agent, tool_name, args_summary, result_summary, success, duration_ms, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now', ? || ' seconds'))
  `);
  for (let i = 0; i < count; i++) {
    insert.run(agent, `tool_${i}`, `{"arg":${i}}`, `{"result":${i}}`, 1, 100 + i, String(-count + i));
  }
}

function seedOrder(agent: string, message: string) {
  const db = getDb();
  db.prepare(
    `INSERT INTO fleet_orders (message, target_agent, priority, expires_at) VALUES (?, ?, ?, NULL)`,
  ).run(message, agent, "normal");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/agents/:name/context-summary", () => {
  let statusCache: StatusCache;
  let eventBuffers: EventBufferMap;

  beforeEach(() => {
    createDatabase(":memory:");
    statusCache = new Map();
    eventBuffers = new Map();
    // Register test agents so validateAgentName() recognizes them
    setConfigForTesting({
      agents: [{ name: "drifter-gale" }],
      gameUrl: "http://localhost/mcp",
      gameApiUrl: "http://localhost/api/v1",
      agentDeniedTools: {},
      callLimits: {},
      turnSleepMs: 90,
      staggerDelay: 20,
    } as GantryConfig);
  });

  afterEach(() => {
    closeDb();
  });

  it("returns 404 for unknown agent", async () => {
    const app = buildApp(statusCache, eventBuffers);
    const res = await request(app).get("/api/agents/no-such-agent/context-summary");
    expect(res.status).toBe(404);
    expect((res.body as any).error).toBeTruthy();
  });

  it("returns expected shape for a known agent", async () => {
    const app = buildApp(statusCache, eventBuffers);

    statusCache.set("drifter-gale", {
      data: {
        player: { current_system: "Sol", current_poi: "Earth Station", credits: 5000, docked: true },
        ship: { fuel: 80, cargo_used: 10, cargo_capacity: 50 },
      },
      fetchedAt: Date.now(),
    });

    const res = await request(app).get("/api/agents/drifter-gale/context-summary");
    expect(res.status).toBe(200);

    const body = res.body as any;
    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("location");
    expect(body).toHaveProperty("resources");
    expect(body).toHaveProperty("last_actions");
    expect(body).toHaveProperty("active_orders");
    expect(body).toHaveProperty("recent_events");
  });

  it("extracts location and resources from status cache", async () => {
    const app = buildApp(statusCache, eventBuffers);

    statusCache.set("drifter-gale", {
      data: {
        player: { current_system: "Sirius", current_poi: "Sirius Prime", credits: 12345, docked: true },
        ship: { fuel: 60, cargo_used: 20, cargo_capacity: 100 },
      },
      fetchedAt: Date.now(),
    });

    const res = await request(app).get("/api/agents/drifter-gale/context-summary");
    expect(res.status).toBe(200);

    const body = res.body as any;
    expect(body.location.system).toBe("Sirius");
    expect(body.location.poi).toBe("Sirius Prime");
    expect(body.location.docked).toBe(true);
    expect(body.resources.credits).toBe(12345);
    expect(body.resources.fuel).toBe(60);
    expect(body.resources.cargo_summary).toBe("20/100");
  });

  it("returns last N tool calls from database", async () => {
    const app = buildApp(statusCache, eventBuffers);
    seedToolCalls("drifter-gale", 8);

    const res = await request(app).get("/api/agents/drifter-gale/context-summary");
    expect(res.status).toBe(200);

    const body = res.body as any;
    // Should return at most 5 tool calls (the most recent)
    expect(body.last_actions).toHaveLength(5);
    // Each action should have expected fields
    for (const action of body.last_actions) {
      expect(action).toHaveProperty("tool");
      expect(action).toHaveProperty("success");
      expect(action).toHaveProperty("timestamp");
    }
  });

  it("returns empty last_actions when no tool calls exist", async () => {
    const app = buildApp(statusCache, eventBuffers);

    const res = await request(app).get("/api/agents/drifter-gale/context-summary");
    expect(res.status).toBe(200);
    expect((res.body as any).last_actions).toHaveLength(0);
  });

  it("returns active fleet orders for the agent", async () => {
    const app = buildApp(statusCache, eventBuffers);
    seedOrder("drifter-gale", "Go mine Sirius asteroids");
    seedOrder("drifter-gale", "Report status");

    const res = await request(app).get("/api/agents/drifter-gale/context-summary");
    expect(res.status).toBe(200);

    const body = res.body as any;
    expect(body.active_orders).toHaveLength(2);
    const messages = body.active_orders.map((o: any) => o.message);
    expect(messages).toContain("Go mine Sirius asteroids");
    expect(messages).toContain("Report status");
  });

  it("returns empty orders when none pending", async () => {
    const app = buildApp(statusCache, eventBuffers);
    const res = await request(app).get("/api/agents/drifter-gale/context-summary");
    expect(res.status).toBe(200);
    expect((res.body as any).active_orders).toHaveLength(0);
  });

  it("returns null status fields when agent has no cached status", async () => {
    const app = buildApp(statusCache, eventBuffers);
    // No status seeded

    const res = await request(app).get("/api/agents/drifter-gale/context-summary");
    expect(res.status).toBe(200);

    const body = res.body as any;
    expect(body.status).toBeNull();
    expect(body.location.system).toBeNull();
    expect(body.location.poi).toBeNull();
    expect(body.resources.credits).toBeNull();
    expect(body.resources.fuel).toBeNull();
    expect(body.resources.cargo_summary).toBeNull();
  });

  it("includes recent events from the event buffer without draining them", async () => {
    const app = buildApp(statusCache, eventBuffers);
    const buffer = new EventBuffer();
    buffer.push({ type: "combat_update", payload: { hp: 50 }, receivedAt: Date.now() });
    buffer.push({ type: "pirate_warning", payload: { threat: "high" }, receivedAt: Date.now() });
    buffer.push({ type: "scan_detected", payload: { scanner: "enemy" }, receivedAt: Date.now() });
    eventBuffers.set("drifter-gale", buffer);

    const res = await request(app).get("/api/agents/drifter-gale/context-summary");
    expect(res.status).toBe(200);

    const body = res.body as any;
    expect(body.recent_events).toHaveLength(3);

    // The buffer should not be drained — events remain for other consumers
    expect(buffer.size).toBe(3);
  });
});
