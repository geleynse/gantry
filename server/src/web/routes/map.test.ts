import { mock, describe, it, expect, beforeEach } from "bun:test";
import request from "supertest";
import express from "express";
import { createMapRouter } from "./map.js";

// Mock analytics-query module
const mockGetExploredSystems = mock(() => ["sol", "vega", "alpha"]);
mock.module("../../services/analytics-query.js", () => ({
  getExploredSystems: mockGetExploredSystems,
}));

// Mock galaxy-poi-registry module
const mockGetPoisBySystem = mock((): { id: string; name: string; system: string; type?: string }[] => []);
mock.module("../../services/galaxy-poi-registry.js", () => ({
  getPoisBySystem: mockGetPoisBySystem,
}));

// Mock global fetch
const mockFetch = mock<() => Promise<Response>>(() => Promise.resolve(new Response()));
globalThis.fetch = mockFetch as unknown as typeof fetch;

function createApp() {
  const app = express();
  app.use(express.json());
  // Each test gets a fresh router with its own cache
  app.use("/api/map", createMapRouter());
  return app;
}

describe("Map routes", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe("GET /api/map", () => {
    it("returns galaxy topology from game server", async () => {
      const mapData = {
        systems: [{ id: "sol", name: "Sol" }],
        links: [{ source: "sol", target: "alpha" }],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mapData),
      } as unknown as Response);

      const app = createApp();
      const res = await request(app).get("/api/map");

      expect(res.status).toBe(200);
      expect(res.body).toEqual(mapData);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://game.spacemolt.com/api/map",
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it("returns cached data on subsequent requests", async () => {
      const mapData = { systems: [{ id: "sol" }] };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mapData),
      } as unknown as Response);

      const app = createApp();
      await request(app).get("/api/map");
      const res = await request(app).get("/api/map");

      expect(res.status).toBe(200);
      expect(res.body).toEqual(mapData);
      expect(mockFetch).toHaveBeenCalledTimes(1); // Only one fetch
    });

    it("returns 502 when game server fails", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      } as unknown as Response);

      const app = createApp();
      const res = await request(app).get("/api/map");

      expect(res.status).toBe(502);
      expect(res.body.error).toContain("Failed to fetch map");
    });

    it("returns 502 on network error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Connection refused"));

      const app = createApp();
      const res = await request(app).get("/api/map");

      expect(res.status).toBe(502);
      expect(res.body.error).toContain("Connection refused");
    });
  });

  describe("GET /api/map/positions", () => {
    it("returns agent positions from proxy", async () => {
      const gameState = {
        "drifter-gale": {
          player: {
            current_system: "Sol",
            current_poi: "Station Alpha",
            docked_at_base: "station_01",
          },
        },
        "sable-thorn": {
          player: {
            current_system: "Vega",
            current_poi: null,
            docked_at_base: null,
          },
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(gameState),
      } as unknown as Response);

      const app = createApp();
      const res = await request(app).get("/api/map/positions");

      expect(res.status).toBe(200);
      expect(res.body["drifter-gale"]).toEqual({
        system: "Sol",
        poi: "Station Alpha",
        docked: true,
        shipClass: null,
      });
      expect(res.body["sable-thorn"]).toEqual({
        system: "Vega",
        poi: null,
        docked: false,
        shipClass: null,
      });
    });

    it("skips agents without current_system", async () => {
      const gameState = {
        "drifter-gale": { player: { current_system: "Sol" } },
        "sable-thorn": { player: {} },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(gameState),
      } as unknown as Response);

      const app = createApp();
      const res = await request(app).get("/api/map/positions");

      expect(res.status).toBe(200);
      expect(res.body["drifter-gale"]).toBeDefined();
      expect(res.body["sable-thorn"]).toBeUndefined();
    });

    it("returns empty object on fetch error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("timeout"));

      const app = createApp();
      const res = await request(app).get("/api/map/positions");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({});
    });

    it("includes shipClass in response", async () => {
      const gameState = {
        "drifter-gale": {
          player: {
            current_system: "Sol",
            current_poi: null,
            docked_at_base: null,
          },
          ship: {
            class_id: "corvette",
          },
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(gameState),
      } as unknown as Response);

      const app = createApp();
      const res = await request(app).get("/api/map/positions");

      expect(res.status).toBe(200);
      expect(res.body["drifter-gale"].shipClass).toBe("corvette");
    });
  });

  describe("GET /api/map/explored-systems", () => {
    it("returns explored systems from analytics query", async () => {
      const app = createApp();
      const res = await request(app).get("/api/map/explored-systems");

      expect(res.status).toBe(200);
      expect(res.body).toEqual(["sol", "vega", "alpha"]);
    });

    it("returns empty array on error", async () => {
      mockGetExploredSystems.mockImplementationOnce(() => { throw new Error("db error"); });

      const app = createApp();
      const res = await request(app).get("/api/map/explored-systems");

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe("GET /api/map/wormholes", () => {
    it("returns wormhole pairs based on map data", async () => {
      // Build a chain of close systems + one far outlier so it exceeds 2.5 stddev
      const systems = [];
      const numNormal = 12;
      for (let i = 0; i < numNormal; i++) {
        systems.push({
          id: `s${i}`, name: `S${i}`, x: i, y: 0,
          connections: i > 0 ? [`s${i - 1}`] : [],
        });
        if (i > 0) systems[i - 1].connections.push(`s${i}`);
      }
      // Add a far system connected to s0
      systems.push({ id: "far", name: "Far", x: 500, y: 0, connections: ["s0"] });
      systems[0].connections.push("far");

      const mapData = { systems };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mapData),
      } as unknown as Response);

      const app = createApp();
      const res = await request(app).get("/api/map/wormholes");

      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThan(0);
      const wormhole = res.body.find((w: { systemA: string; systemB: string }) =>
        w.systemA === "far" || w.systemB === "far");
      expect(wormhole).toBeDefined();
    });
  });

  describe("GET /api/map/system-detail", () => {
    it("returns 400 without system parameter", async () => {
      const app = createApp();
      const res = await request(app).get("/api/map/system-detail");

      expect(res.status).toBe(400);
    });

    it("returns system detail with POIs and agents", async () => {
      const mapData = {
        systems: [
          { id: "sol", name: "Sol", x: 0, y: 0, empire: "solarian", connections: ["vega"] },
          { id: "vega", name: "Vega", x: 1, y: 0, connections: ["sol"] },
        ],
      };

      // First call: map data. Second call: game-state/all
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mapData),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            "drifter-gale": {
              player: { current_system: "sol", current_poi: "Station" },
              ship: { class_id: "frigate" },
            },
          }),
        } as unknown as Response);

      mockGetPoisBySystem.mockReturnValueOnce([
        { id: "station-1", name: "Sol Station", system: "sol", type: "station" },
      ]);

      const app = createApp();
      const res = await request(app).get("/api/map/system-detail?system=sol");

      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Sol");
      expect(res.body.empire).toBe("solarian");
      expect(res.body.pois).toHaveLength(1);
      expect(res.body.agents).toHaveLength(1);
      expect(res.body.agents[0].name).toBe("drifter-gale");
      expect(res.body.connections).toHaveLength(1);
      expect(res.body.connections[0].name).toBe("Vega");
    });

    it("returns 404 for unknown system", async () => {
      const mapData = {
        systems: [{ id: "sol", name: "Sol", x: 0, y: 0, connections: [] }],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mapData),
      } as unknown as Response);

      const app = createApp();
      const res = await request(app).get("/api/map/system-detail?system=unknown");

      expect(res.status).toBe(404);
    });
  });
});
