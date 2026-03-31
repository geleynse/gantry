/**
 * Tests for combat encounter grouping logic (#228) and filter combinations (#230).
 *
 * groupEncounters() is a pure function exported from the combat page — tests here
 * are fast, dependency-free unit tests.
 */

import { describe, it, expect } from "bun:test";
import { groupEncounters } from "@/lib/combat-grouping";
import type { Encounter } from "@/components/encounter-card";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEncounter(overrides: Partial<Encounter> = {}): Encounter {
  return {
    id: 1,
    agent: "drifter-gale",
    pirate_name: "Rogue Interceptor",
    pirate_tier: "small",
    system: "Vega Prime",
    started_at: "2026-03-07T10:00:00Z",
    ended_at: "2026-03-07T10:05:00Z",
    outcome: "survived",
    total_damage: 50,
    hull_start: 100,
    hull_end: 50,
    max_hull: 100,
    ...overrides,
  };
}

const ENCOUNTERS: Encounter[] = [
  makeEncounter({ id: 1, agent: "drifter-gale", system: "Vega Prime", outcome: "survived" }),
  makeEncounter({ id: 2, agent: "drifter-gale", system: "Krynn", outcome: "died" }),
  makeEncounter({ id: 3, agent: "sable-thorn", system: "Vega Prime", outcome: "fled" }),
  makeEncounter({ id: 4, agent: "nova-strike", system: "Sol", outcome: "survived" }),
  makeEncounter({ id: 5, agent: "nova-strike", system: "Vega Prime", outcome: "survived" }),
];

// ---------------------------------------------------------------------------
// groupEncounters — flat
// ---------------------------------------------------------------------------

describe("groupEncounters (flat)", () => {
  it("returns a single group with all encounters", () => {
    const groups = groupEncounters(ENCOUNTERS, "flat");
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("__flat__");
    expect(groups[0].encounters).toHaveLength(5);
  });

  it("preserves encounter order in flat mode", () => {
    const groups = groupEncounters(ENCOUNTERS, "flat");
    const ids = groups[0].encounters.map((e) => e.id);
    expect(ids).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns one group for an empty list", () => {
    const groups = groupEncounters([], "flat");
    expect(groups).toHaveLength(1);
    expect(groups[0].encounters).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// groupEncounters — by agent
// ---------------------------------------------------------------------------

describe("groupEncounters (by agent)", () => {
  it("creates one group per distinct agent", () => {
    const groups = groupEncounters(ENCOUNTERS, "agent");
    const keys = groups.map((g) => g.key);
    expect(keys).toContain("drifter-gale");
    expect(keys).toContain("sable-thorn");
    expect(keys).toContain("nova-strike");
    expect(keys).toHaveLength(3);
  });

  it("each group contains only encounters for that agent", () => {
    const groups = groupEncounters(ENCOUNTERS, "agent");
    for (const group of groups) {
      expect(group.encounters.every((e) => e.agent === group.key)).toBe(true);
    }
  });

  it("drifter-gale group has 2 encounters", () => {
    const groups = groupEncounters(ENCOUNTERS, "agent");
    const drifter = groups.find((g) => g.key === "drifter-gale");
    expect(drifter).toBeDefined();
    expect(drifter!.encounters).toHaveLength(2);
  });

  it("nova-strike group has 2 encounters", () => {
    const groups = groupEncounters(ENCOUNTERS, "agent");
    const nova = groups.find((g) => g.key === "nova-strike");
    expect(nova).toBeDefined();
    expect(nova!.encounters).toHaveLength(2);
  });

  it("handles single-encounter agents correctly", () => {
    const groups = groupEncounters(ENCOUNTERS, "agent");
    const sable = groups.find((g) => g.key === "sable-thorn");
    expect(sable).toBeDefined();
    expect(sable!.encounters).toHaveLength(1);
  });

  it("returns empty groups list for empty input", () => {
    const groups = groupEncounters([], "agent");
    expect(groups).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// groupEncounters — by system
// ---------------------------------------------------------------------------

describe("groupEncounters (by system)", () => {
  it("creates one group per distinct system", () => {
    const groups = groupEncounters(ENCOUNTERS, "system");
    const keys = groups.map((g) => g.key);
    expect(keys).toContain("Vega Prime");
    expect(keys).toContain("Krynn");
    expect(keys).toContain("Sol");
    expect(keys).toHaveLength(3);
  });

  it("Vega Prime group has 3 encounters", () => {
    const groups = groupEncounters(ENCOUNTERS, "system");
    const vega = groups.find((g) => g.key === "Vega Prime");
    expect(vega).toBeDefined();
    expect(vega!.encounters).toHaveLength(3);
  });

  it("each group contains only encounters in that system", () => {
    const groups = groupEncounters(ENCOUNTERS, "system");
    for (const group of groups) {
      expect(group.encounters.every((e) => (e.system ?? "Unknown") === group.key)).toBe(true);
    }
  });

  it("encounters with null system are grouped under 'Unknown'", () => {
    const encs = [
      makeEncounter({ id: 10, system: null }),
      makeEncounter({ id: 11, system: null }),
    ];
    const groups = groupEncounters(encs, "system");
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("Unknown");
    expect(groups[0].encounters).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Filter combination tests (backend — via encounter grouping of pre-filtered data)
// The backend handles AND-logic filtering before returning encounters.
// These tests verify that groupEncounters respects the already-filtered input.
// ---------------------------------------------------------------------------

describe("groupEncounters with pre-filtered data (filter combinations)", () => {
  it("agent + outcome filter: drifter-gale died encounters group correctly", () => {
    // Simulate backend returning only drifter-gale + outcome=died
    const filtered = ENCOUNTERS.filter(
      (e) => e.agent === "drifter-gale" && e.outcome === "died"
    );
    const groups = groupEncounters(filtered, "agent");
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("drifter-gale");
    expect(groups[0].encounters).toHaveLength(1);
    expect(groups[0].encounters[0].outcome).toBe("died");
  });

  it("system + outcome filter: Vega Prime survived encounters", () => {
    const filtered = ENCOUNTERS.filter(
      (e) => e.system === "Vega Prime" && e.outcome === "survived"
    );
    const groups = groupEncounters(filtered, "system");
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("Vega Prime");
    // drifter-gale id=1 and nova-strike id=5 are survived in Vega Prime
    expect(groups[0].encounters).toHaveLength(2);
  });

  it("empty filter result produces empty groups (by agent)", () => {
    const filtered: Encounter[] = [];
    const groups = groupEncounters(filtered, "agent");
    expect(groups).toHaveLength(0);
  });

  it("empty filter result produces single empty flat group", () => {
    const filtered: Encounter[] = [];
    const groups = groupEncounters(filtered, "flat");
    expect(groups).toHaveLength(1);
    expect(groups[0].encounters).toHaveLength(0);
  });
});
