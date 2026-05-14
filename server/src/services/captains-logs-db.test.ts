import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createDatabase, closeDb } from "./database.js";
import {
  persistCaptainsLogEntry,
  searchCaptainsLogs,
  detectStrandedLoop,
} from "./captains-logs-db.js";
import { isRestartSuppressed } from "./overseer-stop-cooldown.js";
import { hasSignal } from "./signals-db.js";
import { markDockable } from "./galaxy-poi-registry.js";

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

describe("detectStrandedLoop", () => {
  const strandedEntry = (i: number) =>
    `LOC: wasat wasat_gas_cloud undocked\nCR: 1350000 1/160 0/70\nDID: still stranded ${i}\nNEXT: wait`;

  it("flags 3 consecutive low-fuel logs at same non-station POI", () => {
    persistCaptainsLogEntry("sable-thorn", strandedEntry(1), "log-1");
    persistCaptainsLogEntry("sable-thorn", strandedEntry(2), "log-2");
    persistCaptainsLogEntry("sable-thorn", strandedEntry(3), "log-3");

    // Persist also runs detection internally; verify both side effects.
    expect(isRestartSuppressed("sable-thorn").suppressed).toBe(true);
    expect(isRestartSuppressed("sable-thorn").holdOffline).toBe(true);
    expect(hasSignal("sable-thorn", "shutdown")).toBe(true);
  });

  it("does NOT flag if fewer than 3 logs exist", () => {
    persistCaptainsLogEntry("sable-thorn", strandedEntry(1), "log-1");
    persistCaptainsLogEntry("sable-thorn", strandedEntry(2), "log-2");
    expect(isRestartSuppressed("sable-thorn").suppressed).toBe(false);
    expect(hasSignal("sable-thorn", "shutdown")).toBe(false);
  });

  it("does NOT flag if agent moved between logs", () => {
    persistCaptainsLogEntry("sable-thorn", strandedEntry(1), "log-1");
    persistCaptainsLogEntry(
      "sable-thorn",
      `LOC: wasat wasat_star undocked\nCR: 1350000 1/160 0/70`,
      "log-2",
    );
    persistCaptainsLogEntry("sable-thorn", strandedEntry(3), "log-3");
    expect(isRestartSuppressed("sable-thorn").suppressed).toBe(false);
  });

  it("does NOT flag if fuel rose above threshold mid-window", () => {
    persistCaptainsLogEntry("sable-thorn", strandedEntry(1), "log-1");
    persistCaptainsLogEntry(
      "sable-thorn",
      `LOC: wasat wasat_gas_cloud undocked\nCR: 1350000 40/160 0/70`,
      "log-2",
    );
    persistCaptainsLogEntry("sable-thorn", strandedEntry(3), "log-3");
    expect(isRestartSuppressed("sable-thorn").suppressed).toBe(false);
  });

  it("does NOT flag low-fuel-at-station — agent can refuel there", () => {
    // Mark sol_central as a known dockable station BEFORE persisting logs.
    markDockable("sol_central", true, { name: "Sol Central", system: "sol" });
    const stationEntry = (i: number) =>
      `LOC: sol sol_central docked\nCR: 100 1/160 0/70\nDID: docked, low fuel ${i}`;
    persistCaptainsLogEntry("rust-vane", stationEntry(1), "log-1");
    persistCaptainsLogEntry("rust-vane", stationEntry(2), "log-2");
    persistCaptainsLogEntry("rust-vane", stationEntry(3), "log-3");
    expect(isRestartSuppressed("rust-vane").suppressed).toBe(false);
  });

  it("flags unknown POI (not yet registered) — typical strand case", () => {
    // No markDockable call — the POI is unknown to the registry. Treat
    // unknown POIs as non-dockable so the strand fires.
    persistCaptainsLogEntry("hollow-pyre", strandedEntry(1), "log-1");
    persistCaptainsLogEntry("hollow-pyre", strandedEntry(2), "log-2");
    persistCaptainsLogEntry("hollow-pyre", strandedEntry(3), "log-3");
    expect(isRestartSuppressed("hollow-pyre").suppressed).toBe(true);
    expect(isRestartSuppressed("hollow-pyre").holdOffline).toBe(true);
  });

  it("detectStrandedLoop returns false when called explicitly with insufficient history", () => {
    expect(detectStrandedLoop("never-logged-agent")).toBe(false);
  });
});
