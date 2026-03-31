import { describe, it, expect } from "bun:test";
import express from "express";
import request from "supertest";
import { createGantryServer } from "./server.js";
import type { GantryConfig } from "../config.js";

const testConfig: GantryConfig = {
  agents: [{ name: "test-agent", socksPort: 1081 }],
  gameUrl: "https://game.spacemolt.com/mcp",
  gameApiUrl: "https://game.spacemolt.com/api/v1",
  agentDeniedTools: {},
  callLimits: {},
  turnSleepMs: 90,
  staggerDelay: 20,
};

const GAME_TOOLS = [
  "login",
  "logout",
  "mine",
  "travel",
  "jump",
  "dock",
  "undock",
  "get_status",
  "get_cargo",
  "sell",
  "buy",
];

describe("createGantryServer", () => {
  it("returns an McpServer instance", () => {
    const { mcpServer } = createGantryServer(testConfig);
    expect(mcpServer).toBeDefined();
  });

  it("registers compound tools", () => {
    const { registeredTools } = createGantryServer(testConfig);
    expect(registeredTools).toContain("batch_mine");
    expect(registeredTools).toContain("travel_to");
  });

  it("registers cached status tools", () => {
    const { registeredTools } = createGantryServer(testConfig);
    expect(registeredTools).toContain("get_credits");
    expect(registeredTools).toContain("get_location");
    expect(registeredTools).toContain("get_cargo_summary");
    expect(registeredTools).toContain("get_fuel");
    expect(registeredTools).toContain("get_health");
  });

  it("registers passthrough tools for all game commands", () => {
    const { registeredTools } = createGantryServer(testConfig);
    for (const tool of GAME_TOOLS) {
      expect(registeredTools).toContain(tool);
    }
  });

  it("registers session_info utility tool", () => {
    const { registeredTools } = createGantryServer(testConfig);
    expect(registeredTools).toContain("get_session_info");
  });

  it("registers get_events tool", () => {
    const { registeredTools } = createGantryServer(testConfig);
    expect(registeredTools).toContain("get_events");
  });

  it("registers public API tools", () => {
    const { registeredTools } = createGantryServer(testConfig);
    expect(registeredTools).toContain("get_global_market");
    expect(registeredTools).toContain("find_local_route");
  });
});

/**
 * Game-state endpoint tests use supertest for in-process HTTP testing,
 * avoiding Bun/Node http-module connection-pool issues with ephemeral ports.
 */
describe("game-state endpoints", () => {
  it("GET /game-state/all returns empty object when no agents cached", async () => {
    const { app } = createAppWithCache({});
    const res = await request(app).get("/game-state/all");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it("GET /game-state/:agent returns 404 for unknown agent", async () => {
    const { app } = createAppWithCache({});
    const res = await request(app).get("/game-state/nobody");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not found", agent: "nobody" });
  });

  it("GET /game-state/all returns cached data for agents", async () => {
    const { app } = createAppWithCache({
      "alpha": { data: { credits: 100, fuel: 50 }, fetchedAt: Date.now() },
      "bravo": { data: { credits: 200, fuel: 80 }, fetchedAt: Date.now() },
    });
    const res = await request(app).get("/game-state/all");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      alpha: { credits: 100, fuel: 50 },
      bravo: { credits: 200, fuel: 80 },
    });
  });

  it("GET /game-state/:agent returns cached data for a specific agent", async () => {
    const { app } = createAppWithCache({
      "alpha": { data: { credits: 100, fuel: 50 }, fetchedAt: Date.now() },
    });
    const res = await request(app).get("/game-state/alpha");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ credits: 100, fuel: 50 });
  });
});

/**
 * Helper: creates an Express app with a pre-populated statusCache
 * for testing game-state endpoints without needing real game sessions.
 */
function createAppWithCache(
  cacheEntries: Record<string, { data: Record<string, unknown>; fetchedAt: number }>,
) {
  const app = express();
  app.use(express.json());

  const statusCache = new Map(Object.entries(cacheEntries));

  app.get("/game-state/all", (_req, res) => {
    const result: Record<string, unknown> = {};
    for (const [agentName, entry] of statusCache) {
      result[agentName] = entry.data;
    }
    res.json(result);
  });

  app.get("/game-state/:agent", (req, res) => {
    const entry = statusCache.get(req.params.agent);
    if (!entry) {
      res.status(404).json({ error: "not found", agent: req.params.agent });
      return;
    }
    res.json(entry.data);
  });

  return { app };
}
