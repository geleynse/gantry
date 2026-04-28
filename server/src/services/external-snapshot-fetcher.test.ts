/**
 * external-snapshot-fetcher.test.ts
 *
 * Tests for the mkryo59-afk community snapshot fetcher.
 * All tests use in-process mocks — no real GitHub fetches.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import {
  parseSnapshot,
  toItemId,
  formatDate,
  snapshotUrl,
  hasSnapshotDate,
  persistSnapshotRows,
  listSnapshotDates,
  latestSnapshotDate,
  getSnapshotCoverage,
  fetchAndPersistSnapshot,
  type RawMarketSnapshot,
  type ExternalMarketRow,
  type SnapshotMarketEntry,
} from './external-snapshot-fetcher.js';
import { createDatabase, closeDb } from './database.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Test DB setup
// ---------------------------------------------------------------------------

function makeTestDb(): string {
  const path = join(tmpdir(), `test-ext-snap-${randomBytes(6).toString('hex')}.db`);
  createDatabase(path);
  return path;
}

// ---------------------------------------------------------------------------
// toItemId
// ---------------------------------------------------------------------------

describe('toItemId', () => {
  it('converts simple names to snake_case', () => {
    expect(toItemId('Iron Ore')).toBe('iron_ore');
    expect(toItemId('Steel Plate')).toBe('steel_plate');
    expect(toItemId('Copper Wiring')).toBe('copper_wiring');
  });

  it('handles special characters', () => {
    expect(toItemId("Founder's Wreck")).toBe('founders_wreck');
    expect(toItemId('EMP Mines')).toBe('emp_mines');
  });

  it('collapses multiple separators', () => {
    expect(toItemId('Jump  Coil')).toBe('jump_coil');
    expect(toItemId('  Leading spaces  ')).toBe('leading_spaces');
  });
});

// ---------------------------------------------------------------------------
// formatDate
// ---------------------------------------------------------------------------

describe('formatDate', () => {
  it('returns YYYY-MM-DD in UTC', () => {
    const d = new Date('2026-04-28T15:30:00Z');
    expect(formatDate(d)).toBe('2026-04-28');
  });
});

// ---------------------------------------------------------------------------
// snapshotUrl
// ---------------------------------------------------------------------------

describe('snapshotUrl', () => {
  it('builds correct GitHub raw URL', () => {
    const url = snapshotUrl('2026-04-28');
    expect(url).toContain('mkryo59-afk/spacemolt-news');
    expect(url).toContain('2026-04-28');
    expect(url).toContain('data_market.json');
  });
});

// ---------------------------------------------------------------------------
// parseSnapshot
// ---------------------------------------------------------------------------

const SAMPLE_SNAPSHOT: RawMarketSnapshot = {
  collected_at: '2026-04-28T04:27:58.688Z',
  station: 'Grand Exchange Station',
  total_items_with_orders: 183,
  supply_surplus: [
    { item: 'Iron Ore', category: 'ore', sell_price: 5, sell_qty: 20551, buy_price: 0, buy_qty: 0 },
    { item: 'Aluminum Ore', category: 'ore', sell_price: 5, sell_qty: 15000, buy_price: 0, buy_qty: 0 },
  ],
  demand_shortage: [
    { item: 'Energy Crystal', category: 'ore', buy_price: 91, buy_qty: 9388 },
  ],
  high_value: [
    { item: 'Jump Coil', category: 'component', sell_price: 0, sell_qty: 0, buy_price: 20834, buy_qty: 208 },
  ],
  arbitrage_candidates: [],
};

describe('parseSnapshot', () => {
  it('returns empty array for null/undefined input', () => {
    expect(parseSnapshot(null, '2026-04-28', 'now')).toEqual([]);
    expect(parseSnapshot(undefined, '2026-04-28', 'now')).toEqual([]);
  });

  it('returns empty array for non-object input', () => {
    expect(parseSnapshot('bad', '2026-04-28', 'now')).toEqual([]);
    expect(parseSnapshot(42, '2026-04-28', 'now')).toEqual([]);
  });

  it('parses supply_surplus entries', () => {
    const rows = parseSnapshot(SAMPLE_SNAPSHOT, '2026-04-28', '2026-04-28T06:05:00Z');
    const ironRows = rows.filter((r) => r.item_id === 'iron_ore');
    expect(ironRows.length).toBe(1);
    expect(ironRows[0].sell_price).toBe(5);
    expect(ironRows[0].sell_qty).toBe(20551);
    expect(ironRows[0].snapshot_list).toBe('supply_surplus');
    expect(ironRows[0].as_of_date).toBe('2026-04-28');
    expect(ironRows[0].station).toBe('Grand Exchange Station');
  });

  it('parses demand_shortage entries', () => {
    const rows = parseSnapshot(SAMPLE_SNAPSHOT, '2026-04-28', 'now');
    const crystalRows = rows.filter((r) => r.item_id === 'energy_crystal');
    expect(crystalRows.length).toBe(1);
    expect(crystalRows[0].buy_price).toBe(91);
    expect(crystalRows[0].snapshot_list).toBe('demand_shortage');
  });

  it('parses high_value entries', () => {
    const rows = parseSnapshot(SAMPLE_SNAPSHOT, '2026-04-28', 'now');
    const jumpRows = rows.filter((r) => r.item_id === 'jump_coil');
    expect(jumpRows.length).toBe(1);
    expect(jumpRows[0].buy_price).toBe(20834);
    expect(jumpRows[0].snapshot_list).toBe('high_value');
  });

  it('skips entries with missing item field', () => {
    const bad: RawMarketSnapshot = {
      supply_surplus: [
        { item: 'Valid Item', category: 'ore', sell_price: 10, sell_qty: 100, buy_price: 0, buy_qty: 0 },
        { item: '', category: 'ore', sell_price: 5, sell_qty: 50, buy_price: 0, buy_qty: 0 },
        { category: 'ore' } as SnapshotMarketEntry,
      ],
    };
    const rows = parseSnapshot(bad, '2026-04-28', 'now');
    // empty string item should be skipped (toItemId returns ''), non-string item skipped
    expect(rows.filter((r) => r.item_id !== '').length).toBe(1);
  });

  it('handles missing optional lists gracefully', () => {
    const minimal: RawMarketSnapshot = {
      station: 'Test Station',
      supply_surplus: [
        { item: 'Steel Plate', sell_price: 20, sell_qty: 1000, buy_price: 18, buy_qty: 500 },
      ],
    };
    const rows = parseSnapshot(minimal, '2026-04-25', 'now');
    expect(rows.length).toBe(1);
    expect(rows[0].item_id).toBe('steel_plate');
  });

  it('returns correct total count for full sample', () => {
    const rows = parseSnapshot(SAMPLE_SNAPSHOT, '2026-04-28', 'now');
    // 2 supply_surplus + 1 demand_shortage + 1 high_value = 4
    expect(rows.length).toBe(4);
  });

  it('defaults missing numeric fields to 0', () => {
    const snap: RawMarketSnapshot = {
      demand_shortage: [
        { item: 'Rare Crystal', buy_price: 500, buy_qty: 10 },
      ],
    };
    const rows = parseSnapshot(snap, '2026-04-28', 'now');
    expect(rows[0].sell_price).toBe(0);
    expect(rows[0].sell_qty).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

describe('DB operations', () => {
  beforeEach(() => {
    makeTestDb();
  });
  afterEach(() => {
    closeDb();
  });

  it('hasSnapshotDate returns false initially', () => {
    expect(hasSnapshotDate('2026-04-28')).toBe(false);
  });

  it('persistSnapshotRows inserts rows', () => {
    const rows = parseSnapshot(SAMPLE_SNAPSHOT, '2026-04-28', '2026-04-28T06:05:00Z');
    const count = persistSnapshotRows(rows);
    expect(count).toBe(rows.length);
    expect(hasSnapshotDate('2026-04-28')).toBe(true);
  });

  it('persistSnapshotRows is idempotent (INSERT OR IGNORE)', () => {
    const rows = parseSnapshot(SAMPLE_SNAPSHOT, '2026-04-28', 'now');
    persistSnapshotRows(rows);
    const count2 = persistSnapshotRows(rows);
    expect(count2).toBe(0);
  });

  it('listSnapshotDates returns inserted dates ordered desc', () => {
    const rows1 = parseSnapshot(SAMPLE_SNAPSHOT, '2026-04-27', 'now');
    const rows2 = parseSnapshot(SAMPLE_SNAPSHOT, '2026-04-28', 'now');
    persistSnapshotRows(rows1);
    persistSnapshotRows(rows2);
    const dates = listSnapshotDates();
    expect(dates[0]).toBe('2026-04-28');
    expect(dates[1]).toBe('2026-04-27');
  });

  it('latestSnapshotDate returns null when empty', () => {
    expect(latestSnapshotDate()).toBeNull();
  });

  it('latestSnapshotDate returns most recent date', () => {
    const rows = parseSnapshot(SAMPLE_SNAPSHOT, '2026-04-28', 'now');
    persistSnapshotRows(rows);
    expect(latestSnapshotDate()).toBe('2026-04-28');
  });

  it('getSnapshotCoverage returns accurate counts', () => {
    const rows1 = parseSnapshot(SAMPLE_SNAPSHOT, '2026-04-27', 'now');
    const rows2 = parseSnapshot(SAMPLE_SNAPSHOT, '2026-04-28', 'now');
    persistSnapshotRows(rows1);
    persistSnapshotRows(rows2);
    const cov = getSnapshotCoverage();
    expect(cov.dates_available).toBe(2);
    expect(cov.total_rows).toBe(rows1.length + rows2.length);
    expect(cov.latest_date).toBe('2026-04-28');
    expect(cov.items_covered).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// fetchAndPersistSnapshot with mocked fetch
// ---------------------------------------------------------------------------

describe('fetchAndPersistSnapshot', () => {
  beforeEach(() => {
    makeTestDb();
  });
  afterEach(() => {
    closeDb();
  });

  it('returns skipped=true when date already persisted', async () => {
    // Insert a row to simulate existing data
    const rows = parseSnapshot(SAMPLE_SNAPSHOT, '2026-04-28', 'now');
    persistSnapshotRows(rows);

    const result = await fetchAndPersistSnapshot('2026-04-28');
    expect(result.skipped).toBe(true);
    expect(result.date).toBe('2026-04-28');
  });

  it('returns error on HTTP failure', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 404 } as Response);

    const result = await fetchAndPersistSnapshot('2025-01-01');
    expect(result.error).toContain('HTTP 404');
    expect(result.rows_inserted).toBe(0);

    globalThis.fetch = originalFetch;
  });

  it('returns error on network failure', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('Network unreachable'); };

    const result = await fetchAndPersistSnapshot('2025-01-01');
    expect(result.error).toContain('Network unreachable');

    globalThis.fetch = originalFetch;
  });

  it('inserts rows on successful fetch', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => SAMPLE_SNAPSHOT,
    } as Response);

    const result = await fetchAndPersistSnapshot('2026-04-10');
    expect(result.error).toBeUndefined();
    expect(result.rows_inserted).toBe(4); // 4 rows in SAMPLE_SNAPSHOT
    expect(result.skipped).toBe(false);

    globalThis.fetch = originalFetch;
  });

  it('returns error when parsed snapshot yields 0 rows', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ station: 'empty', collected_at: 'now' }),
    } as Response);

    const result = await fetchAndPersistSnapshot('2026-04-11');
    expect(result.error).toContain('0 rows');

    globalThis.fetch = originalFetch;
  });
});

