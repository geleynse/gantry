import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createDatabase, getDb, closeDb, pruneAnalyticsTables } from "./database.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";

describe("Database Contention Audit", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fleet-db-test-"));
    dbPath = join(tmpDir, "fleet.db");
    createDatabase(dbPath);
  });

  afterEach(() => {
    closeDb();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("should have WAL mode enabled", () => {
    const db = getDb();
    const result = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    // Current code disables WAL for tests, so this might fail until fixed
    expect(result.journal_mode.toUpperCase()).toBe("WAL");
  });

  it("should have busy_timeout set to 5000", () => {
    const db = getDb();
    // PRAGMA busy_timeout returns a single row with one value
    const result = db.prepare("PRAGMA busy_timeout").get() as any;
    const timeout = Object.values(result)[0] as number;
    expect(timeout).toBe(5000);
  });

  it("should support concurrent writes without erroring immediately", async () => {
    const db = getDb();
    
    // Simulate concurrent writes from "multiple connections" 
    // (In reality, they share the same Database object in this test, but we can simulate contention)
    // Actually, to truly test contention we'd need separate Database objects pointing to same file.
    
    const db1 = getDb();
    const db2 = new (require("bun:sqlite").Database)(dbPath);
    
    // Set busy_timeout for the second connection too
    db2.run("PRAGMA busy_timeout = 5000");

    const p1 = new Promise((resolve, reject) => {
      try {
        db1.transaction(() => {
          // Hold the lock for a short while
          db1.run("INSERT INTO proxy_tool_calls (agent, tool_name, success) VALUES ('agent1', 'tool1', 1)");
          // Artificial delay is hard inside a synchronous transaction in Bun:sqlite
        })();
        resolve(true);
      } catch (e) {
        reject(e);
      }
    });

    const p2 = new Promise((resolve, reject) => {
      try {
        // This should wait for p1 to finish because of busy_timeout
        db2.run("INSERT INTO proxy_tool_calls (agent, tool_name, success) VALUES ('agent2', 'tool2', 1)");
        resolve(true);
      } catch (e) {
        reject(e);
      }
    });

    await Promise.all([p1, p2]);
    db2.close();
    
    const count = db1.prepare("SELECT COUNT(*) as count FROM proxy_tool_calls").get() as { count: number };
    expect(count.count).toBe(2);
  });

  it("galaxy_pois table has dockable column", () => {
    const db = getDb();
    const info = db.prepare("PRAGMA table_info(galaxy_pois)").all() as Array<{ name: string }>;
    const columns = info.map(r => r.name);
    expect(columns).toContain("dockable");
  });
});

describe("analytics retention and hot-path indexes", () => {
  beforeEach(() => {
    createDatabase(":memory:");
  });

  afterEach(() => {
    closeDb();
  });

  it("creates the hot-path indexes on existing databases", () => {
    const db = getDb();
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>)
      .map((r) => r.name);
    expect(names).toContain("idx_fleet_order_deliveries_agent");
    expect(names).toContain("idx_market_history_item_poi_type");
  });

  it("prunes analytics rows older than their retention windows", () => {
    const db = getDb();

    // Old turn (100 days) with child rows; recent turn stays.
    db.run(`INSERT INTO turns (agent, turn_number, started_at) VALUES ('a1', 1, datetime('now', '-100 days'))`);
    const oldTurnId = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
    db.run(`INSERT INTO turns (agent, turn_number, started_at) VALUES ('a1', 2, datetime('now'))`);
    const newTurnId = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;

    db.run(`INSERT INTO tool_calls (turn_id, sequence_number, tool_name) VALUES (${oldTurnId}, 1, 'get_status')`);
    db.run(`INSERT INTO tool_calls (turn_id, sequence_number, tool_name) VALUES (${newTurnId}, 1, 'get_status')`);
    db.run(`INSERT INTO game_snapshots (turn_id, agent) VALUES (${oldTurnId}, 'a1')`);
    db.run(`INSERT INTO combat_events (agent, turn_id, event_type, created_at) VALUES ('a1', ${oldTurnId}, 'hit', datetime('now', '-100 days'))`);
    db.run(`INSERT INTO captains_logs (agent, game_log_id, entry_text, created_at) VALUES ('a1', 'g1', 'old', datetime('now', '-100 days'))`);
    db.run(`INSERT INTO agent_action_log (agent, action_type, created_at) VALUES ('a1', 'sell', datetime('now', '-40 days'))`);
    db.run(`INSERT INTO agent_action_log (agent, action_type, created_at) VALUES ('a1', 'sell', datetime('now'))`);
    db.run(`INSERT INTO fleet_comms_log (type, message, created_at) VALUES ('report', 'old', datetime('now', '-40 days'))`);
    db.run(`INSERT INTO fleet_comms_log (type, message, created_at) VALUES ('report', 'new', datetime('now'))`);

    const deleted = pruneAnalyticsTables();
    expect(deleted).toBe(7); // old turn + tool_call + snapshot + combat + captains + action + comms

    const count = (table: string) =>
      (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
    expect(count("turns")).toBe(1);
    expect(count("tool_calls")).toBe(1);
    expect(count("game_snapshots")).toBe(0);
    expect(count("combat_events")).toBe(0);
    expect(count("captains_logs")).toBe(0);
    expect(count("agent_action_log")).toBe(1);
    expect(count("fleet_comms_log")).toBe(1);
  });
});

describe("overseer_decisions table", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fleet-db-test-"));
    dbPath = join(tmpDir, "fleet.db");
    createDatabase(dbPath);
  });

  afterEach(() => {
    closeDb();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("exists and accepts inserts", () => {
    const db = getDb();
    const id = db.prepare(`
      INSERT INTO overseer_decisions (tick_number, triggered_by, snapshot_json, response_json, actions_json, results_json, model, status)
      VALUES (1, 'scheduled', '{}', '{}', '[]', '[]', 'haiku', 'success')
    `).run().lastInsertRowid;
    expect(id).toBeGreaterThan(0);

    const row = db.prepare("SELECT * FROM overseer_decisions WHERE id = ?").get(id) as Record<string, unknown>;
    expect(row.tick_number).toBe(1);
    expect(row.triggered_by).toBe("scheduled");
    expect(row.status).toBe("success");
  });
});
