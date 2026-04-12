/**
 * Facilities API route.
 *
 * GET /api/facilities?agent=&tab=station|owned|build|faction
 *
 * Returns facility data from the status cache (proxy_game_state or statusCache).
 * - station: facilities at the agent's current docked station
 * - owned:   facilities personally owned by the agent
 * - build:   buildable facility types (from catalog knowledge)
 * - faction: faction-owned facilities in the current system
 *
 * Mount: router.use("/facilities", createFacilitiesRouter(statusCache))
 */

import { Router } from "express";
import { queryString } from "../middleware/query-helpers.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("facilities");

type StatusCacheEntry = { data: Record<string, unknown>; fetchedAt: number };
type StatusCache = Map<string, StatusCacheEntry>;

/** A single facility record normalised from game state. */
export interface FacilityRecord {
  id?: string;
  name?: string;
  type?: string;
  level?: number;
  system?: string;
  poi?: string;
  owner?: string;
  status?: string;
  production?: unknown;
  upgrades?: unknown;
  raw?: unknown;
}

export interface FacilitiesResponse {
  tab: string;
  agent: string | null;
  facilities: FacilityRecord[];
  /** ISO timestamp of the cached data, or null if no cache entry */
  cachedAt: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pull nested player / ship data from the cache entry, tolerating both flat
 *  and nested (player-wrapper) formats. */
function getPlayer(data: Record<string, unknown>): Record<string, unknown> {
  return (data.player ?? data) as Record<string, unknown>;
}

function getShip(data: Record<string, unknown>): Record<string, unknown> {
  const player = getPlayer(data);
  return (data.ship ?? player.ship ?? {}) as Record<string, unknown>;
}

/** Normalise an arbitrary facility object from the game state. */
function normaliseFacility(raw: unknown): FacilityRecord {
  if (!raw || typeof raw !== "object") return { raw };
  const f = raw as Record<string, unknown>;
  return {
    id: f.id as string | undefined ?? f.facility_id as string | undefined,
    name: f.name as string | undefined ?? f.facility_name as string | undefined,
    type: f.type as string | undefined ?? f.facility_type as string | undefined,
    level: f.level as number | undefined,
    system: f.system as string | undefined,
    poi: f.poi as string | undefined ?? f.station as string | undefined,
    owner: f.owner as string | undefined,
    status: f.status as string | undefined,
    production: f.production,
    upgrades: f.upgrades,
    raw,
  };
}

function normaliseFacilities(raw: unknown): FacilityRecord[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(normaliseFacility);
  if (typeof raw === "object") {
    // Some game responses wrap lists in an object: { facilities: [...] }
    const obj = raw as Record<string, unknown>;
    const inner = obj.facilities ?? obj.items ?? obj.list;
    if (Array.isArray(inner)) return inner.map(normaliseFacility);
    // Fall back to treating the keys as individual records
    return Object.values(obj).map(normaliseFacility);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createFacilitiesRouter(statusCache: StatusCache): Router {
  const router = Router();

  /**
   * GET /api/facilities
   *
   * Query params:
   *   agent  - (optional) agent name; defaults to first agent in cache
   *   tab    - station | owned | build | faction  (default: station)
   */
  router.get("/", (req, res) => {
    const agentParam = queryString(req, "agent");
    const tab = queryString(req, "tab") ?? "station";

    // Resolve agent — use the requested agent or fall back to the first cached entry
    const agentName = agentParam && statusCache.has(agentParam)
      ? agentParam
      : agentParam ?? null;

    const cached = agentName ? statusCache.get(agentName) : null;

    if (!cached) {
      const response: FacilitiesResponse = {
        tab,
        agent: agentName,
        facilities: [],
        cachedAt: null,
      };
      return res.json(response);
    }

    const data = cached.data;
    const player = getPlayer(data);
    const cachedAt = new Date(cached.fetchedAt).toISOString();

    let facilities: FacilityRecord[] = [];

    // Facilities may be nested under player.facilities.{station,owned,...} or at player level
    const playerFacilitiesMap = (player.facilities ?? data.facilities) as Record<string, unknown> | undefined;

    switch (tab) {
      case "owned": {
        // Personal facilities: player.owned_facilities or player.facilities.owned
        const owned = player.owned_facilities
          ?? playerFacilitiesMap?.owned
          ?? data.owned_facilities;
        facilities = normaliseFacilities(owned);
        break;
      }

      case "build": {
        // Buildable facility types
        const buildable = player.buildable_facilities
          ?? playerFacilitiesMap?.build
          ?? player.facility_types
          ?? data.facility_types
          ?? data.buildable_facilities;
        facilities = normaliseFacilities(buildable);
        break;
      }

      case "faction": {
        // Faction facilities
        const faction = player.faction_facilities
          ?? playerFacilitiesMap?.faction
          ?? data.faction_facilities;
        facilities = normaliseFacilities(faction);
        break;
      }

      case "station":
      default: {
        // Station facilities at the current docked location
        const ship = getShip(data);
        const station = player.station_facilities
          ?? ship.station_facilities
          ?? playerFacilitiesMap?.station
          ?? data.station_facilities
          ?? player.nearby_facilities;
        facilities = normaliseFacilities(station);
        break;
      }
    }

    log.debug(`[${agentName}] facilities tab=${tab} count=${facilities.length}`);

    const response: FacilitiesResponse = {
      tab,
      agent: agentName,
      facilities,
      cachedAt,
    };
    res.json(response);
  });

  return router;
}

export default createFacilitiesRouter;

/**
 * INTENTIONAL DESIGN: The /api/facilities endpoint NEVER returns 404.
 *
 * When an agent has no cached data:
 * - Returns 200 OK with { facilities: [], cachedAt: null }
 * - The frontend interprets empty + null timestamp as "no data yet"
 *
 * When the API itself fails (e.g., database error, proxy error):
 * - Returns appropriate 5xx status
 * - The frontend catches and displays: "Facilities service unavailable. Try refresh."
 *
 * When a requested agent doesn't exist:
 * - Returns 200 OK with { facilities: [], cachedAt: null, agent: "unknown-agent" }
 * - Frontend guidance: Have the agent call `list_facilities` in-game to populate cache
 */
