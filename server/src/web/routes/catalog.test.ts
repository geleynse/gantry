/**
 * Tests for the /api/catalog endpoint.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import express from "express";
import supertest from "supertest";
import { createDatabase, closeDb } from "../../services/database.js";
import { setCatalogForTesting } from "../../services/game-catalog.js";
import { createCatalogRouter } from "./catalog.js";

// ---------------------------------------------------------------------------
// Setup: in-memory DB with test items
// ---------------------------------------------------------------------------

beforeAll(() => {
  createDatabase(":memory:");

  setCatalogForTesting({
    fetched_at: new Date().toISOString(),
    recipes: [],
    ships: [],
    items: [
      { id: "iron_ore", name: "Iron Ore", type: "ore", mass: 2, value: 10, legality: "legal", base_price: 50 },
      { id: "laser_cannon", name: "Laser Cannon", type: "weapon", mass: 5, value: 500, legality: "legal", base_price: 1200 },
      { id: "shield_gen", name: "Shield Generator", type: "shield", mass: 8, value: 800, legality: "legal", base_price: 2000 },
      { id: "dark_matter", name: "Dark Matter", type: "contraband", mass: 1, value: 5000, legality: "illegal", base_price: 10000 },
      { id: "scanner_mk2", name: "Deep Scanner Mk2", type: "scanner", mass: 3, value: 300, legality: "legal", base_price: 800 }
    ] as any[]
  });
});

afterAll(() => {
  setCatalogForTesting(null);
  closeDb();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type StatusCacheEntry = { data: Record<string, unknown>; fetchedAt: number };

function makeApp(cache: Map<string, StatusCacheEntry> = new Map()) {
  const app = express();
  app.use(express.json());
  app.use("/api/catalog", createCatalogRouter(cache));
  return app;
}

// ---------------------------------------------------------------------------
// Tests: list all
// ---------------------------------------------------------------------------

describe("GET /api/catalog — list all", () => {
  const app = makeApp();

  test("returns 200 with items array", async () => {
    const res = await supertest(app).get("/api/catalog");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("items");
    expect(res.body).toHaveProperty("total");
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.total).toBeGreaterThan(0);
  });

  test("items have required fields", async () => {
    const res = await supertest(app).get("/api/catalog");
    const item = res.body.items[0];
    expect(item).toHaveProperty("id");
    expect(item).toHaveProperty("name");
    expect(item).toHaveProperty("is_module");
    expect(item).toHaveProperty("compatible_slots");
    expect(Array.isArray(item.compatible_slots)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: lookup by id
// ---------------------------------------------------------------------------

describe("GET /api/catalog?id=<item_id>", () => {
  const app = makeApp();

  test("returns item by exact id", async () => {
    const res = await supertest(app).get("/api/catalog?id=iron_ore");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    const item = res.body.items[0];
    expect(item.id).toBe("iron_ore");
    expect(item.name).toBe("Iron Ore");
    expect(item.type).toBe("ore");
    expect(item.mass).toBe(2);
    expect(item.value).toBe(10);
    expect(item.legality).toBe("legal");
    expect(item.base_price).toBe(50);
  });

  test("marks weapons as modules with weapon slot", async () => {
    const res = await supertest(app).get("/api/catalog?id=laser_cannon");
    expect(res.status).toBe(200);
    const item = res.body.items[0];
    expect(item.is_module).toBe(true);
    expect(item.compatible_slots).toContain("weapon");
  });

  test("marks shields as modules with defense slot", async () => {
    const res = await supertest(app).get("/api/catalog?id=shield_gen");
    expect(res.status).toBe(200);
    const item = res.body.items[0];
    expect(item.is_module).toBe(true);
    expect(item.compatible_slots).toContain("defense");
  });

  test("marks scanners as modules with utility slot", async () => {
    const res = await supertest(app).get("/api/catalog?id=scanner_mk2");
    expect(res.status).toBe(200);
    const item = res.body.items[0];
    expect(item.is_module).toBe(true);
    expect(item.compatible_slots).toContain("utility");
  });

  test("marks ore as non-module", async () => {
    const res = await supertest(app).get("/api/catalog?id=iron_ore");
    const item = res.body.items[0];
    expect(item.is_module).toBe(false);
    expect(item.compatible_slots).toHaveLength(0);
  });

  test("returns 404 for unknown item", async () => {
    const res = await supertest(app).get("/api/catalog?id=does_not_exist");
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });
});

// ---------------------------------------------------------------------------
// Tests: search
// ---------------------------------------------------------------------------

describe("GET /api/catalog?search=<query>", () => {
  const app = makeApp();

  test("finds items by partial name match", async () => {
    const res = await supertest(app).get("/api/catalog?search=iron");
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThan(0);
    expect(res.body.items.some((i: { name: string }) => i.name.toLowerCase().includes("iron"))).toBe(true);
  });

  test("finds items by type match", async () => {
    const res = await supertest(app).get("/api/catalog?search=weapon");
    expect(res.status).toBe(200);
    expect(res.body.items.some((i: { type?: string }) => i.type === "weapon")).toBe(true);
  });

  test("returns empty list for no matches", async () => {
    const res = await supertest(app).get("/api/catalog?search=xyz_no_match_12345");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: module_compat type
// ---------------------------------------------------------------------------

describe("GET /api/catalog?type=module_compat", () => {
  const app = makeApp();

  test("returns only items that are modules", async () => {
    const res = await supertest(app).get("/api/catalog?type=module_compat");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    // All returned items should be modules
    for (const item of res.body.items) {
      expect(item.is_module).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: statusCache enriches module detection
// ---------------------------------------------------------------------------

describe("GET /api/catalog — statusCache module detection", () => {
  test("items appearing as equipped modules are marked as modules", async () => {
    const cache = new Map<string, StatusCacheEntry>([
      ["drifter-gale", {
        data: {
          ship: {
            modules: [{ item_id: "iron_ore", item_name: "Iron Ore" }],
          },
        },
        fetchedAt: Date.now(),
      }],
    ]);
    const app = makeApp(cache);

    const res = await supertest(app).get("/api/catalog?id=iron_ore");
    expect(res.status).toBe(200);
    // iron_ore is in the modules list in this cache, so is_module should be true
    expect(res.body.items[0].is_module).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: illegal items
// ---------------------------------------------------------------------------

describe("GET /api/catalog — legality", () => {
  const app = makeApp();

  test("returns illegal items with legality field set", async () => {
    const res = await supertest(app).get("/api/catalog?id=dark_matter");
    expect(res.status).toBe(200);
    expect(res.body.items[0].legality).toBe("illegal");
  });
});
