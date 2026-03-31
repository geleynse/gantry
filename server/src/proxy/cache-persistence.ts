import { getDb } from "../services/database.js";
import { createLogger } from "../lib/logger.js";
import { validateStatusCacheEntry } from "../shared/schemas.js";
import type { BattleState, AgentCallTracker } from "../shared/types.js";

const log = createLogger("cache");

function dbRun(sql: string, args: (string | number | null | undefined)[], errMsg = "cache persist failed (non-fatal)"): void {
  try {
    // bun:sqlite run() accepts a rest spread of bind values
    (getDb().prepare(sql).run as (...a: unknown[]) => void)(...args);
  } catch (err) {
    log.debug(errMsg, { error: String(err) });
  }
}

export async function persistGameState(
  agent: string,
  state: { data: Record<string, unknown>; fetchedAt: number },
): Promise<void> {
  dbRun(
    "INSERT OR REPLACE INTO proxy_game_state (agent, state_json, updated_at) VALUES (?, ?, datetime('now'))",
    [agent, JSON.stringify(state)],
  );
}

export function persistBattleState(
  agent: string,
  state: BattleState | null,
): void {
  dbRun(
    "INSERT OR REPLACE INTO proxy_battle_state (agent, battle_json, updated_at) VALUES (?, ?, datetime('now'))",
    [agent, state === null ? null : JSON.stringify(state)],
  );
}

export async function persistCallTracker(
  agent: string,
  tracker: AgentCallTracker,
): Promise<void> {
  dbRun(
    "INSERT OR REPLACE INTO proxy_call_trackers (agent, counts_json, last_call_sig, called_tools_json, updated_at) VALUES (?, ?, ?, ?, datetime('now'))",
    [agent, JSON.stringify(tracker.counts), tracker.lastCallSig, JSON.stringify(Array.from(tracker.calledTools))],
  );
}

export function persistMarketCache(
  data: { items?: unknown[]; categories?: string[]; empires?: unknown[] } | null,
  fetchedAt: number,
): void {
  if (data === null) return;
  dbRun(
    "INSERT OR REPLACE INTO proxy_market_cache (id, data_json, fetched_at, updated_at) VALUES (1, ?, ?, datetime('now'))",
    [JSON.stringify(data), fetchedAt],
    "market cache persist failed (non-fatal)",
  );
}

export function persistGalaxyGraph(
  systems: unknown[],
  edges: Array<{ from: string; to: string }>,
  fetchedAt: number,
): void {
  dbRun(
    "INSERT OR REPLACE INTO proxy_galaxy_graph (id, systems_json, edges_json, fetched_at, updated_at) VALUES (1, ?, ?, ?, datetime('now'))",
    [JSON.stringify(systems), JSON.stringify(edges), fetchedAt],
    "galaxy graph persist failed (non-fatal)",
  );
}

export interface RestoredCaches {
  marketData?: { items?: unknown[]; categories?: string[]; empires?: unknown[] } | null;
  marketFetchedAt?: number;
  galaxyGraphSystems?: unknown[];
  galaxyGraphEdges?: Array<{ from: string; to: string }>;
  galaxyGraphFetchedAt?: number;
}

export async function restorePublicCaches(): Promise<RestoredCaches> {
  const result: RestoredCaches = {};
  try {
    const db = getDb();

    // Restore market cache
    try {
      const row = db.prepare('SELECT data_json, fetched_at FROM proxy_market_cache WHERE id = 1').get() as { data_json: string; fetched_at: number } | undefined;
      if (row) {
        try {
          result.marketData = JSON.parse(row.data_json);
          result.marketFetchedAt = row.fetched_at;
          log.debug("restored market cache from SQL");
        } catch { /* skip malformed JSON */ }
      }
    } catch { /* table may not exist yet */ }

    // Restore galaxy graph
    try {
      const row = db.prepare('SELECT systems_json, edges_json, fetched_at FROM proxy_galaxy_graph WHERE id = 1').get() as { systems_json: string; edges_json: string; fetched_at: number } | undefined;
      if (row) {
        try {
          result.galaxyGraphSystems = JSON.parse(row.systems_json);
          result.galaxyGraphEdges = JSON.parse(row.edges_json);
          result.galaxyGraphFetchedAt = row.fetched_at;
          log.debug("restored galaxy graph from SQL");
        } catch { /* skip malformed JSON */ }
      }
    } catch { /* table may not exist yet */ }
  } catch {
    // getDb() threw — database not initialized yet, non-fatal
  }
  return result;
}

export async function restoreAllCaches(
  statusCache: Map<string, { data: Record<string, unknown>; fetchedAt: number }>,
  battleCache: Map<string, BattleState | null>,
  callTrackers: Map<string, AgentCallTracker>,
): Promise<void> {
  try {
    const db = getDb();

    // Restore game state
    try {
      const gameRows = db.prepare('SELECT agent, state_json FROM proxy_game_state').all() as Array<{ agent: string; state_json: string }>;
      for (const row of gameRows) {
        try {
          const parsed = JSON.parse(row.state_json);
          const validated = validateStatusCacheEntry(parsed);
          if (validated.success) {
            statusCache.set(row.agent, validated.value);
          } else {
            log.warn(`Skipping malformed statusCache entry for agent ${row.agent}: ${validated.error}`);
          }
        } catch { /* skip malformed JSON */ }
      }
      if (gameRows.length > 0) {
        log.info(`Restored ${gameRows.length} game state(s) from SQL`);
      }
    } catch { /* table may not exist yet */ }

    // Restore battle state
    try {
      const battleRows = db.prepare('SELECT agent, battle_json FROM proxy_battle_state').all() as Array<{ agent: string; battle_json: string | null }>;
      for (const row of battleRows) {
        try {
          battleCache.set(row.agent, row.battle_json ? JSON.parse(row.battle_json) : null);
        } catch { battleCache.set(row.agent, null); }
      }
      if (battleRows.length > 0) {
        log.info(`Restored ${battleRows.length} battle state(s) from SQL`);
      }
    } catch { /* table may not exist yet */ }

    // Restore call trackers
    try {
      const trackerRows = db.prepare('SELECT agent, counts_json, last_call_sig, called_tools_json FROM proxy_call_trackers').all() as Array<{
        agent: string;
        counts_json: string;
        last_call_sig: string | null;
        called_tools_json: string;
      }>;
      for (const row of trackerRows) {
        try {
          callTrackers.set(row.agent, {
            counts: JSON.parse(row.counts_json),
            lastCallSig: row.last_call_sig,
            calledTools: new Set(JSON.parse(row.called_tools_json)),
          });
        } catch { /* skip malformed row */ }
      }
      if (trackerRows.length > 0) {
        log.info(`Restored ${trackerRows.length} call tracker(s) from SQL`);
      }
    } catch { /* table may not exist yet */ }

  } catch {
    // getDb() threw — database not initialized yet, non-fatal
  }
}
