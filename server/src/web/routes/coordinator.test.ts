import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import supertest from "supertest";
import { createDatabase, closeDb } from "../../services/database.js";
import { FleetCoordinator } from "../../services/coordinator.js";
import { createCoordinatorRouter } from "./coordinator.js";
import { setConfigForTesting } from "../../config/fleet.js";
import type { GantryConfig } from "../../config/types.js";

const testConfig: GantryConfig = {
  agents: [
    { name: "drifter-gale", faction: "solarian" },
    { name: "rust-vane", faction: "solarian" },
  ],
  gameUrl: "https://game.test/mcp",
  gameApiUrl: "https://game.test/api/v1",
  gameMcpUrl: "https://game.test/mcp",
  agentDeniedTools: {},
  callLimits: {},
  turnSleepMs: 90,
  staggerDelay: 20,
  coordinator: {
    enabled: false,
    intervalMinutes: 10,
    defaultDistribution: { miners: 2, crafters: 1, traders: 1, flex: 1 },
    quotaDefaults: { batchSize: 50, maxActiveQuotas: 10 },
  },
};

function createTestApp(authRole: string = "admin") {
  const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
  statusCache.set("drifter-gale", { data: { credits: 10000 }, fetchedAt: Date.now() });

  const mockMarketCache = {
    get: () => ({ data: null, stale: false, age_seconds: -1 }),
  } as any;

  const mockArbitrageAnalyzer = {
    getOpportunities: () => [],
    analyze: () => [],
  } as any;

  const mockBattleCache = new Map();

  const coordinator = new FleetCoordinator(
    statusCache, mockMarketCache, mockArbitrageAnalyzer, mockBattleCache
  );

  const app = express();
  app.use(express.json());
  // Mock auth middleware
  app.use((_req, _res, next) => {
    (_req as any).auth = { role: authRole };
    next();
  });
  app.use("/api/coordinator", createCoordinatorRouter({ coordinator }));

  return { app, coordinator };
}

describe("coordinator routes", () => {
  beforeEach(() => {
    createDatabase(":memory:");
    setConfigForTesting(testConfig);
  });

  afterEach(() => {
    closeDb();
  });

  test("GET /status returns coordinator state", async () => {
    const { app } = createTestApp();
    const res = await supertest(app).get("/api/coordinator/status");
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.lastTick).toBeNull();
    expect(res.body.activeQuotas).toBeInstanceOf(Array);
  });

  test("POST /tick forces a coordinator tick", async () => {
    const { app } = createTestApp();
    const res = await supertest(app).post("/api/coordinator/tick");
    expect(res.status).toBe(200);
    expect(res.body.tick_number).toBe(1);
    expect(res.body.assignments).toBeInstanceOf(Array);
  });

  test("POST /tick requires admin role", async () => {
    const { app } = createTestApp("viewer");
    const res = await supertest(app).post("/api/coordinator/tick");
    expect(res.status).toBe(403);
  });

  test("POST /enable toggles coordinator", async () => {
    const { app } = createTestApp();
    const res = await supertest(app).post("/api/coordinator/enable").send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
  });

  test("POST /enable requires boolean", async () => {
    const { app } = createTestApp();
    const res = await supertest(app).post("/api/coordinator/enable").send({ enabled: "yes" });
    expect(res.status).toBe(400);
  });

  test("GET /quotas returns active quotas", async () => {
    const { app, coordinator } = createTestApp();
    coordinator.createQuota("iron_ore", 200, "sol_station");
    const res = await supertest(app).get("/api/coordinator/quotas");
    expect(res.status).toBe(200);
    expect(res.body.quotas).toHaveLength(1);
  });

  test("POST /quotas creates a quota", async () => {
    const { app } = createTestApp();
    const res = await supertest(app)
      .post("/api/coordinator/quotas")
      .send({ item_id: "iron_ore", target_quantity: 200, station_id: "sol_station" });
    expect(res.status).toBe(201);
    expect(res.body.item_id).toBe("iron_ore");
  });

  test("DELETE /quotas/:id cancels a quota", async () => {
    const { app, coordinator } = createTestApp();
    const quota = coordinator.createQuota("iron_ore", 200, "sol_station");
    const res = await supertest(app).delete(`/api/coordinator/quotas/${quota.id}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test("DELETE /quotas/:id returns 404 for nonexistent", async () => {
    const { app } = createTestApp();
    const res = await supertest(app).delete("/api/coordinator/quotas/999");
    expect(res.status).toBe(404);
  });

  test("GET /history returns empty array initially", async () => {
    const { app } = createTestApp();
    const res = await supertest(app).get("/api/coordinator/history");
    expect(res.status).toBe(200);
    expect(res.body.history).toBeInstanceOf(Array);
  });
});
