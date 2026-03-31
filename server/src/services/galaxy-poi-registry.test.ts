import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createDatabase, closeDb } from "./database.js";
import { registerPoi, getPoi, getPoisBySystem, markDockable, isDockable, getAllPois } from "./galaxy-poi-registry.js";

describe("galaxy-poi-registry", () => {
  beforeEach(() => { createDatabase(":memory:"); });
  afterEach(() => { closeDb(); });

  it("registerPoi stores and getPoi retrieves", () => {
    registerPoi({ id: "sol_station", name: "Sol Station", system: "sol", type: "station" });
    const poi = getPoi("sol_station");
    expect(poi).not.toBeNull();
    expect(poi!.name).toBe("Sol Station");
  });

  it("registerPoi upserts — preserves type via COALESCE", () => {
    registerPoi({ id: "sol_station", name: "Sol Station", system: "sol", type: "station" });
    registerPoi({ id: "sol_station", name: "Sol Station Updated", system: "sol" });
    const poi = getPoi("sol_station");
    expect(poi!.name).toBe("Sol Station Updated");
    expect(poi!.type).toBe("station");
  });

  it("markDockable sets dockable=true", () => {
    registerPoi({ id: "sol_station", name: "Sol Station", system: "sol", type: "station" });
    markDockable("sol_station", true);
    expect(isDockable("sol_station")).toBe(true);
  });

  it("markDockable sets dockable=false", () => {
    registerPoi({ id: "main_belt", name: "Main Belt", system: "sol", type: "belt" });
    markDockable("main_belt", false);
    expect(isDockable("main_belt")).toBe(false);
  });

  it("isDockable returns null for unknown POI", () => {
    expect(isDockable("nonexistent")).toBeNull();
  });

  it("isDockable returns null for POI with no dockable data", () => {
    registerPoi({ id: "new_poi", name: "New POI", system: "sol" });
    expect(isDockable("new_poi")).toBeNull();
  });

  it("markDockable upserts with fallback metadata", () => {
    markDockable("unknown_belt", false, { name: "Unknown Belt", system: "sol", type: "belt" });
    expect(isDockable("unknown_belt")).toBe(false);
    const poi = getPoi("unknown_belt");
    expect(poi).not.toBeNull();
    expect(poi!.name).toBe("Unknown Belt");
  });

  it("markDockable does nothing without fallback for unregistered POI", () => {
    markDockable("ghost_poi", false);
    expect(isDockable("ghost_poi")).toBeNull();
  });

  it("getAllPois returns all with dockable status", () => {
    registerPoi({ id: "sol_station", name: "Sol Station", system: "sol", type: "station" });
    markDockable("sol_station", true);
    registerPoi({ id: "main_belt", name: "Main Belt", system: "sol", type: "belt" });
    const all = getAllPois();
    expect(all).toHaveLength(2);
    const sol = all.find(p => p.id === "sol_station");
    expect(sol!.dockable).toBe(true);
    const belt = all.find(p => p.id === "main_belt");
    expect(belt!.dockable).toBeUndefined();
  });
});
