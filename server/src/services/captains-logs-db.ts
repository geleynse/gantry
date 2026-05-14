/**
 * Captain's Logs Database Service
 *
 * Manages persistence of captain's log entries from game server.
 * Parses entries to extract location, credits, and other state information.
 * Provides query/search interface for Gantry UI.
 */

import { getDb, queryAll } from './database.js';
import { createLogger } from '../lib/logger.js';
import { isDockable } from './galaxy-poi-registry.js';
import { markStrandedHold } from './overseer-stop-cooldown.js';
import { createSignal } from './signals-db.js';

const log = createLogger('captains-logs-db');

/**
 * Stranded-loop detection thresholds.
 *
 * Fuel threshold: ≤5 effectively means the agent has no useful jump capacity.
 * Stations refuel — an agent docked at a station with 0 fuel is NOT stranded
 * (it can refuel), so the POI-not-dockable check guards against false positives
 * for low-fuel-at-station cases.
 */
const STRANDED_FUEL_MAX = 5;
const STRANDED_HISTORY_DEPTH = 3;

export interface CaptainsLogEntry {
  id: number;
  agent: string;
  game_log_id: string;
  sequence_number: number | null;
  entry_text: string;
  loc_system: string | null;
  loc_poi: string | null;
  loc_dock_status: string | null;
  cr_credits: number | null;
  cr_fuel_current: number | null;
  cr_fuel_max: number | null;
  cr_cargo_used: number | null;
  cr_cargo_max: number | null;
  created_at: string;
  synced_at: string | null;
}

/**
 * Parse a captain's log entry (4-line format: LOC/CR/DID/NEXT)
 * Extracts structured data from free-form text.
 */
export function parseLogEntry(entryText: string): {
  loc_system: string | null;
  loc_poi: string | null;
  loc_dock_status: string | null;
  cr_credits: number | null;
  cr_fuel_current: number | null;
  cr_fuel_max: number | null;
  cr_cargo_used: number | null;
  cr_cargo_max: number | null;
} {
  const result = {
    loc_system: null as string | null,
    loc_poi: null as string | null,
    loc_dock_status: null as string | null,
    cr_credits: null as number | null,
    cr_fuel_current: null as number | null,
    cr_fuel_max: null as number | null,
    cr_cargo_used: null as number | null,
    cr_cargo_max: null as number | null,
  };

  try {
    const lines = entryText.split('\n');

    // Parse LOC: line — format: "LOC: system_name [POI_name] [docked|undocked]"
    const locLine = lines.find(l => l.startsWith('LOC:'));
    if (locLine) {
      const parts = locLine.slice(5).trim().split(/\s+/);
      if (parts.length > 0) {
        result.loc_system = parts[0];
      }
      if (parts.length > 1 && parts[parts.length - 1].match(/^(docked|undocked)$/i)) {
        result.loc_dock_status = parts[parts.length - 1].toLowerCase();
        result.loc_poi = parts.slice(1, -1).join(' ') || null;
      } else if (parts.length > 1) {
        result.loc_poi = parts.slice(1).join(' ') || null;
      }
    }

    // Parse CR: line — format: "CR: credits fuel/max_fuel cargo/max_cargo"
    const crLine = lines.find(l => l.startsWith('CR:'));
    if (crLine) {
      const parts = crLine.slice(4).trim().split(/\s+/);
      if (parts.length > 0) {
        result.cr_credits = parseInt(parts[0], 10) || null;
      }
      if (parts.length > 1 && parts[1].includes('/')) {
        const [fuel, maxFuel] = parts[1].split('/').map(x => parseInt(x, 10) || null);
        result.cr_fuel_current = fuel;
        result.cr_fuel_max = maxFuel;
      }
      if (parts.length > 2 && parts[2].includes('/')) {
        const [cargo, maxCargo] = parts[2].split('/').map(x => parseInt(x, 10) || null);
        result.cr_cargo_used = cargo;
        result.cr_cargo_max = maxCargo;
      }
    }

    return result;
  } catch (error) {
    log.error('Failed to parse log entry', { error: String(error) });
    return result;
  }
}

/**
 * Persist a captain's log entry to the database.
 * Called after successful captains_log_add from game server.
 */
export function persistCaptainsLogEntry(
  agent: string,
  entryText: string,
  gameLogId: string,
  sequenceNumber?: number
): number {
  const db = getDb();
  const parsed = parseLogEntry(entryText);

  const result = db.prepare(`
    INSERT INTO captains_logs (
      agent, game_log_id, sequence_number, entry_text,
      loc_system, loc_poi, loc_dock_status,
      cr_credits, cr_fuel_current, cr_fuel_max, cr_cargo_used, cr_cargo_max
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent, game_log_id) DO UPDATE SET
      synced_at = datetime('now')
  `).run(
    agent,
    gameLogId,
    sequenceNumber ?? null,
    entryText,
    parsed.loc_system,
    parsed.loc_poi,
    parsed.loc_dock_status,
    parsed.cr_credits,
    parsed.cr_fuel_current,
    parsed.cr_fuel_max,
    parsed.cr_cargo_used,
    parsed.cr_cargo_max
  );

  log.info('Persisted captain log entry', { agent, game_log_id: gameLogId });

  try {
    detectStrandedLoop(agent);
  } catch (err) {
    // Detection failure must never block log persistence.
    log.warn('Stranded-loop detection failed', {
      agent,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return result.lastInsertRowid as number;
}

/**
 * Stranded-loop detector. Called after each captain's log persist.
 *
 * Trigger: the last STRANDED_HISTORY_DEPTH (3) captain's logs for this agent
 * all show the agent at the same (system, poi) with fuel ≤ STRANDED_FUEL_MAX (5),
 * and the poi is NOT a known dockable station. That pattern means the agent
 * has logged in, run out of options, written a stranded-style log, and logged
 * back in N times without progress — burning shared quota on a state only the
 * operator can fix.
 *
 * Effect: calls markStrandedHold (sets hold_offline=1 immediately, suppressing
 * auto-restart indefinitely) and writes a "shutdown" signal so the runner exits
 * on the next turn boundary. Operator manual start clears the hold.
 *
 * No-ops if:
 *   - fewer than STRANDED_HISTORY_DEPTH logs available
 *   - any log lacks fuel or POI fields (parsed null)
 *   - logs differ on system/poi (agent IS moving)
 *   - fuel went above threshold at any point
 *   - poi is known-dockable (agent can refuel at a station)
 *   - agent is already on hold_offline (avoid duplicate writes per log entry)
 *
 * Exported for testing.
 */
export function detectStrandedLoop(agent: string): boolean {
  const recent = queryAll<{
    loc_system: string | null;
    loc_poi: string | null;
    cr_fuel_current: number | null;
  }>(
    `SELECT loc_system, loc_poi, cr_fuel_current
     FROM captains_logs
     WHERE agent = ?
     ORDER BY id DESC
     LIMIT ?`,
    agent, STRANDED_HISTORY_DEPTH,
  );

  if (recent.length < STRANDED_HISTORY_DEPTH) return false;

  const first = recent[0];
  if (first.loc_system === null || first.loc_poi === null) return false;
  if (first.cr_fuel_current === null) return false;

  const allSamePoi = recent.every(r =>
    r.loc_system === first.loc_system && r.loc_poi === first.loc_poi
  );
  if (!allSamePoi) return false;

  const allLowFuel = recent.every(r =>
    r.cr_fuel_current !== null && r.cr_fuel_current <= STRANDED_FUEL_MAX
  );
  if (!allLowFuel) return false;

  // Don't flag a low-fuel-at-station situation — the agent can refuel.
  // isDockable returns null when the POI isn't registered yet; we treat
  // unknown POIs as not-dockable (the typical strand case is a belt/cloud
  // /star that we've never registered as a station).
  if (isDockable(first.loc_poi) === true) return false;

  const reason =
    `Stranded ${STRANDED_HISTORY_DEPTH} consecutive captain's logs at ` +
    `${first.loc_system}/${first.loc_poi} with fuel=${first.cr_fuel_current} ` +
    `(non-station POI). Auto-stop to preserve shared quota — operator manual ` +
    `start required for recovery.`;

  markStrandedHold(agent, reason);
  createSignal(agent, 'shutdown', reason);

  log.warn('Stranded-loop detected — hold_offline raised and shutdown signal written', {
    agent,
    system: first.loc_system,
    poi: first.loc_poi,
    fuel: first.cr_fuel_current,
  });

  return true;
}

/**
 * Sync captain's log entries from game server response.
 * Called after captains_log_list from game server.
 * Updates DB with latest entries and timestamps.
 */
export function syncCaptainsLogsFromServer(
  agent: string,
  serverEntries: Array<{
    id: string;
    entry: string;
    created_at: string;
  }>
): void {
  const db = getDb();
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO captains_logs (
      agent, game_log_id, sequence_number, entry_text,
      loc_system, loc_poi, loc_dock_status,
      cr_credits, cr_fuel_current, cr_fuel_max, cr_cargo_used, cr_cargo_max,
      synced_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent, game_log_id) DO UPDATE SET
      synced_at = excluded.synced_at
  `);

  const insertAll = db.transaction(() => {
    for (let i = 0; i < serverEntries.length; i++) {
      const { id, entry } = serverEntries[i];
      const parsed = parseLogEntry(entry);
      stmt.run(
        agent, id, i, entry,
        parsed.loc_system, parsed.loc_poi, parsed.loc_dock_status,
        parsed.cr_credits, parsed.cr_fuel_current, parsed.cr_fuel_max,
        parsed.cr_cargo_used, parsed.cr_cargo_max, now
      );
    }
  });
  insertAll();

  if (serverEntries.length > 0) {
    log.info('Synced captain logs from server', { agent, count: String(serverEntries.length) });
  }
}

/**
 * Get captain's logs for an agent with optional filtering.
 */
export function getCaptainsLogs(
  agent: string,
  limit: number = 50,
  daysBack?: number
): CaptainsLogEntry[] {
  const db = getDb();

  const timeClause = daysBack ? `AND created_at >= datetime('now', ? || ' days')` : '';
  const params: (string | number)[] = daysBack
    ? [agent, `-${Math.floor(daysBack)}`, limit]
    : [agent, limit];

  return db.prepare(`
    SELECT * FROM captains_logs
    WHERE agent = ?
    ${timeClause}
    ORDER BY created_at DESC LIMIT ?
  `).all(...params) as CaptainsLogEntry[];
}

/**
 * Search captain's logs by entry text content.
 */
export function searchCaptainsLogs(
  agent: string,
  query: string,
  limit: number = 20
): CaptainsLogEntry[] {
  const db = getDb();
  const searchPattern = `%${query}%`;

  return db.prepare(`
    SELECT * FROM captains_logs
    WHERE agent = ? AND (
      entry_text LIKE ? OR
      loc_system LIKE ? OR
      loc_poi LIKE ?
    )
    ORDER BY created_at DESC
    LIMIT ?
  `).all(agent, searchPattern, searchPattern, searchPattern, limit) as CaptainsLogEntry[];
}

/**
 * Get captain's logs for multiple agents (fleet-wide view).
 */
export function getFleetCaptainsLogs(
  agents?: string[],
  limit: number = 100
): Array<CaptainsLogEntry & { agent: string }> {
  const db = getDb();

  let query = `SELECT * FROM captains_logs`;
  const params: Array<string | number> = [];

  if (agents && agents.length > 0) {
    const placeholders = agents.map(() => '?').join(',');
    query += ` WHERE agent IN (${placeholders})`;
    params.push(...agents);
  }

  query += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);

  return db.prepare(query).all(...params) as Array<CaptainsLogEntry & { agent: string }>;
}

/**
 * Get logs filtered by location system.
 */
export function getCaptainsLogsByLocation(
  agent: string,
  system: string,
  limit: number = 50
): CaptainsLogEntry[] {
  const db = getDb();

  return db.prepare(`
    SELECT * FROM captains_logs
    WHERE agent = ? AND loc_system = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(agent, system, limit) as CaptainsLogEntry[];
}

/**
 * Get captain's log statistics for an agent.
 */
export function getCaptainsLogStats(agent: string): {
  total: number;
  firstEntry: string | null;
  lastEntry: string | null;
  avgCredits: number | null;
  maxCredits: number | null;
  uniqueSystems: number;
} {
  const db = getDb();

  const result = db.prepare(`
    SELECT
      COUNT(*) as total,
      MIN(created_at) as firstEntry,
      MAX(created_at) as lastEntry,
      ROUND(AVG(cr_credits)) as avgCredits,
      MAX(cr_credits) as maxCredits,
      COUNT(DISTINCT loc_system) as uniqueSystems
    FROM captains_logs
    WHERE agent = ?
  `).get(agent) as {
    total: number;
    firstEntry: string | null;
    lastEntry: string | null;
    avgCredits: number | null;
    maxCredits: number | null;
    uniqueSystems: number;
  };

  return result;
}
