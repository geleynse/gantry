/**
 * POI Lore Service — per-POI discovery notes that help agents orient in known locations.
 *
 * Agents (and the proxy) accumulate lore about POIs as they explore.
 * The injection system delivers relevant lore when an agent arrives at a known POI.
 */

import { queryAll, queryOne, queryRun } from "./database.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("poi-lore");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PoiLore {
  system: string;
  poi_name: string;
  note: string;
  discovered_by: string;
  discovered_at: string;
  tags?: string[];
}

// ---------------------------------------------------------------------------
// Internal row shape from SQLite
// ---------------------------------------------------------------------------

interface PoiLoreRow {
  system: string;
  poi_name: string;
  note: string;
  discovered_by: string;
  discovered_at: string;
  tags: string | null;
}

function rowToLore(row: PoiLoreRow): PoiLore {
  return {
    system: row.system,
    poi_name: row.poi_name,
    note: row.note,
    discovered_by: row.discovered_by,
    discovered_at: row.discovered_at,
    tags: row.tags ? JSON.parse(row.tags) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Upsert a lore note for a POI.
 * If an entry already exists for (system, poi_name), it is replaced.
 */
export function recordLore(
  system: string,
  poiName: string,
  note: string,
  discoveredBy: string,
  tags?: string[],
): void {
  try {
    const tagsJson = tags && tags.length > 0 ? JSON.stringify(tags) : null;
    queryRun(
      `INSERT INTO poi_lore (system, poi_name, note, discovered_by, discovered_at, tags)
       VALUES (?, ?, ?, ?, datetime('now'), ?)
       ON CONFLICT(system, poi_name) DO UPDATE SET
         note = excluded.note,
         discovered_by = excluded.discovered_by,
         discovered_at = excluded.discovered_at,
         tags = excluded.tags`,
      system,
      poiName,
      note,
      discoveredBy,
      tagsJson,
    );
  } catch (err) {
    log.warn("Failed to record poi lore", { system, poiName, error: String(err) });
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Get all lore entries for a system, or a specific POI within a system.
 *
 * @param system   - System name to query
 * @param poiName  - Optional POI name to narrow to a single entry
 */
export function getLore(system: string): PoiLore[];
export function getLore(system: string, poiName: string): PoiLore | null;
export function getLore(system: string, poiName?: string): PoiLore[] | PoiLore | null {
  try {
    if (poiName !== undefined) {
      const row = queryOne<PoiLoreRow>(
        `SELECT * FROM poi_lore WHERE system = ? AND poi_name = ?`,
        system,
        poiName,
      );
      return row ? rowToLore(row) : null;
    }
    const rows = queryAll<PoiLoreRow>(
      `SELECT * FROM poi_lore WHERE system = ? ORDER BY poi_name`,
      system,
    );
    return rows.map(rowToLore);
  } catch (err) {
    log.warn("Failed to get poi lore", { system, poiName, error: String(err) });
    return poiName !== undefined ? null : [];
  }
}

/**
 * Full-text keyword search across all POI lore notes.
 * Searches note and poi_name fields case-insensitively.
 */
export function searchLore(keyword: string): PoiLore[] {
  if (!keyword || keyword.trim() === "") return [];
  try {
    const pattern = `%${keyword.trim().toLowerCase()}%`;
    const rows = queryAll<PoiLoreRow>(
      `SELECT * FROM poi_lore
       WHERE LOWER(note) LIKE ? OR LOWER(poi_name) LIKE ? OR LOWER(system) LIKE ?
       ORDER BY system, poi_name`,
      pattern,
      pattern,
      pattern,
    );
    return rows.map(rowToLore);
  } catch (err) {
    log.warn("Failed to search poi lore", { keyword, error: String(err) });
    return [];
  }
}

/**
 * Get lore for a specific POI. Alias for getLore(system, poiName) for cleaner call sites.
 */
export function getPoiLore(system: string, poiName: string): PoiLore | null {
  return getLore(system, poiName);
}

/**
 * Delete lore for a specific POI. Returns true if a row was deleted.
 */
export function deleteLore(system: string, poiName: string): boolean {
  try {
    const changes = queryRun(
      `DELETE FROM poi_lore WHERE system = ? AND poi_name = ?`,
      system,
      poiName,
    );
    return changes > 0;
  } catch (err) {
    log.warn("Failed to delete poi lore", { system, poiName, error: String(err) });
    return false;
  }
}

/**
 * Build a compact lore summary string for injecting into agent responses.
 * Returns null if no lore exists for the system/poi.
 */
export function buildLoreHint(system: string, poiName: string): string | null {
  const lore = getPoiLore(system, poiName);
  if (!lore) return null;
  const tagStr = lore.tags && lore.tags.length > 0 ? ` [${lore.tags.join(", ")}]` : "";
  return `KNOWN POI — ${lore.poi_name}${tagStr}: ${lore.note}`;
}

/**
 * Auto-record basic lore from an explore or navigation result.
 * Extracts POI type and services from the result object.
 */
export function autoRecordLoreFromResult(
  system: string,
  poiName: string,
  agentName: string,
  result: unknown,
): void {
  if (!system || !poiName || !agentName) return;
  if (!result || typeof result !== "object") return;

  try {
    const r = result as Record<string, unknown>;

    // Extract POI type and services from common response shapes
    const poiType = (r.type ?? r.poi_type ?? r.category) as string | undefined;
    const servicesRaw = r.services ?? r.available_services;
    const services: string[] = Array.isArray(servicesRaw)
      ? (servicesRaw as string[]).filter((s) => typeof s === "string")
      : [];

    if (!poiType && services.length === 0) return;

    const parts: string[] = [];
    if (poiType) parts.push(`Type: ${poiType}`);
    if (services.length > 0) parts.push(`Services: ${services.join(", ")}`);
    if (parts.length === 0) return;

    const note = parts.join(". ");
    const tags: string[] = [];
    if (poiType) tags.push(poiType);
    if (services.includes("market") || services.includes("trading")) tags.push("trade");
    if (services.includes("repair") || services.includes("hull_repair")) tags.push("repair");
    if (services.includes("fuel") || services.includes("refuel")) tags.push("fuel");

    recordLore(system, poiName, note, agentName, tags.length > 0 ? tags : undefined);
    log.debug("auto-recorded poi lore", { system, poiName, agent: agentName, note });
  } catch (err) {
    log.warn("autoRecordLoreFromResult failed", { system, poiName, error: String(err) });
  }
}
