/**
 * Tests for market reservation API endpoints.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import request from "supertest";
import express from "express";
import { createMarketRouter } from "./market.js";
import { MarketReservationCache } from "../../proxy/market-reservations.js";

// ---------------------------------------------------------------------------
// Minimal mocks for market router deps
// ---------------------------------------------------------------------------

function createMockDeps() {
  const marketReservations = new MarketReservationCache({ ttlMs: 60_000, pruneIntervalMs: 999_999_999 });
  return {
    marketCache: { get: () => ({ data: null, stale: false }) } as any,
    arbitrageAnalyzer: { getOpportunities: () => [] } as any,
    marketReservations,
  };
}

describe("Market Reservation API", () => {
  let deps: ReturnType<typeof createMockDeps>;
  let app: express.Express;

  beforeEach(() => {
    deps = createMockDeps();
    app = express();
    app.use(express.json());
    app.use("/api/market", createMarketRouter(deps));
  });

  afterEach(() => {
    deps.marketReservations.dispose();
  });

  it("GET /api/market/reservations returns empty list initially", async () => {
    const res = await request(app).get("/api/market/reservations");
    expect(res.status).toBe(200);
    expect(res.body.reservations).toEqual([]);
    expect(res.body.count).toBe(0);
  });

  it("GET /api/market/reservations returns active reservations", async () => {
    deps.marketReservations.reserve("alpha", "station-A", "iron_ore", 50);
    deps.marketReservations.reserve("beta", "station-B", "copper_ore", 30);

    const res = await request(app).get("/api/market/reservations");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.reservations).toHaveLength(2);
    const agents = res.body.reservations.map((r: any) => r.agent).sort();
    expect(agents).toEqual(["alpha", "beta"]);
  });

  it("DELETE /api/market/reservations/:agent clears agent reservations", async () => {
    deps.marketReservations.reserve("alpha", "station-A", "iron_ore", 50);
    deps.marketReservations.reserve("alpha", "station-B", "copper_ore", 30);
    deps.marketReservations.reserve("beta", "station-A", "iron_ore", 20);

    const res = await request(app).delete("/api/market/reservations/alpha");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify alpha's reservations are gone, beta's remain
    const after = await request(app).get("/api/market/reservations");
    expect(after.body.count).toBe(1);
    expect(after.body.reservations[0].agent).toBe("beta");
  });
});
