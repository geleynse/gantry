/**
 * external-snapshot-fetcher.ts
 *
 * Fetches daily market snapshots from mkryo59-afk/spacemolt-news and persists
 * them to the local SQLite database. Agents can query yesterday's prices as a
 * free cold-start planning tool (no game turns consumed).
 *
 * Source: https://github.com/mkryo59-afk/spacemolt-news
 * URL pattern: https://raw.githubusercontent.com/mkryo59-afk/spacemolt-news/main/output/YYYY-MM-DD/data_market.json
 *
 * Schedule: runs once daily at 06:05 UTC (after mkryo59 snapshot collection ~04:30 UTC).
 */

import { getDb, queryOne, queryAll } from './database.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('external-snapshot-fetcher');

const BASE_URL =
  'https://raw.githubusercontent.com/mkryo59-afk/spacemolt-news/main/output';

// ---------------------------------------------------------------------------
// Types — matches mkryo59-afk snapshot shape
// ---------------------------------------------------------------------------

/**
 * One market entry from the snapshot's supply_surplus, demand_shortage, or
 * high_value lists.
 */
export interface SnapshotMarketEntry {
  item: string;
  category?: string;
  sell_price?: number;
  sell_qty?: number;
  buy_price?: number;
  buy_qty?: number;
}

/**
 * Raw snapshot JSON as published by mkryo59-afk.
 */
export interface RawMarketSnapshot {
  collected_at?: string;
  station?: string;
  total_items_with_orders?: number;
  supply_surplus?: SnapshotMarketEntry[];
  demand_shortage?: SnapshotMarketEntry[];
  high_value?: SnapshotMarketEntry[];
  arbitrage_candidates?: SnapshotMarketEntry[];
  [key: string]: unknown;
}

/**
 * Normalised row for storage and tool responses.
 */
export interface ExternalMarketRow {
  id?: number;
  as_of_date: string;           // YYYY-MM-DD
  item_name: string;            // human-readable name from snapshot
  item_id: string;              // lowercase_snake_case derived from name
  category: string;
  sell_price: number;           // station sells to players (ask)
  sell_qty: number;
  buy_price: number;            // station buys from players (bid)
  buy_qty: number;
  snapshot_list: string;        // 'supply_surplus' | 'demand_shortage' | 'high_value' | 'arbitrage'
  station: string;
  fetched_at: string;           // ISO timestamp of when gantry fetched it
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert "Iron Ore" → "iron_ore" */
export function toItemId(name: string): string {
  return name
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Format a Date as YYYY-MM-DD in UTC.
 */
export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Build the raw GitHub URL for a given date.
 */
export function snapshotUrl(date: string): string {
  return `${BASE_URL}/${date}/data_market.json`;
}

// ---------------------------------------------------------------------------
// Parser — accepts the raw JSON and converts to normalised rows
// ---------------------------------------------------------------------------

/**
 * Parse a raw mkryo59-afk market snapshot into flat DB rows.
 * Returns an empty array (not throw) on malformed input.
 */
export function parseSnapshot(
  raw: unknown,
  asOfDate: string,
  fetchedAt: string,
): ExternalMarketRow[] {
  if (!raw || typeof raw !== 'object') return [];

  const data = raw as RawMarketSnapshot;
  const station = data.station ?? 'unknown';
  const rows: ExternalMarketRow[] = [];

  const lists: Array<[string, SnapshotMarketEntry[] | undefined]> = [
    ['supply_surplus', data.supply_surplus],
    ['demand_shortage', data.demand_shortage],
    ['high_value', data.high_value],
    ['arbitrage_candidates', data.arbitrage_candidates],
  ];

  for (const [listName, entries] of lists) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry.item !== 'string') continue;
      rows.push({
        as_of_date: asOfDate,
        item_name: entry.item,
        item_id: toItemId(entry.item),
        category: entry.category ?? '',
        sell_price: Number(entry.sell_price ?? 0),
        sell_qty: Number(entry.sell_qty ?? 0),
        buy_price: Number(entry.buy_price ?? 0),
        buy_qty: Number(entry.buy_qty ?? 0),
        snapshot_list: listName,
        station,
        fetched_at: fetchedAt,
      });
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

/** Returns true if we already have rows for this date. */
export function hasSnapshotDate(date: string): boolean {
  try {
    const db = getDb();
    const row = db
      .prepare(
        'SELECT 1 FROM external_market_snapshots WHERE as_of_date = ? LIMIT 1',
      )
      .get(date);
    return !!row;
  } catch {
    return false;
  }
}

/** Persist rows for one date. Idempotent — uses INSERT OR IGNORE. */
export function persistSnapshotRows(rows: ExternalMarketRow[]): number {
  if (rows.length === 0) return 0;

  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO external_market_snapshots
      (as_of_date, item_name, item_id, category,
       sell_price, sell_qty, buy_price, buy_qty,
       snapshot_list, station, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const result = stmt.run(
        r.as_of_date,
        r.item_name,
        r.item_id,
        r.category,
        r.sell_price,
        r.sell_qty,
        r.buy_price,
        r.buy_qty,
        r.snapshot_list,
        r.station,
        r.fetched_at,
      );
      inserted += Number(result.changes);
    }
  });
  tx();

  return inserted;
}

// ---------------------------------------------------------------------------
// Fetch + store
// ---------------------------------------------------------------------------

export interface FetchResult {
  date: string;
  rows_inserted: number;
  skipped: boolean;
  error?: string;
}

/**
 * Fetch and persist the snapshot for a specific date.
 * Returns a result object (never throws).
 */
export async function fetchAndPersistSnapshot(date: string): Promise<FetchResult> {
  const url = snapshotUrl(date);

  if (hasSnapshotDate(date)) {
    log.debug(`Snapshot for ${date} already persisted — skipping`);
    return { date, rows_inserted: 0, skipped: true };
  }

  let raw: unknown;
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) {
      return { date, rows_inserted: 0, skipped: false, error: `HTTP ${resp.status} from ${url}` };
    }
    raw = await resp.json();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { date, rows_inserted: 0, skipped: false, error: `fetch failed: ${msg}` };
  }

  const fetchedAt = new Date().toISOString();
  const rows = parseSnapshot(raw, date, fetchedAt);

  if (rows.length === 0) {
    return { date, rows_inserted: 0, skipped: false, error: 'snapshot parsed but produced 0 rows (malformed?)' };
  }

  const inserted = persistSnapshotRows(rows);
  log.info(`Snapshot ${date}: ${inserted} rows inserted`);
  return { date, rows_inserted: inserted, skipped: false };
}

/**
 * Daily cron job — fetch yesterday's snapshot (mkryo59 publishes ~04:30 UTC,
 * we run at 06:05 UTC to give it buffer).  Also backfills today in case the
 * cron missed a day.
 */
export async function runDailySnapshotFetch(): Promise<void> {
  log.info('Daily external market snapshot fetch starting');

  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setUTCDate(today.getUTCDate() - 1);

  const dates = [formatDate(yesterday), formatDate(today)];

  for (const date of dates) {
    try {
      const result = await fetchAndPersistSnapshot(date);
      if (result.skipped) {
        log.debug(`Snapshot ${date} skipped (already present)`);
      } else if (result.error) {
        log.warn(`Snapshot ${date} failed: ${result.error}`);
      } else {
        log.info(`Snapshot ${date} done: ${result.rows_inserted} rows`);
      }
    } catch (e) {
      log.error(`Unexpected error fetching snapshot ${date}`, { error: e });
    }
  }
}

// ---------------------------------------------------------------------------
// Query helpers (used by MCP tool handler)
// ---------------------------------------------------------------------------

interface SnapshotQueryRow {
  id: number;
  as_of_date: string;
  item_name: string;
  item_id: string;
  category: string;
  sell_price: number;
  sell_qty: number;
  buy_price: number;
  buy_qty: number;
  snapshot_list: string;
  station: string;
  fetched_at: string;
}

export interface SnapshotQueryResult {
  as_of: string;
  item_id: string;
  item_name: string;
  category: string;
  sell_price: number;
  sell_qty: number;
  buy_price: number;
  buy_qty: number;
  snapshot_list: string;
  station: string;
  note: string;
}

/**
 * Look up the most recent snapshot rows for an item_id.
 *
 * item_id is matched as an exact or prefix match (snake_case).
 * Returns rows ordered by date descending, then snapshot_list.
 */
export function queryRecentSnapshot(
  itemId: string,
  limit = 10,
): SnapshotQueryResult[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM external_market_snapshots
       WHERE item_id = ?
       ORDER BY as_of_date DESC, snapshot_list ASC
       LIMIT ?`,
    )
    .all(itemId, limit) as SnapshotQueryRow[];

  return rows.map((r) => ({
    as_of: r.as_of_date,
    item_id: r.item_id,
    item_name: r.item_name,
    category: r.category,
    sell_price: r.sell_price,
    sell_qty: r.sell_qty,
    buy_price: r.buy_price,
    buy_qty: r.buy_qty,
    snapshot_list: r.snapshot_list,
    station: r.station,
    note: 'STALE: community snapshot from mkryo59-afk, single station only — verify with live market before trading',
  }));
}

/** Return all dates we have snapshot data for. */
export function listSnapshotDates(): string[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT DISTINCT as_of_date FROM external_market_snapshots ORDER BY as_of_date DESC`,
    )
    .all() as Array<{ as_of_date: string }>;
  return rows.map((r) => r.as_of_date);
}

/** Return the most recent snapshot date, or null if none. */
export function latestSnapshotDate(): string | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT as_of_date FROM external_market_snapshots ORDER BY as_of_date DESC LIMIT 1`,
    )
    .get() as { as_of_date: string } | undefined;
  return row?.as_of_date ?? null;
}

/** Summary of snapshot coverage for health checks. */
export function getSnapshotCoverage(): {
  total_rows: number;
  dates_available: number;
  latest_date: string | null;
  items_covered: number;
} {
  const db = getDb();
  const r = db
    .prepare(
      `SELECT
         COUNT(*) as total_rows,
         COUNT(DISTINCT as_of_date) as dates_available,
         COUNT(DISTINCT item_id) as items_covered
       FROM external_market_snapshots`,
    )
    .get() as { total_rows: number; dates_available: number; items_covered: number } | undefined;

  return {
    total_rows: r?.total_rows ?? 0,
    dates_available: r?.dates_available ?? 0,
    latest_date: latestSnapshotDate(),
    items_covered: r?.items_covered ?? 0,
  };
}
