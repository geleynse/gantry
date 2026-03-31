import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { SellLog } from "./sell-log.js";
import { createDatabase, closeDb, queryAll } from "../services/database.js";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

describe("SellLog", () => {
  it("records and retrieves sell entries for a station", () => {
    const log = new SellLog();
    log.record("sol_station", { agent: "rust-vane", item_id: "iron_ore", quantity: 50, timestamp: Date.now() });
    const entries = log.getRecent("sol_station");
    expect(entries).toHaveLength(1);
    expect(entries[0].agent).toBe("rust-vane");
    expect(entries[0].item_id).toBe("iron_ore");
  });

  it("expires entries older than TTL", () => {
    const log = new SellLog(60_000);
    log.record("sol_station", { agent: "rust-vane", item_id: "iron_ore", quantity: 50, timestamp: Date.now() - 120_000 });
    const entries = log.getRecent("sol_station");
    expect(entries).toHaveLength(0);
  });

  it("returns empty array for unknown station", () => {
    const log = new SellLog();
    expect(log.getRecent("unknown_station")).toEqual([]);
  });

  it("filters by item_id when checking overlaps", () => {
    const log = new SellLog();
    log.record("sol_station", { agent: "rust-vane", item_id: "iron_ore", quantity: 50, timestamp: Date.now() });
    log.record("sol_station", { agent: "lumen-shoal", item_id: "steel_plate", quantity: 20, timestamp: Date.now() });
    const overlaps = log.findOverlaps("sol_station", ["iron_ore"], "cinder-wake");
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].agent).toBe("rust-vane");
  });

  it("excludes own agent from overlaps", () => {
    const log = new SellLog();
    log.record("sol_station", { agent: "rust-vane", item_id: "iron_ore", quantity: 50, timestamp: Date.now() });
    const overlaps = log.findOverlaps("sol_station", ["iron_ore"], "rust-vane");
    expect(overlaps).toHaveLength(0);
  });
});

describe("SellLog persistence", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sell-log-test-"));
    createDatabase(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    closeDb();
    // On Windows, SQLite WAL/SHM files may still be locked briefly after close.
    // Retry cleanup with increasing delays to avoid EBUSY failures.
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
        return;
      } catch (e: any) {
        if (e?.code !== 'EBUSY') throw e;
        Bun.sleepSync(100 * (i + 1));
      }
    }
  });

  it("persists entries to SQLite on record()", () => {
    const log = new SellLog();
    const now = Date.now();
    log.record("alpha_station", { agent: "rust-vane", item_id: "iron_ore", quantity: 50, timestamp: now });

    interface SellLogRow { station_id: string; agent: string; item_id: string; quantity: number; timestamp: number }
    const rows = queryAll<SellLogRow>("SELECT * FROM sell_log");
    expect(rows).toHaveLength(1);
    expect(rows[0].station_id).toBe("alpha_station");
    expect(rows[0].agent).toBe("rust-vane");
    expect(rows[0].item_id).toBe("iron_ore");
    expect(rows[0].quantity).toBe(50);
    expect(rows[0].timestamp).toBe(now);
  });

  it("loads persisted entries on construction", () => {
    const log1 = new SellLog();
    const now = Date.now();
    log1.record("alpha_station", { agent: "rust-vane", item_id: "iron_ore", quantity: 50, timestamp: now });
    log1.record("alpha_station", { agent: "lumen-shoal", item_id: "copper_ore", quantity: 30, timestamp: now });

    // Create a new SellLog — should load from DB
    const log2 = new SellLog();
    const entries = log2.getRecent("alpha_station");
    expect(entries).toHaveLength(2);
    expect(entries.map(e => e.item_id).sort()).toEqual(["copper_ore", "iron_ore"]);
  });

  it("does not load expired entries from DB", () => {
    const ttlMs = 60_000;
    const log1 = new SellLog(ttlMs);
    // Record an entry that's already expired
    log1.record("alpha_station", { agent: "rust-vane", item_id: "iron_ore", quantity: 50, timestamp: Date.now() - 120_000 });
    // Record a fresh entry
    log1.record("alpha_station", { agent: "lumen-shoal", item_id: "copper_ore", quantity: 30, timestamp: Date.now() });

    const log2 = new SellLog(ttlMs);
    const entries = log2.getRecent("alpha_station");
    expect(entries).toHaveLength(1);
    expect(entries[0].item_id).toBe("copper_ore");
  });

  it("survives restart — findOverlaps works after reload", () => {
    const log1 = new SellLog();
    const now = Date.now();
    log1.record("beta_station", { agent: "rust-vane", item_id: "iron_ore", quantity: 50, timestamp: now });
    log1.record("beta_station", { agent: "cinder-wake", item_id: "steel_plate", quantity: 20, timestamp: now });

    // Simulate restart
    const log2 = new SellLog();
    const overlaps = log2.findOverlaps("beta_station", ["iron_ore"], "cinder-wake");
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].agent).toBe("rust-vane");
  });
});
