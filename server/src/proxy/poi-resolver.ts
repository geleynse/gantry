/** POI name → ID resolution for travel_to commands. */

import { normalizeSystemName } from "./pathfinder.js";
import { registerPoi } from "../services/galaxy-poi-registry.js";
import { queryAll } from "../services/database.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("poi-resolver");

export interface PoiEntry {
  id: string;
  name: string;
  type: string;
}

/** Cache of system POI data, populated from get_system responses. */
export const systemPoiCache = new Map<string, PoiEntry[]>();

/** Restore in-memory POI cache from the galaxy_pois table on startup. */
export function restoreSystemPoiCache(): void {
  try {
    const rows = queryAll<{ system: string; id: string; name: string; type: string | null }>(
      "SELECT system, id, name, type FROM galaxy_pois ORDER BY system"
    );
    const bySystem = new Map<string, PoiEntry[]>();
    for (const row of rows) {
      const entries = bySystem.get(row.system) ?? [];
      entries.push({ id: row.id, name: row.name, type: row.type ?? "" });
      bySystem.set(row.system, entries);
    }
    for (const [sys, entries] of bySystem) {
      systemPoiCache.set(sys, entries);
    }
    if (bySystem.size > 0) {
      log.info(`Restored POI cache: ${bySystem.size} systems, ${rows.length} POIs`);
    }
  } catch (err) {
    log.debug("POI cache restore failed (non-fatal)", { error: String(err) });
  }
}

/** Populate the POI cache from a raw get_system response. */
export function cacheSystemPois(result: unknown): void {
  if (!result || typeof result !== "object") return;
  const raw = result as Record<string, unknown>;
  const sys = (raw.system ?? raw) as Record<string, unknown>;
  const sysId = sys.id as string | undefined;
  if (sysId && Array.isArray(sys.pois)) {
    const entries = (sys.pois as Record<string, unknown>[]).map(p => ({
      id: p.id as string || "",
      name: p.name as string || "",
      type: p.type as string || "",
    }));
    systemPoiCache.set(sysId, entries);
    for (const entry of entries) {
      if (entry.id) {
        registerPoi({ id: entry.id, name: entry.name, system: sysId, type: entry.type || undefined });
      }
    }
  }
}

/**
 * Resolve a POI name to its ID using cached system data.
 * Falls through to the original destination if no match is found.
 */
export function resolvePoiId(
  agentName: string,
  destination: string,
  statusCache: Map<string, { data: Record<string, unknown>; fetchedAt: number }>,
): string {
  // If it already looks like a raw POI ID, pass through
  if (destination.startsWith("poi_")) return destination;

  // Get agent's current system from statusCache
  const cached = statusCache.get(agentName);
  if (!cached?.data) return destination;

  const player = (cached.data.player ?? cached.data) as Record<string, unknown>;
  const currentSystem = player?.current_system as string | undefined;
  if (!currentSystem) return destination;

  const pois = systemPoiCache.get(currentSystem);
  if (!pois) return destination;

  // Exact ID match
  if (pois.some(p => p.id === destination)) return destination;

  const destNorm = normalizeSystemName(destination);

  /** Pick a station from candidates if one exists, otherwise first entry. */
  const preferStation = (candidates: PoiEntry[]): string =>
    (candidates.find(p => p.type === "station" || p.name.toLowerCase().includes("station")) ?? candidates[0]).id;

  // 0. Normalized ID match (e.g., "sol_station" matches ID "Sol_Station")
  const byNormId = pois.find(p => normalizeSystemName(p.id) === destNorm);
  if (byNormId) return byNormId.id;

  // 1. Exact name match (case-insensitive, underscore-insensitive) — prefer stations on ties
  const exactMatches = pois.filter(p => normalizeSystemName(p.name) === destNorm);
  if (exactMatches.length > 0) return preferStation(exactMatches);

  // 2. Partial name/ID match — prefer stations over other types (like suns)
  const partialMatches = pois.filter(p =>
    normalizeSystemName(p.name).includes(destNorm) || normalizeSystemName(p.id).includes(destNorm),
  );
  if (partialMatches.length > 0) return preferStation(partialMatches);

  return destination;
}
