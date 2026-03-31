/**
 * Tests for the /api/facilities endpoint.
 */

import { describe, test, expect } from "bun:test";
import express from "express";
import supertest from "supertest";
import { createFacilitiesRouter } from "./facilities.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type StatusCacheEntry = { data: Record<string, unknown>; fetchedAt: number };

function makeCache(entries: Record<string, Record<string, unknown>>): Map<string, StatusCacheEntry> {
  const cache = new Map<string, StatusCacheEntry>();
  for (const [name, data] of Object.entries(entries)) {
    cache.set(name, { data, fetchedAt: Date.now() });
  }
  return cache;
}

function makeApp(cache: Map<string, StatusCacheEntry>) {
  const app = express();
  app.use(express.json());
  app.use("/api/facilities", createFacilitiesRouter(cache));
  return app;
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const NESTED_DATA = {
  player: {
    credits: 5000,
    current_system: "Krynn",
    current_poi: "Krynn Station Alpha",
    station_facilities: [
      { id: "station_fab_1", name: "Fabricator Mk2", type: "fabricator", level: 2, status: "active" },
      { id: "station_market_1", name: "Trade Exchange", type: "market", status: "active" },
    ],
    owned_facilities: [
      { id: "mine_001", name: "My Iron Mine", type: "mine", level: 1, system: "Krynn", poi: "Asteroid Belt A" },
    ],
    buildable_facilities: [
      { id: "refinery", name: "Refinery", type: "refinery" },
    ],
    faction_facilities: [
      { id: "faction_hub", name: "Faction HQ", type: "hub", owner: "Iron Brotherhood" },
    ],
  },
  ship: {
    hull: 95, max_hull: 100, fuel: 80, max_fuel: 100,
    cargo_used: 10, cargo_capacity: 100,
  },
};

// ---------------------------------------------------------------------------
// Tests: empty cache
// ---------------------------------------------------------------------------

describe("GET /api/facilities — empty cache", () => {
  const app = makeApp(new Map());

  test("returns 200 with empty facilities list", async () => {
    const res = await supertest(app).get("/api/facilities");
    expect(res.status).toBe(200);
    expect(res.body.facilities).toEqual([]);
    expect(res.body.cachedAt).toBeNull();
  });

  test("tab defaults to station", async () => {
    const res = await supertest(app).get("/api/facilities?agent=nobody");
    expect(res.status).toBe(200);
    expect(res.body.tab).toBe("station");
  });
});

// ---------------------------------------------------------------------------
// Tests: station tab
// ---------------------------------------------------------------------------

describe("GET /api/facilities?tab=station", () => {
  const cache = makeCache({ "drifter-gale": NESTED_DATA });
  const app = makeApp(cache);

  test("returns station facilities", async () => {
    const res = await supertest(app).get("/api/facilities?agent=drifter-gale&tab=station");
    expect(res.status).toBe(200);
    expect(res.body.tab).toBe("station");
    expect(res.body.agent).toBe("drifter-gale");
    expect(res.body.facilities).toHaveLength(2);
    expect(res.body.cachedAt).toBeTruthy();
  });

  test("normalises facility fields", async () => {
    const res = await supertest(app).get("/api/facilities?agent=drifter-gale&tab=station");
    const fac = res.body.facilities[0];
    expect(fac.id).toBe("station_fab_1");
    expect(fac.name).toBe("Fabricator Mk2");
    expect(fac.type).toBe("fabricator");
    expect(fac.level).toBe(2);
    expect(fac.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// Tests: owned tab
// ---------------------------------------------------------------------------

describe("GET /api/facilities?tab=owned", () => {
  const cache = makeCache({ "drifter-gale": NESTED_DATA });
  const app = makeApp(cache);

  test("returns owned facilities", async () => {
    const res = await supertest(app).get("/api/facilities?agent=drifter-gale&tab=owned");
    expect(res.status).toBe(200);
    expect(res.body.facilities).toHaveLength(1);
    const fac = res.body.facilities[0];
    expect(fac.id).toBe("mine_001");
    expect(fac.name).toBe("My Iron Mine");
    expect(fac.system).toBe("Krynn");
    expect(fac.poi).toBe("Asteroid Belt A");
  });
});

// ---------------------------------------------------------------------------
// Tests: build tab
// ---------------------------------------------------------------------------

describe("GET /api/facilities?tab=build", () => {
  const cache = makeCache({ "drifter-gale": NESTED_DATA });
  const app = makeApp(cache);

  test("returns buildable facility types", async () => {
    const res = await supertest(app).get("/api/facilities?agent=drifter-gale&tab=build");
    expect(res.status).toBe(200);
    expect(res.body.facilities).toHaveLength(1);
    expect(res.body.facilities[0].name).toBe("Refinery");
  });
});

// ---------------------------------------------------------------------------
// Tests: faction tab
// ---------------------------------------------------------------------------

describe("GET /api/facilities?tab=faction", () => {
  const cache = makeCache({ "drifter-gale": NESTED_DATA });
  const app = makeApp(cache);

  test("returns faction facilities", async () => {
    const res = await supertest(app).get("/api/facilities?agent=drifter-gale&tab=faction");
    expect(res.status).toBe(200);
    expect(res.body.facilities).toHaveLength(1);
    const fac = res.body.facilities[0];
    expect(fac.owner).toBe("Iron Brotherhood");
  });
});

// ---------------------------------------------------------------------------
// Tests: flat data format (no player wrapper)
// ---------------------------------------------------------------------------

describe("GET /api/facilities — flat data format", () => {
  const flatData = {
    credits: 2000,
    current_system: "Velox",
    station_facilities: [
      { id: "silo_1", name: "Storage Silo", type: "storage" },
    ],
  };

  const cache = makeCache({ "rust-vane": flatData });
  const app = makeApp(cache);

  test("handles flat data without player wrapper", async () => {
    const res = await supertest(app).get("/api/facilities?agent=rust-vane&tab=station");
    expect(res.status).toBe(200);
    expect(res.body.facilities).toHaveLength(1);
    expect(res.body.facilities[0].name).toBe("Storage Silo");
  });
});

// ---------------------------------------------------------------------------
// Tests: nested facilities wrapper format
// ---------------------------------------------------------------------------

describe("GET /api/facilities — facilities-wrapper format", () => {
  const wrappedData = {
    player: {
      credits: 3000,
      facilities: {
        station: [{ id: "f1", name: "Armory", type: "armory" }],
        owned: [{ id: "f2", name: "Personal Lab", type: "lab" }],
      },
    },
  };

  const cache = makeCache({ "lumen-shoal": wrappedData });
  const app = makeApp(cache);

  test("extracts station from nested facilities object", async () => {
    const res = await supertest(app).get("/api/facilities?agent=lumen-shoal&tab=station");
    expect(res.status).toBe(200);
    expect(res.body.facilities).toHaveLength(1);
    expect(res.body.facilities[0].name).toBe("Armory");
  });

  test("extracts owned from nested facilities object", async () => {
    const res = await supertest(app).get("/api/facilities?agent=lumen-shoal&tab=owned");
    expect(res.status).toBe(200);
    expect(res.body.facilities).toHaveLength(1);
    expect(res.body.facilities[0].name).toBe("Personal Lab");
  });
});

// ---------------------------------------------------------------------------
// Tests: unknown agent
// ---------------------------------------------------------------------------

describe("GET /api/facilities — unknown agent", () => {
  const cache = makeCache({ "drifter-gale": NESTED_DATA });
  const app = makeApp(cache);

  test("returns empty facilities for unknown agent", async () => {
    const res = await supertest(app).get("/api/facilities?agent=unknown-agent&tab=station");
    expect(res.status).toBe(200);
    expect(res.body.facilities).toEqual([]);
    expect(res.body.agent).toBe("unknown-agent");
  });
});

// ---------------------------------------------------------------------------
// Tests: response shape
// ---------------------------------------------------------------------------

describe("GET /api/facilities — response shape", () => {
  const cache = makeCache({ "drifter-gale": NESTED_DATA });
  const app = makeApp(cache);

  test("response always has required fields", async () => {
    const res = await supertest(app).get("/api/facilities?agent=drifter-gale");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("tab");
    expect(res.body).toHaveProperty("agent");
    expect(res.body).toHaveProperty("facilities");
    expect(res.body).toHaveProperty("cachedAt");
    expect(Array.isArray(res.body.facilities)).toBe(true);
  });
});
