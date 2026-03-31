import { Router } from "express";
import { queryAll } from "../../services/database.js";
import { queryString } from "../middleware/query-helpers.js";

interface PoiRow {
  id: string;
  name: string;
  system: string;
  type: string | null;
  services_json: string | null;
  dockable: number | null;
  updated_at: string;
}

function formatPoi(row: PoiRow) {
  return {
    id: row.id,
    name: row.name,
    system: row.system,
    type: row.type,
    services: row.services_json ? JSON.parse(row.services_json) : null,
    dockable: row.dockable === null ? null : row.dockable === 1,
    updated_at: row.updated_at,
  };
}

export function createPoiExplorerRouter(): Router {
  const router = Router();

  // GET /api/pois — all known POIs, optionally filtered by system
  router.get("/", (req, res) => {
    const system = queryString(req, 'system');
    const rows = system
      ? queryAll<PoiRow>("SELECT * FROM galaxy_pois WHERE system = ? ORDER BY name", system)
      : queryAll<PoiRow>("SELECT * FROM galaxy_pois ORDER BY system, name");
    res.json(rows.map(formatPoi));
  });

  // GET /api/pois/systems — explored systems with POI counts
  router.get("/systems", (_req, res) => {
    const rows = queryAll<{ system: string; poi_count: number }>(
      "SELECT system, COUNT(*) as poi_count FROM galaxy_pois GROUP BY system ORDER BY system"
    );
    res.json(rows);
  });

  return router;
}
