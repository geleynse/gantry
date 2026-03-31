/**
 * Fleet capacity API route.
 *
 * GET /api/fleet/capacity
 * Returns per-agent status (credits, cargo, fuel, hull, zone, role) plus
 * fleet-wide totals and zone coverage summary.
 *
 * Mount: app.use("/api/fleet", createFleetCapacityRouter(statusCache, config))
 */

import { Router } from "express";
import type { GantryConfig } from "../../config.js";
import { createLogger } from '../../lib/logger.js';

const log = createLogger('fleet-capacity');

type StatusCacheEntry = { data: Record<string, unknown>; fetchedAt: number };
type StatusCache = Map<string, StatusCacheEntry>;

/** Per-agent capacity snapshot */
export interface AgentCapacity {
  name: string;
  role: string | undefined;
  zone: string | undefined;
  system: string | undefined;
  credits: number | null;
  cargoUsed: number | null;
  cargoMax: number | null;
  fuel: number | null;
  fuelMax: number | null;
  hullPercent: number | null;
  online: boolean;
  /** True when data is present but older than STALE_THRESHOLD_MS */
  isStale: boolean;
  /** Unix ms timestamp of last known activity (status cache fetchedAt), or null if no data */
  lastActiveAt: number | null;
}

/** Fleet-wide totals */
export interface FleetTotals {
  totalCredits: number;
  totalCargoCapacity: number;
  totalCargoUsed: number;
  agentCount: number;
  onlineCount: number;
  byRole: Record<string, number>;
}

/** Zone coverage summary */
export interface ZoneCoverage {
  covered: Record<string, string[]>; // zone → agent names
  uncovered: string[]; // zones with no agents assigned
}

/** Full capacity response shape */
export interface FleetCapacityResponse {
  agents: AgentCapacity[];
  totals: FleetTotals;
  zoneCoverage: ZoneCoverage;
}

function extractNumber(data: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const v = data[key];
    if (typeof v === "number" && !isNaN(v)) return v;
  }
  return null;
}

function getHullPercent(data: Record<string, unknown>): number | null {
  // Status cache may store ship data nested or flat
  const ship = (data.ship ?? data) as Record<string, unknown>;
  const hull = extractNumber(ship, "hull", "hull_current");
  const maxHull = extractNumber(ship, "max_hull", "hull_max");
  if (hull !== null && maxHull !== null && maxHull > 0) {
    return Math.round((hull / maxHull) * 100);
  }
  return null;
}

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export function createFleetCapacityRouter(statusCache: StatusCache, config: GantryConfig): Router {
  const router = Router();

  /**
   * GET /api/fleet/capacity
   * Fleet-wide capacity snapshot: per-agent stats + totals + zone coverage.
   */
  router.get("/capacity", (_req, res) => {
    const agentConfigs = config.agents.map((a) => ({
      name: a.name,
      role: a.role,
      operatingZone: a.operatingZone,
    }));

    const now = Date.now();

    const agents: AgentCapacity[] = agentConfigs.map((cfg) => {
      const entry = statusCache.get(cfg.name);
      const online = !!entry && now - entry.fetchedAt < STALE_THRESHOLD_MS;
      const data = entry?.data ?? {};

      // statusCache stores nested game server format: { player: {...}, ship: {...} }
      const player = (data.player ?? data) as Record<string, unknown>;
      const ship = (data.ship ?? (player.ship as Record<string, unknown>) ?? {}) as Record<string, unknown>;

      const hasData = !!entry;
      return {
        name: cfg.name,
        role: cfg.role,
        zone: cfg.operatingZone,
        system: typeof player.current_system === "string" ? player.current_system
          : typeof data.system === "string" ? data.system : undefined,
        credits: extractNumber(player, "credits"),
        cargoUsed: extractNumber(ship, "cargo_used"),
        cargoMax: extractNumber(ship, "cargo_max", "cargo_capacity"),
        fuel: extractNumber(player, "fuel") ?? extractNumber(ship, "fuel"),
        fuelMax: extractNumber(player, "fuel_max") ?? extractNumber(ship, "fuel_max"),
        // Always show last-known hull data; only null if we've never seen it
        hullPercent: hasData ? getHullPercent(data) : null,
        online,
        // isStale: we have data but it's older than the freshness threshold
        isStale: hasData && !online,
        lastActiveAt: entry ? entry.fetchedAt : null,
      };
    });

    // Fleet totals — single pass
    const byRole: Record<string, number> = {};
    let totalCredits = 0;
    let totalCargoCapacity = 0;
    let totalCargoUsed = 0;
    let onlineCount = 0;

    for (const agent of agents) {
      const role = agent.role ?? "unknown";
      byRole[role] = (byRole[role] ?? 0) + 1;
      if (agent.online) {
        onlineCount++;
      }
      // Always include last-known data in fleet totals (Bugs 2 & 6: offline agents
      // still have valid last-known credits/cargo from the status cache).
      totalCredits += agent.credits ?? 0;
      totalCargoCapacity += agent.cargoMax ?? 0;
      totalCargoUsed += agent.cargoUsed ?? 0;
    }

    const totals: FleetTotals = {
      totalCredits,
      totalCargoCapacity,
      totalCargoUsed,
      agentCount: agents.length,
      onlineCount,
      byRole,
    };

    // Zone coverage
    const allZones = [...new Set(agentConfigs.map((a) => a.operatingZone).filter((z): z is string => !!z))];
    const covered: Record<string, string[]> = {};
    for (const agent of agents) {
      if (agent.zone) {
        covered[agent.zone] = covered[agent.zone] ?? [];
        covered[agent.zone].push(agent.name);
      }
    }
    const uncovered = allZones.filter((z) => !covered[z] || covered[z].length === 0);

    const response: FleetCapacityResponse = {
      agents,
      totals,
      zoneCoverage: { covered, uncovered },
    };

    res.json(response);
  });

  return router;
}
