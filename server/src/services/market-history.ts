import { queryOne, queryAll, queryRun } from './database.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('market-history');

export interface MarketSnapshot {
  item_id: string;
  poi_id: string;
  price: number;
  type: 'buy' | 'sell';
  timestamp?: string;
}

/**
 * MarketHistoryService — Persistent price tracking for items across the galaxy.
 */
export function recordPrice(snapshot: MarketSnapshot): void {
  try {
    queryRun(`
      INSERT INTO market_history (item_id, poi_id, price, type, timestamp)
      VALUES (?, ?, ?, ?, datetime('now'))
    `,
      snapshot.item_id,
      snapshot.poi_id,
      snapshot.price,
      snapshot.type
    );
  } catch (e) {
    log.error(`Failed to record price for ${snapshot.item_id}`, { error: e });
  }
}

export interface StationObservation {
  item_id: string;
  /** Station NAME (as written in the analyze_market insight) or a poi_id. */
  station: string;
  price: number;
  /** 'sell' = a station buys it from you; 'buy' = a station sells it to you. */
  type: 'buy' | 'sell';
}

/**
 * Record a STATION-level market observation (from analyze_market opportunity
 * insights). The station NAME is resolved to a galaxy poi_id when known, so the
 * row joins to nav data; otherwise the name is stored as-is (still actionable —
 * the agent can travel_to a named station). Distinct from the faction-global
 * `global:<empire>` rows recordPrice writes.
 */
export function recordStationObservation(obs: StationObservation): void {
  try {
    const poi_id = resolveStationPoiId(obs.station);
    queryRun(
      `INSERT INTO market_history (item_id, poi_id, price, type, timestamp)
       VALUES (?, ?, ?, ?, datetime('now'))`,
      obs.item_id,
      poi_id,
      obs.price,
      obs.type,
    );
  } catch (e) {
    log.error(`Failed to record station observation for ${obs.item_id}`, { error: e });
  }
}

/** Best-effort station NAME → poi_id resolution via galaxy_pois (case-insensitive). */
function resolveStationPoiId(station: string): string {
  try {
    const row = queryOne<{ id: string }>(
      'SELECT id FROM galaxy_pois WHERE name = ? COLLATE NOCASE LIMIT 1',
      station,
    );
    return row?.id ?? station;
  } catch {
    return station;
  }
}

export interface StationPrice {
  poi_id: string;
  type: 'buy' | 'sell';
  price: number;
  last_seen: string;
}

/**
 * Deterministic, antisymmetric ordering for station prices. Groups SELL
 * opportunities (stations buying from you) before BUY ones, sells by highest
 * bid first, buys by lowest ask first, with a poi_id tiebreaker. The previous
 * inline comparator inspected only `a.type`, so it was non-antisymmetric for a
 * mixed buy+sell set (the no-`type` query path) → engine-dependent ordering.
 */
export function compareStationPrices(a: StationPrice, b: StationPrice): number {
  if (a.type !== b.type) return a.type === 'sell' ? -1 : 1;
  if (a.price !== b.price) {
    return a.type === 'sell' ? b.price - a.price : a.price - b.price;
  }
  return a.poi_id < b.poi_id ? -1 : a.poi_id > b.poi_id ? 1 : 0;
}

/**
 * "Where can I get / sell item X?" — returns the most-recent per-station price
 * for an item from real-station observations (excludes faction-global rows),
 * within a freshness window, best-price first (highest bid for sell, lowest ask
 * for buy).
 */
export function getStationsForItem(
  item_id: string,
  opts: { type?: 'buy' | 'sell'; maxAgeHours?: number } = {},
): StationPrice[] {
  const maxAgeHours = opts.maxAgeHours ?? 72;
  try {
    const params: (string | number)[] = [item_id, `-${maxAgeHours} hours`];
    let typeClause = '';
    if (opts.type) {
      typeClause = 'AND mh.type = ?';
      params.push(opts.type);
    }
    // Latest row per (poi_id, type) — keyed on MAX(id), not timestamp, because
    // datetime('now') is only second-granular so same-second inserts tie. Exclude
    // the faction-global aggregates.
    const rows = queryAll<StationPrice>(
      `SELECT mh.poi_id AS poi_id, mh.type AS type, mh.price AS price, mh.timestamp AS last_seen
       FROM market_history mh
       WHERE mh.item_id = ?
         AND mh.timestamp >= datetime('now', ?)
         AND mh.poi_id NOT LIKE 'global:%'
         ${typeClause}
         AND mh.id = (
           SELECT MAX(mh2.id) FROM market_history mh2
           WHERE mh2.item_id = mh.item_id AND mh2.poi_id = mh.poi_id AND mh2.type = mh.type
         )`,
      ...params,
    );
    return rows.sort(compareStationPrices);
  } catch (e) {
    log.error(`Failed to query stations for ${item_id}`, { error: e });
    return [];
  }
}

export interface PriceTrend {
  item_id: string;
  min_price: number;
  max_price: number;
  avg_price: number;
  sample_count: number;
}

export function getPriceTrends(item_id: string, days: number = 7): PriceTrend | null {
  try {
    const row = queryOne<PriceTrend>(`
      SELECT 
        item_id,
        MIN(price) as min_price,
        MAX(price) as max_price,
        AVG(price) as avg_price,
        COUNT(*) as sample_count
      FROM market_history
      WHERE item_id = ? AND timestamp >= datetime('now', ?)
      GROUP BY item_id
    `, item_id, `-${days} days`);
    
    if (!row || row.sample_count === 0) return null;
    return row;
  } catch (e) {
    return null;
  }
}
