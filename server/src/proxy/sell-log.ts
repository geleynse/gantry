import { getDbIfInitialized, queryAll } from "../services/database.js";

interface SellLogRow {
  station_id: string;
  agent: string;
  item_id: string;
  quantity: number;
  timestamp: number;
}

export interface SellEntry {
  agent: string;
  item_id: string;
  quantity: number;
  timestamp: number;
}

/**
 * SellLog — Tracks recent sell transactions per station for overlap detection.
 *
 * Uses an in-memory Map as a hot cache with optional SQLite persistence.
 * When a database is available, entries are persisted on record() and loaded
 * from DB on construction so the log survives server restarts.
 */
export class SellLog {
  private log = new Map<string, SellEntry[]>();
  private readonly ttlMs: number;

  constructor(ttlMs = 10 * 60 * 1000) {
    this.ttlMs = ttlMs;
    this.ensureTable();
    this.loadFromDb();
  }

  record(stationId: string, entry: SellEntry): void {
    const entries = this.log.get(stationId) ?? [];
    entries.push(entry);
    this.log.set(stationId, entries);
    this.persistEntry(stationId, entry);
  }

  getRecent(stationId: string): SellEntry[] {
    const entries = this.log.get(stationId);
    if (!entries) return [];
    const cutoff = Date.now() - this.ttlMs;
    const fresh = entries.filter((e) => e.timestamp >= cutoff);
    if (fresh.length !== entries.length) {
      if (fresh.length === 0) this.log.delete(stationId);
      else this.log.set(stationId, fresh);
    }
    return fresh;
  }

  findOverlaps(stationId: string, itemIds: string[], excludeAgent: string): SellEntry[] {
    const recent = this.getRecent(stationId);
    const itemSet = new Set(itemIds);
    return recent.filter((e) => e.agent !== excludeAgent && itemSet.has(e.item_id));
  }

  // --- SQLite persistence ---

  private ensureTable(): void {
    const db = getDbIfInitialized();
    if (!db) return;
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sell_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          station_id TEXT NOT NULL,
          agent TEXT NOT NULL,
          item_id TEXT NOT NULL,
          quantity INTEGER NOT NULL,
          timestamp INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sell_log_station ON sell_log(station_id);
        CREATE INDEX IF NOT EXISTS idx_sell_log_timestamp ON sell_log(timestamp);
        CREATE INDEX IF NOT EXISTS idx_sell_log_station_ts ON sell_log(station_id, timestamp);
      `);
    } catch {
      // DB not ready or table already exists — non-fatal
    }
  }

  private persistEntry(stationId: string, entry: SellEntry): void {
    const db = getDbIfInitialized();
    if (!db) return;
    try {
      db.prepare(
        'INSERT INTO sell_log (station_id, agent, item_id, quantity, timestamp) VALUES (?, ?, ?, ?, ?)'
      ).run(stationId, entry.agent, entry.item_id, entry.quantity, entry.timestamp);
    } catch {
      // Non-fatal — in-memory cache still works
    }
  }

  private loadFromDb(): void {
    const db = getDbIfInitialized();
    if (!db) return;
    try {
      const cutoff = Date.now() - this.ttlMs;
      const rows = queryAll<SellLogRow>(
        'SELECT station_id, agent, item_id, quantity, timestamp FROM sell_log WHERE timestamp >= ? ORDER BY timestamp',
        cutoff
      );
      for (const row of rows) {
        const entries = this.log.get(row.station_id) ?? [];
        entries.push({
          agent: row.agent,
          item_id: row.item_id,
          quantity: row.quantity,
          timestamp: row.timestamp,
        });
        this.log.set(row.station_id, entries);
      }

      // Clean up old rows
      db.prepare('DELETE FROM sell_log WHERE timestamp < ?').run(cutoff);
    } catch {
      // Non-fatal — start with empty cache
    }
  }
}
