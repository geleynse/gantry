import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createDatabase, closeDb } from "./database.js";
import {
  persistCaptainsLogEntry,
  searchCaptainsLogs,
} from "./captains-logs-db.js";

// Each test gets a fresh in-memory DB
beforeEach(() => {
  createDatabase(":memory:");
});

afterEach(() => {
  closeDb();
});

describe("searchCaptainsLogs", () => {
  it("returns empty array when no entries match", () => {
    persistCaptainsLogEntry("scout-1", "LOC: Sol\nCR: 100 5/10 0/20", "log-001");
    const results = searchCaptainsLogs("scout-1", "nonexistent-query");
    expect(results).toEqual([]);
  });

  it("matches entries by entry_text content", () => {
    persistCaptainsLogEntry(
      "scout-1",
      "LOC: Sol\nCR: 100 5/10 0/20\nDID: mined iron_ore at belt",
      "log-001",
    );
    persistCaptainsLogEntry(
      "scout-1",
      "LOC: Sol\nCR: 200 5/10 0/20\nDID: traded copper at station",
      "log-002",
    );

    const results = searchCaptainsLogs("scout-1", "iron_ore");
    expect(results).toHaveLength(1);
    expect(results[0].entry_text).toContain("iron_ore");
  });

  it("matches entries by location system", () => {
    persistCaptainsLogEntry(
      "scout-1",
      "LOC: Andromeda Outpost\nCR: 100 5/10 0/20",
      "log-001",
    );
    persistCaptainsLogEntry(
      "scout-1",
      "LOC: Sol\nCR: 100 5/10 0/20",
      "log-002",
    );

    const results = searchCaptainsLogs("scout-1", "Andromeda");
    expect(results).toHaveLength(1);
    expect(results[0].loc_system).toBe("Andromeda");
  });

  it("scopes results to the requested agent only", () => {
    persistCaptainsLogEntry("scout-1", "DID: mined ore", "log-a-001");
    persistCaptainsLogEntry("scout-2", "DID: mined ore", "log-b-001");

    const results = searchCaptainsLogs("scout-1", "ore");
    expect(results).toHaveLength(1);
    expect(results[0].agent).toBe("scout-1");
  });

  it("respects limit parameter", () => {
    for (let i = 0; i < 5; i++) {
      persistCaptainsLogEntry("scout-1", `DID: mined ore run ${i}`, `log-${i}`);
    }
    const results = searchCaptainsLogs("scout-1", "ore", 3);
    expect(results).toHaveLength(3);
  });

  it("returns results in reverse chronological order", () => {
    persistCaptainsLogEntry("scout-1", "DID: ore early run", "log-1");
    persistCaptainsLogEntry("scout-1", "DID: ore late run", "log-2");

    const results = searchCaptainsLogs("scout-1", "ore");
    expect(results).toHaveLength(2);
    // Most recent first
    expect(results[0].entry_text).toContain("late");
    expect(results[1].entry_text).toContain("early");
  });
});
