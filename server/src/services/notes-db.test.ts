import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createDatabase, closeDb, getDb } from "./database.js";
import {
  autoScore,
  addDiaryEntry,
  getRecentDiary,
  upsertNote,
  searchAgentMemory,
  searchFleetMemory,
  updateImportance,
} from "./notes-db.js";

// Each test gets a fresh in-memory DB
beforeEach(() => {
  createDatabase(":memory:");
});

afterEach(() => {
  closeDb();
});

// ── autoScore ──────────────────────────────────────────────────────────────

describe("autoScore", () => {
  it("scores 0 for routine text", () => {
    expect(autoScore("traded some ore at the station")).toBe(0);
  });

  it("scores combat text (attack/destroyed) at 2", () => {
    const score = autoScore("I was attack by pirates and they destroyed my cargo");
    expect(score).toBeGreaterThanOrEqual(2);
  });

  it("scores discovery text (discovered) at 2", () => {
    const score = autoScore("discovered a new system with rare resources");
    expect(score).toBeGreaterThanOrEqual(2);
  });

  it("scores profit/earnings text at 1", () => {
    const score = autoScore("earned 5000 credits from this trade run");
    expect(score).toBeGreaterThanOrEqual(1);
  });

  it("scores lesson/learning text at 3", () => {
    const score = autoScore("lesson learned: never trade in contested systems");
    expect(score).toBeGreaterThanOrEqual(3);
  });

  it("caps at 5 even with many signals", () => {
    const score = autoScore("combat attack destroyed learned lesson never again earned profit discovered first");
    expect(score).toBe(5);
  });

  it("scores 'important' keyword", () => {
    const score = autoScore("this is an important finding about market prices");
    expect(score).toBeGreaterThanOrEqual(3);
  });
});

// ── addDiaryEntry with importance ──────────────────────────────────────────

describe("addDiaryEntry with importance", () => {
  it("stores explicit importance and retrieves it", () => {
    const id = addDiaryEntry("ember-drift", "mined ore at belt", 7);
    const entries = getRecentDiary("ember-drift", 1);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(id);
    expect(entries[0].importance).toBe(7);
  });

  it("auto-scores when importance is not provided", () => {
    addDiaryEntry("ember-drift", "discovered a new system with rare ore");
    const entries = getRecentDiary("ember-drift", 1);
    expect(entries[0].importance).toBeGreaterThan(0);
  });

  it("explicit importance of 0 overrides auto-score (even for high-signal text)", () => {
    addDiaryEntry("ember-drift", "discovered new system, earned credits, combat attack", 0);
    const entries = getRecentDiary("ember-drift", 1);
    expect(entries[0].importance).toBe(0);
  });

  it("explicit importance of 10 stores correctly", () => {
    addDiaryEntry("ember-drift", "routine trade run", 10);
    const entries = getRecentDiary("ember-drift", 1);
    expect(entries[0].importance).toBe(10);
  });
});

// ── searchAgentMemory ordering ─────────────────────────────────────────────

describe("searchAgentMemory ordering", () => {
  it("returns results ordered by importance DESC", () => {
    addDiaryEntry("null-spark", "found ore at belt", 1);
    addDiaryEntry("null-spark", "critical combat lesson learned: flee", 5);
    addDiaryEntry("null-spark", "sold ore for profit", 2);

    const results = searchAgentMemory("null-spark", "ore");
    // Highest importance first
    expect(results[0].importance).toBeGreaterThanOrEqual(results[results.length - 1].importance);
  });

  it("high-importance entry appears before low-importance even if older", () => {
    // Insert low-importance first (gets earlier ID/timestamp)
    addDiaryEntry("null-spark", "found ore — routine run", 1);
    // Then insert high-importance
    addDiaryEntry("null-spark", "found ore — critical lesson learned", 5);

    const results = searchAgentMemory("null-spark", "found ore");
    expect(results).toHaveLength(2);
    expect(results[0].importance).toBe(5);
    expect(results[1].importance).toBe(1);
  });

  it("includes importance field in each result", () => {
    addDiaryEntry("null-spark", "discovered ore vein", 3);
    const results = searchAgentMemory("null-spark", "ore");
    expect(results[0]).toHaveProperty("importance");
    expect(typeof results[0].importance).toBe("number");
  });
});

// ── updateImportance ───────────────────────────────────────────────────────

describe("updateImportance", () => {
  it("updates diary entry importance and returns true", () => {
    const id = addDiaryEntry("cinder-wake", "mined 50 ore", 1);
    const ok = updateImportance("diary", id, 8);
    expect(ok).toBe(true);

    const entries = getRecentDiary("cinder-wake", 5);
    const entry = entries.find(e => e.id === id);
    expect(entry?.importance).toBe(8);
  });

  it("returns false for non-existent ID", () => {
    const ok = updateImportance("diary", 99999, 5);
    expect(ok).toBe(false);
  });

  it("updates doc importance and returns true", () => {
    upsertNote("cinder-wake", "strategy", "mine ore always", 0);
    const db = getDb();
    const row = db.prepare("SELECT id FROM agent_docs WHERE agent = ? AND note_type = ?").get("cinder-wake", "strategy") as { id: number };
    const ok = updateImportance("docs", row.id, 6);
    expect(ok).toBe(true);

    const result = db.prepare("SELECT importance FROM agent_docs WHERE id = ?").get(row.id) as { importance: number };
    expect(result.importance).toBe(6);
  });
});

// ── searchFleetMemory includes importance ──────────────────────────────────

describe("searchFleetMemory", () => {
  it("includes importance field in fleet search results", () => {
    addDiaryEntry("ember-drift", "found ore vein", 4);
    const results = searchFleetMemory("ore");
    expect(results).toHaveLength(1);
    expect(results[0]).toHaveProperty("importance");
    expect(results[0].importance).toBe(4);
  });

  it("orders fleet results by importance DESC", () => {
    addDiaryEntry("ember-drift", "found ore — casual", 1);
    addDiaryEntry("null-spark", "found ore — lesson learned never again", 5);

    const results = searchFleetMemory("found ore");
    expect(results[0].importance).toBeGreaterThanOrEqual(results[results.length - 1].importance);
    expect(results[0].importance).toBe(5);
  });

  it("includes agent field in fleet results", () => {
    addDiaryEntry("ember-drift", "discovered rare ore", 3);
    const results = searchFleetMemory("ore");
    expect(results[0]).toHaveProperty("agent");
    expect(results[0].agent).toBe("ember-drift");
  });
});

// ── upsertNote with importance ─────────────────────────────────────────────

describe("upsertNote with importance", () => {
  it("stores explicit importance on upsert", () => {
    upsertNote("sable-thorn", "discoveries", "rich belt at nova", 7);
    const row = getDb().prepare("SELECT importance FROM agent_docs WHERE agent = ? AND note_type = ?").get("sable-thorn", "discoveries") as { importance: number };
    expect(row.importance).toBe(7);
  });

  it("auto-scores doc content when no importance given", () => {
    upsertNote("sable-thorn", "strategy", "lesson learned: always check fuel first");
    const row = getDb().prepare("SELECT importance FROM agent_docs WHERE agent = ? AND note_type = ?").get("sable-thorn", "strategy") as { importance: number };
    expect(row.importance).toBeGreaterThan(0);
  });
});
