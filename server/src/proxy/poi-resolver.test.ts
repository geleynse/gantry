import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolvePoiId, cacheSystemPois, systemPoiCache } from "./poi-resolver.js";
import { createDatabase, closeDb } from "../services/database.js";
import { getPoisBySystem } from "../services/galaxy-poi-registry.js";

function makeStatusCache(agentName: string, currentSystem: string) {
  const cache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
  cache.set(agentName, {
    data: { player: { current_system: currentSystem } },
    fetchedAt: Date.now(),
  });
  return cache;
}

describe("resolvePoiId", () => {
  beforeEach(() => {
    systemPoiCache.clear();
  });

  it("passes through raw POI IDs unchanged", () => {
    const cache = makeStatusCache("agent-1", "sys_0041");
    expect(resolvePoiId("agent-1", "poi_0041_002", cache)).toBe("poi_0041_002");
  });

  it("resolves exact name match (case-insensitive)", () => {
    const cache = makeStatusCache("agent-1", "sys_0041");
    systemPoiCache.set("sys_0041", [
      { id: "poi_0041_001", name: "Sol Belt", type: "asteroid_belt" },
      { id: "poi_0041_002", name: "Sol Station", type: "station" },
    ]);
    expect(resolvePoiId("agent-1", "sol station", cache)).toBe("poi_0041_002");
    expect(resolvePoiId("agent-1", "Sol Station", cache)).toBe("poi_0041_002");
    expect(resolvePoiId("agent-1", "SOL STATION", cache)).toBe("poi_0041_002");
  });

  it("resolves partial name match", () => {
    const cache = makeStatusCache("agent-1", "sys_0041");
    systemPoiCache.set("sys_0041", [
      { id: "poi_0041_001", name: "Sol Asteroid Belt Alpha", type: "asteroid_belt" },
      { id: "poi_0041_002", name: "Sol Central Station", type: "station" },
    ]);
    expect(resolvePoiId("agent-1", "central station", cache)).toBe("poi_0041_002");
  });

  it("falls through when no cache for current system", () => {
    const cache = makeStatusCache("agent-1", "sys_0041");
    // No POI cache populated
    expect(resolvePoiId("agent-1", "sol_station", cache)).toBe("sol_station");
  });

  it("falls through when agent not in statusCache", () => {
    const cache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
    expect(resolvePoiId("unknown-agent", "sol_station", cache)).toBe("sol_station");
  });

  it("falls through when no name matches", () => {
    const cache = makeStatusCache("agent-1", "sys_0041");
    systemPoiCache.set("sys_0041", [
      { id: "poi_0041_001", name: "Sol Belt", type: "asteroid_belt" },
    ]);
    expect(resolvePoiId("agent-1", "nonexistent_poi", cache)).toBe("nonexistent_poi");
  });

  it("prefers exact name match over partial", () => {
    const cache = makeStatusCache("agent-1", "sys_0041");
    systemPoiCache.set("sys_0041", [
      { id: "poi_0041_001", name: "Sol Station Outer Ring", type: "station" },
      { id: "poi_0041_002", name: "Sol Station", type: "station" },
    ]);
    expect(resolvePoiId("agent-1", "Sol Station", cache)).toBe("poi_0041_002");
  });

  it("resolves underscore-separated names to POI IDs via name normalization (sol_station bug)", () => {
    const cache = makeStatusCache("agent-1", "sys_0041");
    systemPoiCache.set("sys_0041", [
      { id: "poi_0041_001", name: "Sol Belt", type: "asteroid_belt" },
      { id: "poi_0041_002", name: "Sol Station", type: "station" },
      { id: "poi_0041_003", name: "Sol Central", type: "poi" },
    ]);
    // "sol_station" normalizes to "sol station" which matches "Sol Station"
    expect(resolvePoiId("agent-1", "sol_station", cache)).toBe("poi_0041_002");
    expect(resolvePoiId("agent-1", "sol_belt", cache)).toBe("poi_0041_001");
    expect(resolvePoiId("agent-1", "sol_central", cache)).toBe("poi_0041_003");
  });

  it("resolves via normalized POI ID match", () => {
    const cache = makeStatusCache("agent-1", "sys_0041");
    // If POI IDs themselves contain underscores/mixed case
    systemPoiCache.set("sys_0041", [
      { id: "Sol_Station", name: "Sol Main Station", type: "station" },
      { id: "Sol_Belt_Alpha", name: "Alpha Mining Belt", type: "asteroid_belt" },
    ]);
    expect(resolvePoiId("agent-1", "sol_station", cache)).toBe("Sol_Station");
    expect(resolvePoiId("agent-1", "sol_belt_alpha", cache)).toBe("Sol_Belt_Alpha");
  });

  it("resolves partial match against POI IDs", () => {
    const cache = makeStatusCache("agent-1", "sys_0041");
    systemPoiCache.set("sys_0041", [
      { id: "sol_central_station", name: "Main Hub", type: "station" },
      { id: "sol_belt_outer", name: "Outer Ring", type: "asteroid_belt" },
    ]);
    // "central_station" normalizes to "central station", partial match on ID "sol central station"
    expect(resolvePoiId("agent-1", "central_station", cache)).toBe("sol_central_station");
  });
});

describe("cacheSystemPois", () => {
  beforeEach(() => {
    systemPoiCache.clear();
  });

  it("caches POIs from a flat response", () => {
    cacheSystemPois({
      id: "sys_0041",
      name: "Sol",
      pois: [
        { id: "poi_0041_001", name: "Sol Belt", type: "asteroid_belt" },
        { id: "poi_0041_002", name: "Sol Station", type: "station" },
      ],
    });
    expect(systemPoiCache.get("sys_0041")).toHaveLength(2);
    expect(systemPoiCache.get("sys_0041")![0].id).toBe("poi_0041_001");
  });

  it("caches POIs from a wrapped response", () => {
    cacheSystemPois({
      system: {
        id: "sys_0041",
        name: "Sol",
        pois: [{ id: "poi_0041_001", name: "Sol Belt", type: "asteroid_belt" }],
      },
    });
    expect(systemPoiCache.get("sys_0041")).toHaveLength(1);
  });

  it("ignores null/undefined/non-object input", () => {
    cacheSystemPois(null);
    cacheSystemPois(undefined);
    cacheSystemPois("string");
    expect(systemPoiCache.size).toBe(0);
  });

  it("ignores responses without system id", () => {
    cacheSystemPois({ name: "Sol", pois: [{ id: "p1", name: "Belt", type: "belt" }] });
    expect(systemPoiCache.size).toBe(0);
  });
});

describe("cacheSystemPois — DB persistence", () => {
  beforeEach(() => {
    createDatabase(":memory:");
    systemPoiCache.clear();
  });

  afterEach(() => {
    closeDb();
  });

  it("persists POIs to the database", () => {
    cacheSystemPois({
      id: "sol",
      name: "Sol",
      pois: [
        { id: "poi_sol_001", name: "Sol Station", type: "station" },
        { id: "poi_sol_002", name: "Sol Belt", type: "asteroid_belt" },
      ],
    });
    const pois = getPoisBySystem("sol");
    expect(pois).toHaveLength(2);
    expect(pois.map(p => p.id).sort()).toEqual(["poi_sol_001", "poi_sol_002"].sort());
  });

  it("persists POIs from a wrapped response", () => {
    cacheSystemPois({
      system: {
        id: "alpha",
        name: "Alpha",
        pois: [{ id: "poi_alpha_001", name: "Alpha Station", type: "station" }],
      },
    });
    const pois = getPoisBySystem("alpha");
    expect(pois).toHaveLength(1);
    expect(pois[0].name).toBe("Alpha Station");
  });

  it("skips POIs with empty id", () => {
    cacheSystemPois({
      id: "sol",
      name: "Sol",
      pois: [
        { id: "", name: "Unnamed", type: "unknown" },
        { id: "poi_sol_001", name: "Sol Station", type: "station" },
      ],
    });
    const pois = getPoisBySystem("sol");
    expect(pois).toHaveLength(1);
    expect(pois[0].id).toBe("poi_sol_001");
  });
});
