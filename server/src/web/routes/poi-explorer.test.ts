import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import request from "supertest";
import { createDatabase, closeDb } from "../../services/database.js";
import { registerPoi, markDockable } from "../../services/galaxy-poi-registry.js";
import express from "express";
import { createPoiExplorerRouter } from "./poi-explorer.js";

let app: express.Express;

beforeAll(() => {
  createDatabase(":memory:");

  registerPoi({ id: "sol_station", name: "Sol Station", system: "sol", type: "station", services: ["refuel", "market"] });
  markDockable("sol_station", true);
  registerPoi({ id: "main_belt", name: "Main Belt", system: "sol", type: "belt" });
  markDockable("main_belt", false);
  registerPoi({ id: "alpha_hub", name: "Alpha Hub", system: "alpha_centauri", type: "station" });

  app = express();
  app.use("/api/pois", createPoiExplorerRouter());
});

afterAll(() => {
  closeDb();
});

describe("GET /api/pois", () => {
  it("returns all known POIs with full metadata", async () => {
    const res = await request(app).get("/api/pois");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);

    const sol = res.body.find((p: { id: string }) => p.id === "sol_station");
    expect(sol.dockable).toBe(true);
    expect(sol.type).toBe("station");
    expect(sol.services).toContain("refuel");

    const belt = res.body.find((p: { id: string }) => p.id === "main_belt");
    expect(belt.dockable).toBe(false);

    const alpha = res.body.find((p: { id: string }) => p.id === "alpha_hub");
    expect(alpha.dockable).toBeNull();
  });

  it("filters by system with ?system= query param", async () => {
    const res = await request(app).get("/api/pois?system=sol");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.every((p: { system: string }) => p.system === "sol")).toBe(true);
  });
});

describe("GET /api/pois/systems", () => {
  it("returns explored systems with POI counts", async () => {
    const res = await request(app).get("/api/pois/systems");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);

    const sol = res.body.find((s: { system: string }) => s.system === "sol");
    expect(sol.poi_count).toBe(2);

    const alpha = res.body.find((s: { system: string }) => s.system === "alpha_centauri");
    expect(alpha.poi_count).toBe(1);
  });
});
