/**
 * Threat assessment — system-level danger ratings (auto-cloak) and
 * ship-level classification with weapon/hull analysis (combat enrichment).
 *
 * System assessment: queries combat_events table for historical pirate activity.
 * Ship assessment: classifies individual ships by hull, shields, and weapons.
 * Both sets of functions are used by the proxy pipeline to inform agents.
 */

import { getDb } from "../services/database.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("threat-assessment");

export type ThreatLevel = "safe" | "low" | "medium" | "high" | "extreme";

// ---------------------------------------------------------------------------
// Ship-level threat assessment (Task #25)
// ---------------------------------------------------------------------------

export type ShipThreatLevel = "harmless" | "low" | "medium" | "high" | "extreme";
export type ShipClass = "unknown" | "shuttle" | "scout" | "frigate" | "cruiser" | "capital";

export interface ShipData {
  name?: string;
  class?: string;
  class_id?: string;
  hull?: number;
  max_hull?: number;
  shields?: number;
  max_shields?: number;
  weapons?: Array<{ type?: string; damage?: number; name?: string }>;
  faction?: string;
  hostile?: boolean;
  owner?: string;
}

export interface ShipThreatAssessment {
  level: ShipThreatLevel;
  shipClass: ShipClass;
  weaponCount: number;
  weaponTypes: string[];
  summary: string;
}

/**
 * Classify a ship by its hull capacity.
 *   shuttle:  hull < 50
 *   scout:    hull 50–149
 *   frigate:  hull 150–499
 *   cruiser:  hull 500–1499
 *   capital:  hull >= 1500
 *
 * Falls back to class_id string matching if hull data is absent.
 */
export function classifyShip(ship: ShipData): ShipClass {
  const hull = ship.max_hull ?? ship.hull;

  if (typeof hull === "number" && hull > 0) {
    if (hull < 50)   return "shuttle";
    if (hull < 150)  return "scout";
    if (hull < 500)  return "frigate";
    if (hull < 1500) return "cruiser";
    return "capital";
  }

  // Fall back to class name/id string matching
  const classStr = (ship.class ?? ship.class_id ?? "").toLowerCase();
  if (!classStr) return "unknown";
  if (classStr.includes("shuttle") || classStr.includes("transport")) return "shuttle";
  if (classStr.includes("scout") || classStr.includes("recon")) return "scout";
  if (classStr.includes("frigate") || classStr.includes("fighter")) return "frigate";
  if (classStr.includes("cruiser") || classStr.includes("destroyer")) return "cruiser";
  if (classStr.includes("capital") || classStr.includes("dreadnought") || classStr.includes("carrier")) return "capital";
  return "unknown";
}

/**
 * Assess the threat level of a single ship based on class, weapons, and shields.
 *
 * Scoring rubric:
 *   - base score from ship class (shuttle=0, scout=1, frigate=2, cruiser=3, capital=4)
 *   - weapon count adds 1–3 points
 *   - shields add 1 point
 *   - heavy weapon types (cannon, railgun, missile, etc.) add 1 point
 *   - unarmed small ships capped at score 1 ("harmless")
 */
export function assessShipThreat(ship: ShipData): ShipThreatAssessment {
  const shipClass = classifyShip(ship);
  const weapons = ship.weapons ?? [];
  const weaponCount = weapons.length;
  const weaponTypes = [...new Set(
    weapons.map(w => (w.type ?? w.name ?? "unknown").toLowerCase()).filter(Boolean)
  )];

  const classBaseScore: Record<ShipClass, number> = {
    unknown: 1,
    shuttle: 0,
    scout:   1,
    frigate: 2,
    cruiser: 3,
    capital: 4,
  };
  let score = classBaseScore[shipClass];

  if (weaponCount >= 1) score += 1;
  if (weaponCount >= 3) score += 1;
  if (weaponCount >= 5) score += 1;

  const hasShields =
    (typeof ship.shields === "number" && ship.shields > 0) ||
    (typeof ship.max_shields === "number" && ship.max_shields > 0);
  if (hasShields) score += 1;

  const heavyTypes = ["cannon", "railgun", "missile", "torpedo", "plasma", "laser", "heavy"];
  const hasHeavy = weaponTypes.some(t => heavyTypes.some(h => t.includes(h)));
  if (hasHeavy) score += 1;

  // Unarmed small ships are harmless
  if (weaponCount === 0 && (shipClass === "shuttle" || shipClass === "scout" || shipClass === "unknown")) {
    score = Math.min(score, 1);
  }

  const level: ShipThreatLevel =
    score <= 0 ? "harmless" :
    score <= 2 ? "low" :
    score <= 4 ? "medium" :
    score <= 6 ? "high" :
    "extreme";

  const weaponDesc = weaponCount === 0
    ? "unarmed"
    : weaponCount === 1
      ? "1 weapon"
      : `${weaponCount} weapons`;

  const summary = `${shipClass} (${weaponDesc}) — ${level.toUpperCase()} threat`;

  return { level, shipClass, weaponCount, weaponTypes, summary };
}

/**
 * Summarize the threat posed by a group of ships.
 * Returns a compact string like "2 frigates (HIGH), 1 scout (LOW)".
 * Returns null if ships array is empty.
 */
export function summarizeShipThreats(ships: ShipData[]): string | null {
  if (!ships || ships.length === 0) return null;

  const threatOrder: Record<ShipThreatLevel, number> = {
    extreme: 5, high: 4, medium: 3, low: 2, harmless: 1,
  };

  const groups = new Map<string, number>();
  for (const ship of ships) {
    const { shipClass, level } = assessShipThreat(ship);
    const key = `${shipClass}:${level}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }

  const parts = Array.from(groups.entries())
    .map(([key, count]) => {
      const [shipClass, level] = key.split(":") as [ShipClass, ShipThreatLevel];
      const label = count === 1 ? shipClass : `${shipClass}s`;
      return { count, label, level };
    })
    .sort((a, b) => (threatOrder[b.level] ?? 0) - (threatOrder[a.level] ?? 0))
    .map(({ count, label, level }) => `${count} ${label} (${level.toUpperCase()})`);

  return parts.join(", ");
}

/**
 * Extract ships from a get_location or get_status result.
 * Checks result.ships, result.nearby_ships, result.entities, result.contacts,
 * and the same fields nested under result.location.
 */
export function extractShipsFromResult(result: unknown): ShipData[] | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;

  for (const field of ["ships", "nearby_ships", "entities", "contacts"]) {
    const val = r[field];
    if (Array.isArray(val) && val.length > 0) return val as ShipData[];
  }

  const location = r.location as Record<string, unknown> | undefined;
  if (location) {
    for (const field of ["ships", "nearby_ships", "entities"]) {
      const val = location[field];
      if (Array.isArray(val) && val.length > 0) return val as ShipData[];
    }
  }

  return null;
}

/**
 * Enrich a get_location or get_status result with a threat summary if ships are present.
 * Mutates the result object in-place by adding `_threat_summary`.
 * Returns true if enrichment was applied.
 */
export function enrichWithThreatAssessment(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const r = result as Record<string, unknown>;

  const ships = extractShipsFromResult(result);
  if (!ships || ships.length === 0) return false;

  const summary = summarizeShipThreats(ships);
  if (!summary) return false;

  r._threat_summary = summary;
  return true;
}

// ---------------------------------------------------------------------------
// System-level threat assessment (auto-cloak)
// ---------------------------------------------------------------------------

export interface SystemThreatAssessment {
  level: ThreatLevel;
  score: number; // 0-100
  reasons: string[];
}

interface EncounterCacheEntry {
  count: number;
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Module-level cache: system name → encounter count + timestamp
const encounterCache = new Map<string, EncounterCacheEntry>();

/** Clear the encounter cache. Used in tests to force fresh DB queries. */
export function clearThreatCache(): void {
  encounterCache.clear();
}

/**
 * Assess the threat level of a system based on historical combat data.
 *
 * @param system - The system name to assess
 * @param hullPercent - Agent's current hull as a percentage (0-100). Increases score if low.
 */
export function assessSystemThreat(
  system: string,
  hullPercent?: number,
): SystemThreatAssessment {
  const now = Date.now();
  const reasons: string[] = [];

  // Fetch encounter count from cache or DB
  let count: number;
  const cached = encounterCache.get(system);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    count = cached.count;
  } else {
    try {
      const db = getDb();
      const row = db
        .prepare(
          `SELECT COUNT(*) as count
           FROM combat_events
           WHERE system = ?
             AND event_type IN ('pirate_combat', 'pirate_warning')`,
        )
        .get(system) as { count: number } | undefined;
      count = row?.count ?? 0;
      encounterCache.set(system, { count, fetchedAt: now });
    } catch (err) {
      log.warn("failed to query combat_events for threat assessment", {
        system,
        error: String(err),
      });
      count = 0;
    }
  }

  // Base score from encounter history
  let score = 0;
  if (count === 0) {
    // No recorded encounters — safe
  } else if (count <= 3) {
    score = 20;
    reasons.push(`${count} recorded pirate encounter(s)`);
  } else if (count <= 10) {
    score = 50;
    reasons.push(`${count} recorded pirate encounters`);
  } else {
    score = 80;
    reasons.push(`${count} recorded pirate encounters (high activity)`);
  }

  // Hull bonuses — low hull makes any system more dangerous
  const hull = hullPercent ?? 100;
  if (hull < 30) {
    score += 20;
    reasons.push(`hull critically low (${Math.round(hull)}%)`);
  } else if (hull < 50) {
    score += 10;
    reasons.push(`hull damaged (${Math.round(hull)}%)`);
  }

  score = Math.min(score, 100);

  let level: ThreatLevel;
  if (score <= 20) level = "safe";
  else if (score <= 40) level = "low";
  else if (score <= 60) level = "medium";
  else if (score <= 80) level = "high";
  else level = "extreme";

  return { level, score, reasons };
}
