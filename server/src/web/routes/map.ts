import { Router } from "express";
import { createLogger } from '../../lib/logger.js';
import { getExploredSystems } from '../../services/analytics-query.js';
import { classifyConnections, getWormholes } from '../../services/wormhole-classifier.js';
import { getPoisBySystem } from '../../services/galaxy-poi-registry.js';

const log = createLogger('map');

const GANTRY_URL = process.env.GANTRY_URL || "http://localhost:3100";
const GAME_MAP_URL = "https://game.spacemolt.com/api/map";
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

interface MapCache {
  data: unknown;
  fetchedAt: number;
}

interface MapSystem {
  id: string;
  name: string;
  x: number;
  y: number;
  empire?: string;
  connections: string[];
}

interface MapAgentState {
  player?: {
    current_system?: string;
    current_poi?: string;
    docked_at_base?: string | null;
  };
  ship?: {
    class_id?: string;
  };
  current_system?: string;
  current_poi?: string;
  docked_at_base?: string | null;
}

/**
 * Create the map router with its own cache instance.
 * Each call returns a fresh router with independent cache state.
 */
export function createMapRouter(): Router {
  let mapCache: MapCache | null = null;

  const router = Router();

  // GET /api/map — Galaxy topology
  router.get("/", async (_req, res) => {
    try {
      if (mapCache && Date.now() - mapCache.fetchedAt < CACHE_TTL) {
        res.json(mapCache.data);
        return;
      }

      const resp = await fetch(GAME_MAP_URL, {
        signal: AbortSignal.timeout(5000),
      });

      if (!resp.ok) {
        res
          .status(502)
          .json({
            error: `Failed to fetch map: ${resp.status} ${resp.statusText}`,
          });
        return;
      }

      const data = await resp.json();
      mapCache = { data, fetchedAt: Date.now() };
      res.json(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: `Map fetch failed: ${message}` });
    }
  });

  // GET /api/map/positions — Agent positions
  router.get("/positions", async (_req, res) => {
    try {
      const resp = await fetch(`${GANTRY_URL}/game-state/all`, {
        signal: AbortSignal.timeout(3000),
      });

      if (!resp.ok) {
        res.status(resp.status).json({});
        return;
      }

      const data: Record<string, MapAgentState> = await resp.json();
      const result: Record<
        string,
        { system: string; poi: string | null; docked: boolean; shipClass: string | null }
      > = {};

      for (const [agent, raw] of Object.entries(data)) {
        // Support both nested player format and flat format
        const system = raw?.player?.current_system ?? raw?.current_system;
        if (!system) continue;

        const poi = raw.player?.current_poi ?? raw.current_poi ?? null;
        const docked = !!(raw.player?.docked_at_base ?? raw.docked_at_base);
        const shipClass = raw?.ship?.class_id ?? null;

        result[agent] = {
          system,
          poi,
          docked,
          shipClass,
        };
      }

      res.json(result);
    } catch (err) {
      log.warn('Failed to fetch agent positions', { error: err instanceof Error ? err.message : String(err) });
      res.json({});
    }
  });

  // GET /api/map/explored-systems — Systems visited by any agent (for fog-of-war)
  router.get("/explored-systems", (_req, res) => {
    try {
      const systems = getExploredSystems();
      res.json(systems);
    } catch (err) {
      log.warn('Failed to fetch explored systems', { error: err instanceof Error ? err.message : String(err) });
      res.json([]);
    }
  });

  // GET /api/map/wormholes — Connections classified as wormholes
  router.get("/wormholes", async (_req, res) => {
    try {
      // Get map data (use cache if available)
      let mapSystems: MapSystem[];
      if (mapCache && Date.now() - mapCache.fetchedAt < CACHE_TTL) {
        mapSystems = (mapCache.data as { systems: MapSystem[] }).systems ?? [];
      } else {
        const resp = await fetch(GAME_MAP_URL, { signal: AbortSignal.timeout(5000) });
        if (!resp.ok) {
          res.json([]);
          return;
        }
        const data = await resp.json() as { systems: MapSystem[] };
        mapCache = { data, fetchedAt: Date.now() };
        mapSystems = data.systems ?? [];
      }

      // Build deduplicated connection pairs
      const seen = new Set<string>();
      const connections: Array<[string, string]> = [];
      for (const sys of mapSystems) {
        for (const conn of sys.connections) {
          const key = sys.id < conn ? `${sys.id}:${conn}` : `${conn}:${sys.id}`;
          if (!seen.has(key)) {
            seen.add(key);
            connections.push(sys.id < conn ? [sys.id, conn] : [conn, sys.id]);
          }
        }
      }

      const coords = mapSystems.map(s => ({ id: s.id, x: s.x, y: s.y }));
      const classification = classifyConnections(coords, connections);
      const wormholes = getWormholes(classification);
      res.json(wormholes);
    } catch (err) {
      log.warn('Failed to classify wormholes', { error: err instanceof Error ? err.message : String(err) });
      res.json([]);
    }
  });

  // GET /api/map/system-detail?system=<id> — Consolidated system info for popup
  router.get("/system-detail", async (req, res) => {
    const systemId = req.query.system as string;
    if (!systemId) {
      res.status(400).json({ error: "system parameter required" });
      return;
    }

    try {
      // Get map data for system info
      let mapSystems: MapSystem[] = [];
      if (mapCache && Date.now() - mapCache.fetchedAt < CACHE_TTL) {
        mapSystems = (mapCache.data as { systems: MapSystem[] }).systems ?? [];
      } else {
        const resp = await fetch(GAME_MAP_URL, { signal: AbortSignal.timeout(5000) });
        if (resp.ok) {
          const data = await resp.json() as { systems: MapSystem[] };
          mapCache = { data, fetchedAt: Date.now() };
          mapSystems = data.systems ?? [];
        }
      }

      const system = mapSystems.find(s => s.id === systemId);
      if (!system) {
        res.status(404).json({ error: "system not found" });
        return;
      }

      // Get POIs from galaxy_pois table
      const pois = getPoisBySystem(systemId);

      // Get agent positions
      let agents: Array<{ name: string; poi: string | null; docked: boolean; shipClass: string | null }> = [];
      try {
        const stateResp = await fetch(`${GANTRY_URL}/game-state/all`, {
          signal: AbortSignal.timeout(3000),
        });
        if (stateResp.ok) {
          const stateData: Record<string, MapAgentState> = await stateResp.json();
          for (const [name, raw] of Object.entries(stateData)) {
            const agentSystem = raw?.player?.current_system ?? raw?.current_system;
            if (agentSystem === systemId) {
              agents.push({
                name,
                poi: raw.player?.current_poi ?? raw.current_poi ?? null,
                docked: !!(raw.player?.docked_at_base ?? raw.docked_at_base),
                shipClass: raw?.ship?.class_id ?? null,
              });
            }
          }
        }
      } catch {
        // Non-fatal
      }

      // Connected system names
      const systemById = Object.fromEntries(mapSystems.map(s => [s.id, s]));
      const connections = system.connections.map(id => ({
        id,
        name: systemById[id]?.name ?? id,
        empire: systemById[id]?.empire,
      }));

      res.json({
        id: system.id,
        name: system.name,
        empire: system.empire ?? null,
        x: system.x,
        y: system.y,
        pois: pois.map(p => ({
          id: p.id,
          name: p.name,
          type: p.type ?? null,
          services: p.services ?? [],
        })),
        agents,
        connections,
      });
    } catch (err) {
      log.warn('Failed to fetch system detail', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: "Failed to fetch system detail" });
    }
  });

  return router;
}

// Default instance for backward compatibility with route-config.ts
export default createMapRouter();
