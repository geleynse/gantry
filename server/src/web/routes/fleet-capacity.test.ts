/**
 * Tests for the /api/fleet/capacity endpoint.
 */

import { describe, test, expect } from "bun:test";
import express from "express";
import supertest from "supertest";
import { createFleetCapacityRouter } from "./fleet-capacity.js";

// ---------------------------------------------------------------------------
// Test config — passed directly to the router factory, no globals needed
// ---------------------------------------------------------------------------

const TEST_CONFIG = {
  agents: [
    { name: "drifter-gale", role: "Trader/Mining", operatingZone: "sol-belt" },
    { name: "sable-thorn", role: "Combat", operatingZone: "nebula-deep" },
    { name: "rust-vane", role: "Miner" /* no zone */ },
  ],
} as any;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type StatusCacheEntry = { data: Record<string, unknown>; fetchedAt: number };

function makeStatusCache(entries: Record<string, Partial<StatusCacheEntry["data"]> & { online?: boolean }>): Map<string, StatusCacheEntry> {
  const cache = new Map<string, StatusCacheEntry>();
  const now = Date.now();
  for (const [name, overrides] of Object.entries(entries)) {
    const { online = true, ...data } = overrides;
    // online agents have a fresh fetchedAt; offline agents are stale (6 min ago)
    cache.set(name, {
      data: data as Record<string, unknown>,
      fetchedAt: online ? now : now - 6 * 60 * 1000,
    });
  }
  return cache;
}

function createTestApp(statusCache: Map<string, StatusCacheEntry>) {
  const app = express();
  app.use(express.json());
  app.use("/api/fleet", createFleetCapacityRouter(statusCache, TEST_CONFIG));
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/fleet/capacity", () => {
  test("returns correct response shape with empty cache", async () => {
    const app = createTestApp(new Map());
    const res = await supertest(app).get("/api/fleet/capacity");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("agents");
    expect(res.body).toHaveProperty("totals");
    expect(res.body).toHaveProperty("zoneCoverage");
    expect(res.body.agents).toBeInstanceOf(Array);
    expect(res.body.agents).toHaveLength(3); // from test config
  });

  test("reports agent credits, cargo, and online status from nested game server format", async () => {
    const cache = makeStatusCache({
      "drifter-gale": {
        player: { credits: 50000, fuel: 80, fuel_max: 100, current_system: "sol" },
        ship: { cargo_used: 20, cargo_max: 100, hull: 90, max_hull: 100 },
      },
      "sable-thorn": { online: false }, // stale
    });
    const app = createTestApp(cache);
    const res = await supertest(app).get("/api/fleet/capacity");

    expect(res.status).toBe(200);
    const agents: Record<string, unknown>[] = res.body.agents;

    const drifter = agents.find((a) => a.name === "drifter-gale");
    expect(drifter?.credits).toBe(50000);
    expect(drifter?.cargoUsed).toBe(20);
    expect(drifter?.cargoMax).toBe(100);
    expect(drifter?.fuel).toBe(80);
    expect(drifter?.fuelMax).toBe(100);
    expect(drifter?.system).toBe("sol");
    expect(drifter?.online).toBe(true);

    const sable = agents.find((a) => a.name === "sable-thorn");
    expect(sable?.online).toBe(false);
  });

  test("totals sum credits and cargo from ALL agents (including offline last-known data)", async () => {
    const cache = makeStatusCache({
      "drifter-gale": { player: { credits: 50000 }, ship: { cargo_used: 20, cargo_max: 100 } },
      "sable-thorn": { player: { credits: 30000 }, ship: { cargo_used: 10, cargo_max: 80 }, online: false }, // offline but included
      "rust-vane": { player: { credits: 20000 }, ship: { cargo_used: 50, cargo_max: 200 } },
    });
    const app = createTestApp(cache);
    const res = await supertest(app).get("/api/fleet/capacity");

    expect(res.status).toBe(200);
    const { totals } = res.body;
    // All 3 agents contribute last-known data (Bugs 2 & 6 fix)
    expect(totals.totalCredits).toBe(100000); // 50000 + 30000 + 20000
    expect(totals.totalCargoUsed).toBe(80); // 20 + 10 + 50
    expect(totals.totalCargoCapacity).toBe(380); // 100 + 80 + 200
    expect(totals.onlineCount).toBe(2);
    expect(totals.agentCount).toBe(3);
  });

  test("zone coverage shows covered and uncovered zones", async () => {
    const cache = makeStatusCache({
      "drifter-gale": { credits: 1000 }, // zone: sol-belt
      // sable-thorn offline — but still config-assigned to nebula-deep
      "sable-thorn": { online: false },
    });
    const app = createTestApp(cache);
    const res = await supertest(app).get("/api/fleet/capacity");

    expect(res.status).toBe(200);
    const { zoneCoverage } = res.body;
    // drifter-gale covers sol-belt
    expect(zoneCoverage.covered["sol-belt"]).toContain("drifter-gale");
    // sable-thorn is still config-assigned to nebula-deep (zone comes from config, not online status)
    expect(zoneCoverage.covered["nebula-deep"]).toContain("sable-thorn");
    // rust-vane has no zone — shouldn't appear
    expect(Object.keys(zoneCoverage.covered)).not.toContain(undefined);
  });

  test("isStale flag is true for offline agents with cached data, false for online agents", async () => {
    const cache = makeStatusCache({
      "drifter-gale": { player: { credits: 50000 }, ship: { hull: 90, max_hull: 100 } }, // online
      "sable-thorn": { player: { credits: 30000 }, ship: { hull: 70, max_hull: 100 }, online: false }, // offline, has data
    });
    const app = createTestApp(cache);
    const res = await supertest(app).get("/api/fleet/capacity");

    expect(res.status).toBe(200);
    const agents: Record<string, unknown>[] = res.body.agents;

    const drifter = agents.find((a) => a.name === "drifter-gale");
    expect(drifter?.online).toBe(true);
    expect(drifter?.isStale).toBe(false);

    const sable = agents.find((a) => a.name === "sable-thorn");
    expect(sable?.online).toBe(false);
    expect(sable?.isStale).toBe(true);

    // rust-vane has no cache entry at all — no data, not stale
    const rust = agents.find((a) => a.name === "rust-vane");
    expect(rust?.online).toBe(false);
    expect(rust?.isStale).toBe(false);
  });

  test("hullPercent is shown for offline agents with last-known data (Bug 3)", async () => {
    const cache = makeStatusCache({
      "drifter-gale": { ship: { hull: 80, max_hull: 100 }, online: false }, // offline but has hull data
    });
    const app = createTestApp(cache);
    const res = await supertest(app).get("/api/fleet/capacity");

    expect(res.status).toBe(200);
    const agents: Record<string, unknown>[] = res.body.agents;
    const drifter = agents.find((a) => a.name === "drifter-gale");
    // Should show 80% hull even though offline (Bug 3 fix)
    expect(drifter?.hullPercent).toBe(80);
    expect(drifter?.isStale).toBe(true);
  });

  test("hullPercent is null for agent with no cached data", async () => {
    const cache = makeStatusCache({}); // empty cache
    const app = createTestApp(cache);
    const res = await supertest(app).get("/api/fleet/capacity");

    expect(res.status).toBe(200);
    const agents: Record<string, unknown>[] = res.body.agents;
    for (const agent of agents) {
      expect(agent.hullPercent).toBeNull();
      expect(agent.isStale).toBe(false);
    }
  });

  test("byRole counts all agents (including offline)", async () => {
    const cache = makeStatusCache({});
    const app = createTestApp(cache);
    const res = await supertest(app).get("/api/fleet/capacity");

    expect(res.status).toBe(200);
    const { totals } = res.body;
    // 3 agents: Trader/Mining, Combat, Miner
    expect(totals.byRole["Trader/Mining"]).toBe(1);
    expect(totals.byRole["Combat"]).toBe(1);
    expect(totals.byRole["Miner"]).toBe(1);
  });

  test("lastActiveAt is populated for agents with cached data, null otherwise", async () => {
    const beforeMs = Date.now();
    const cache = makeStatusCache({
      "drifter-gale": { player: { credits: 50000 } }, // online
    });
    const afterMs = Date.now();
    const app = createTestApp(cache);
    const res = await supertest(app).get("/api/fleet/capacity");

    expect(res.status).toBe(200);
    const agents: Record<string, unknown>[] = res.body.agents;

    const drifter = agents.find((a) => a.name === "drifter-gale");
    expect(typeof drifter?.lastActiveAt).toBe("number");
    expect(drifter?.lastActiveAt as number).toBeGreaterThanOrEqual(beforeMs);
    expect(drifter?.lastActiveAt as number).toBeLessThanOrEqual(afterMs);

    // Agents with no cache entry have null lastActiveAt
    const rust = agents.find((a) => a.name === "rust-vane");
    expect(rust?.lastActiveAt).toBeNull();
  });

  test("offline agent retains last-known system from statusCache", async () => {
    const cache = makeStatusCache({
      "drifter-gale": {
        player: { credits: 50000, current_system: "Krynn" },
        ship: { hull: 90, max_hull: 100 },
        online: false, // offline / disconnected
      },
    });
    const app = createTestApp(cache);
    const res = await supertest(app).get("/api/fleet/capacity");

    expect(res.status).toBe(200);
    const agents: Record<string, unknown>[] = res.body.agents;
    const drifter = agents.find((a) => a.name === "drifter-gale");
    // Last-known system should persist across disconnect
    expect(drifter?.system).toBe("Krynn");
    expect(drifter?.online).toBe(false);
    expect(drifter?.isStale).toBe(true);
    // Zone from config should always be present
    expect(drifter?.zone).toBe("sol-belt");
  });

  test("cargoMax reads cargo_capacity field (game server field name)", async () => {
    const cache = makeStatusCache({
      "drifter-gale": {
        player: { credits: 10000 },
        ship: { cargo_used: 15, cargo_capacity: 120 }, // game server uses cargo_capacity
      },
    });
    const app = createTestApp(cache);
    const res = await supertest(app).get("/api/fleet/capacity");

    expect(res.status).toBe(200);
    const agents: Record<string, unknown>[] = res.body.agents;
    const drifter = agents.find((a) => a.name === "drifter-gale");
    expect(drifter?.cargoMax).toBe(120);
    expect(drifter?.cargoUsed).toBe(15);
  });
});
