/**
 * Tests for the POI Lore Service (Task #27).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createDatabase, closeDb } from "./database.js";
import {
  recordLore,
  getLore,
  searchLore,
  getPoiLore,
  deleteLore,
  buildLoreHint,
  autoRecordLoreFromResult,
} from "./poi-lore.js";

beforeEach(() => {
  createDatabase(":memory:");
});

afterEach(() => {
  closeDb();
});

// ---------------------------------------------------------------------------
// recordLore + getLore (system)
// ---------------------------------------------------------------------------

describe("recordLore + getLore(system)", () => {
  it("stores a lore entry and retrieves it by system", () => {
    recordLore("Sol", "sol_station", "Main trading hub. Has market, repair, and fuel.", "drifter-gale");
    const lore = getLore("Sol");
    expect(lore).toHaveLength(1);
    expect(lore[0].poi_name).toBe("sol_station");
    expect(lore[0].note).toContain("trading hub");
    expect(lore[0].discovered_by).toBe("drifter-gale");
    expect(lore[0].system).toBe("Sol");
  });

  it("returns empty array for unknown system", () => {
    const lore = getLore("UnknownSystem");
    expect(lore).toEqual([]);
  });

  it("stores multiple lore entries for same system", () => {
    recordLore("Krix", "krix_belt", "Asteroid belt, good for mining.", "sable-thorn");
    recordLore("Krix", "krix_station", "Krix station with basic services.", "rust-vane");
    const lore = getLore("Krix");
    expect(lore).toHaveLength(2);
    const names = lore.map(l => l.poi_name);
    expect(names).toContain("krix_belt");
    expect(names).toContain("krix_station");
  });

  it("stores and retrieves tags", () => {
    recordLore("Sol", "sol_market", "Market hub.", "drifter-gale", ["trade", "repair"]);
    const lore = getLore("Sol");
    expect(lore[0].tags).toEqual(["trade", "repair"]);
  });

  it("handles no tags gracefully", () => {
    recordLore("Sol", "sol_station", "Station.", "drifter-gale");
    const lore = getLore("Sol");
    expect(lore[0].tags).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getLore (system, poiName)
// ---------------------------------------------------------------------------

describe("getLore(system, poiName)", () => {
  it("returns specific lore entry", () => {
    recordLore("Sol", "sol_station", "Main hub.", "drifter-gale");
    const lore = getLore("Sol", "sol_station");
    expect(lore).not.toBeNull();
    expect(lore!.poi_name).toBe("sol_station");
    expect(lore!.note).toBe("Main hub.");
  });

  it("returns null for unknown poi", () => {
    recordLore("Sol", "sol_station", "Main hub.", "drifter-gale");
    expect(getLore("Sol", "nonexistent")).toBeNull();
  });

  it("returns null for unknown system", () => {
    expect(getLore("UnknownSystem", "some_poi")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Upsert behavior
// ---------------------------------------------------------------------------

describe("upsert behavior", () => {
  it("replaces existing entry with new note", () => {
    recordLore("Sol", "sol_station", "Old note.", "drifter-gale");
    recordLore("Sol", "sol_station", "Updated note.", "rust-vane");
    const lore = getLore("Sol", "sol_station");
    expect(lore!.note).toBe("Updated note.");
    expect(lore!.discovered_by).toBe("rust-vane");
  });

  it("only one entry exists after upsert", () => {
    recordLore("Sol", "sol_station", "First.", "agent-a");
    recordLore("Sol", "sol_station", "Second.", "agent-b");
    const lore = getLore("Sol");
    expect(lore).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// searchLore
// ---------------------------------------------------------------------------

describe("searchLore", () => {
  beforeEach(() => {
    recordLore("Sol", "sol_station", "Main trading hub with market and repair.", "agent-a", ["trade"]);
    recordLore("Krix", "krix_belt", "Dangerous asteroid belt. Lots of pirates.", "agent-b", ["danger"]);
    recordLore("Sirius", "sirius_refinery", "Ore refinery with fuel services.", "agent-c", ["fuel"]);
  });

  it("finds entries matching note text", () => {
    const results = searchLore("pirate");
    expect(results).toHaveLength(1);
    expect(results[0].poi_name).toBe("krix_belt");
  });

  it("finds entries matching poi_name", () => {
    const results = searchLore("refinery");
    expect(results).toHaveLength(1);
    expect(results[0].system).toBe("Sirius");
  });

  it("finds entries matching system name", () => {
    const results = searchLore("sol");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some(r => r.system === "Sol")).toBe(true);
  });

  it("is case-insensitive", () => {
    const results = searchLore("TRADING");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].note).toContain("trading");
  });

  it("returns empty array for no matches", () => {
    expect(searchLore("xyzzy_no_match")).toEqual([]);
  });

  it("returns empty array for empty keyword", () => {
    expect(searchLore("")).toEqual([]);
    expect(searchLore("   ")).toEqual([]);
  });

  it("returns multiple matches", () => {
    const results = searchLore("a"); // matches many entries
    expect(results.length).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// getPoiLore (alias)
// ---------------------------------------------------------------------------

describe("getPoiLore", () => {
  it("returns lore for known poi", () => {
    recordLore("Sol", "sol_station", "Hub.", "agent-a");
    const lore = getPoiLore("Sol", "sol_station");
    expect(lore).not.toBeNull();
    expect(lore!.note).toBe("Hub.");
  });

  it("returns null for unknown poi", () => {
    expect(getPoiLore("Sol", "unknown_poi")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deleteLore
// ---------------------------------------------------------------------------

describe("deleteLore", () => {
  it("deletes an existing entry and returns true", () => {
    recordLore("Sol", "sol_station", "Hub.", "agent-a");
    expect(deleteLore("Sol", "sol_station")).toBe(true);
    expect(getLore("Sol", "sol_station")).toBeNull();
  });

  it("returns false when entry does not exist", () => {
    expect(deleteLore("Sol", "nonexistent")).toBe(false);
  });

  it("only deletes the targeted entry", () => {
    recordLore("Sol", "sol_station", "Hub.", "agent-a");
    recordLore("Sol", "sol_belt", "Belt.", "agent-b");
    deleteLore("Sol", "sol_station");
    const remaining = getLore("Sol");
    expect(remaining).toHaveLength(1);
    expect(remaining[0].poi_name).toBe("sol_belt");
  });
});

// ---------------------------------------------------------------------------
// buildLoreHint
// ---------------------------------------------------------------------------

describe("buildLoreHint", () => {
  it("returns null when no lore exists", () => {
    expect(buildLoreHint("Sol", "unknown_poi")).toBeNull();
  });

  it("returns formatted hint string", () => {
    recordLore("Sol", "sol_station", "Trading hub.", "agent-a");
    const hint = buildLoreHint("Sol", "sol_station");
    expect(hint).not.toBeNull();
    expect(hint).toContain("KNOWN POI");
    expect(hint).toContain("sol_station");
    expect(hint).toContain("Trading hub.");
  });

  it("includes tags in hint when present", () => {
    recordLore("Sol", "sol_station", "Hub.", "agent-a", ["trade", "repair"]);
    const hint = buildLoreHint("Sol", "sol_station");
    expect(hint).toContain("trade");
    expect(hint).toContain("repair");
  });

  it("omits tags section when no tags", () => {
    recordLore("Sol", "sol_station", "Hub.", "agent-a");
    const hint = buildLoreHint("Sol", "sol_station");
    expect(hint).not.toContain("[");
  });
});

// ---------------------------------------------------------------------------
// autoRecordLoreFromResult
// ---------------------------------------------------------------------------

describe("autoRecordLoreFromResult", () => {
  it("records lore when result has type and services", () => {
    const result = {
      type: "station",
      services: ["market", "repair", "fuel"],
    };
    autoRecordLoreFromResult("Sol", "sol_station", "agent-a", result);
    const lore = getPoiLore("Sol", "sol_station");
    expect(lore).not.toBeNull();
    expect(lore!.note).toContain("station");
    expect(lore!.note).toContain("market");
  });

  it("does nothing for empty result", () => {
    autoRecordLoreFromResult("Sol", "sol_poi", "agent-a", {});
    expect(getPoiLore("Sol", "sol_poi")).toBeNull();
  });

  it("does nothing for non-object result", () => {
    autoRecordLoreFromResult("Sol", "sol_poi", "agent-a", "string result");
    expect(getPoiLore("Sol", "sol_poi")).toBeNull();
  });

  it("does nothing when system or poiName is empty", () => {
    autoRecordLoreFromResult("", "sol_poi", "agent-a", { type: "station" });
    autoRecordLoreFromResult("Sol", "", "agent-a", { type: "station" });
    expect(getLore("")).toEqual([]);
  });

  it("sets trade tag when services include market", () => {
    autoRecordLoreFromResult("Sol", "sol_station", "agent-a", {
      type: "station",
      services: ["market"],
    });
    const lore = getPoiLore("Sol", "sol_station");
    expect(lore?.tags).toContain("trade");
  });

  it("sets fuel tag when services include fuel", () => {
    autoRecordLoreFromResult("Krix", "krix_depot", "agent-a", {
      type: "depot",
      services: ["fuel"],
    });
    const lore = getPoiLore("Krix", "krix_depot");
    expect(lore?.tags).toContain("fuel");
  });

  it("recorded_by is the agent name", () => {
    autoRecordLoreFromResult("Sol", "sol_station", "rust-vane", {
      type: "station",
      services: ["repair"],
    });
    const lore = getPoiLore("Sol", "sol_station");
    expect(lore!.discovered_by).toBe("rust-vane");
  });
});
