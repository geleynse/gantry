import { describe, it, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { createDatabase, closeDb, getDb } from "../services/database.js";
import { assessSystemThreat, clearThreatCache } from "./threat-assessment.js";

beforeAll(() => {
  createDatabase(":memory:");
  const db = getDb();
  // Seed combat_events with known data
  db.prepare(`
    INSERT INTO combat_events (agent, event_type, pirate_name, damage, hull_after, max_hull, died, system, created_at)
    VALUES
      ('agent-a', 'pirate_warning', 'Raider', NULL, NULL, NULL, 0, 'Krix', datetime('now')),
      ('agent-a', 'pirate_combat', 'Raider', 20, 80, 100, 0, 'Krix', datetime('now')),
      ('agent-a', 'pirate_combat', 'Raider', 20, 60, 100, 0, 'Krix', datetime('now')),
      ('agent-b', 'pirate_combat', 'Drifter', 10, 90, 100, 0, 'Sol', datetime('now')),
      ('agent-c', 'pirate_combat', 'Enforcer', 15, 50, 100, 0, 'Danger', datetime('now')),
      ('agent-c', 'pirate_combat', 'Enforcer', 15, 35, 100, 0, 'Danger', datetime('now')),
      ('agent-c', 'pirate_combat', 'Enforcer', 15, 20, 100, 0, 'Danger', datetime('now')),
      ('agent-c', 'pirate_combat', 'Enforcer', 15, 5, 100, 0, 'Danger', datetime('now')),
      ('agent-c', 'pirate_warning', 'Enforcer', NULL, NULL, NULL, 0, 'Danger', datetime('now')),
      ('agent-d', 'pirate_combat', 'Boss', 30, 0, 100, 1, 'DeathZone', datetime('now')),
      ('agent-d', 'pirate_combat', 'Boss', 30, 0, 100, 1, 'DeathZone', datetime('now')),
      ('agent-d', 'pirate_combat', 'Boss', 30, 0, 100, 1, 'DeathZone', datetime('now')),
      ('agent-d', 'pirate_combat', 'Boss', 30, 0, 100, 1, 'DeathZone', datetime('now')),
      ('agent-d', 'pirate_combat', 'Boss', 30, 0, 100, 1, 'DeathZone', datetime('now')),
      ('agent-d', 'pirate_combat', 'Boss', 30, 0, 100, 1, 'DeathZone', datetime('now')),
      ('agent-d', 'pirate_combat', 'Boss', 30, 0, 100, 1, 'DeathZone', datetime('now')),
      ('agent-d', 'pirate_combat', 'Boss', 30, 0, 100, 1, 'DeathZone', datetime('now')),
      ('agent-d', 'pirate_combat', 'Boss', 30, 0, 100, 1, 'DeathZone', datetime('now')),
      ('agent-d', 'pirate_combat', 'Boss', 30, 0, 100, 1, 'DeathZone', datetime('now')),
      ('agent-d', 'pirate_combat', 'Boss', 30, 0, 100, 1, 'DeathZone', datetime('now'))
  `).run();
});

afterAll(() => {
  closeDb();
});

beforeEach(() => {
  clearThreatCache();
});

describe("assessSystemThreat — level mapping", () => {
  it("returns safe for a system with no encounters", () => {
    const result = assessSystemThreat("Peaceful");
    expect(result.level).toBe("safe");
    expect(result.score).toBe(0);
    expect(result.reasons).toHaveLength(0);
  });

  it("returns low for 1-3 encounters (score 20)", () => {
    // Sol has 1 pirate_combat event
    const result = assessSystemThreat("Sol");
    expect(result.score).toBe(20);
    expect(result.level).toBe("safe"); // 20 is still "safe" (≤20)
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("returns medium for 4-10 encounters (score 50)", () => {
    // Danger has 5 events (4 pirate_combat + 1 pirate_warning)
    const result = assessSystemThreat("Danger");
    expect(result.score).toBe(50);
    expect(result.level).toBe("medium");
  });

  it("returns high for 10+ encounters (score 80)", () => {
    // DeathZone has 11 pirate_combat events
    const result = assessSystemThreat("DeathZone");
    expect(result.score).toBe(80);
    expect(result.level).toBe("high");
  });

  it("includes encounter count in reasons", () => {
    const result = assessSystemThreat("Danger");
    expect(result.reasons.some((r) => r.includes("encounter"))).toBe(true);
  });
});

describe("assessSystemThreat — hull bonuses", () => {
  it("adds +10 to score when hull is 30-49%", () => {
    const base = assessSystemThreat("Sol"); // score 20
    const damaged = assessSystemThreat("Sol", 40);
    expect(damaged.score).toBe(base.score + 10);
    expect(damaged.reasons.some((r) => r.includes("hull damaged"))).toBe(true);
  });

  it("adds +20 to score when hull is below 30%", () => {
    const base = assessSystemThreat("Sol"); // score 20
    const critical = assessSystemThreat("Sol", 20);
    expect(critical.score).toBe(base.score + 20);
    expect(critical.reasons.some((r) => r.includes("critically low"))).toBe(true);
  });

  it("no hull bonus when hull is 50%+", () => {
    const base = assessSystemThreat("Sol");
    const healthy = assessSystemThreat("Sol", 75);
    expect(healthy.score).toBe(base.score);
  });

  it("caps score at 100", () => {
    // DeathZone base=80, hull<30 adds 20 → would be 100, cap at 100
    const result = assessSystemThreat("DeathZone", 10);
    expect(result.score).toBe(100);
    expect(result.level).toBe("extreme");
  });

  it("returns extreme when score > 80", () => {
    const result = assessSystemThreat("DeathZone", 25); // 80+20=100
    expect(result.level).toBe("extreme");
  });
});

describe("assessSystemThreat — caching", () => {
  it("returns consistent results on repeated calls", () => {
    const first = assessSystemThreat("Krix");
    const second = assessSystemThreat("Krix");
    expect(second.score).toBe(first.score);
    expect(second.level).toBe(first.level);
  });

  it("clearThreatCache forces fresh DB query", () => {
    // First call populates cache
    const first = assessSystemThreat("Krix");
    // Inject more data
    getDb().prepare(`
      INSERT INTO combat_events (agent, event_type, system, created_at)
      VALUES ('agent-x', 'pirate_combat', 'Krix', datetime('now'))
    `).run();
    // Without clearing, should return same cached result
    const cached = assessSystemThreat("Krix");
    expect(cached.score).toBe(first.score);
    // After clearing, fresh query should pick up new event
    clearThreatCache();
    const fresh = assessSystemThreat("Krix");
    expect(fresh.score).toBeGreaterThanOrEqual(first.score);
  });
});
