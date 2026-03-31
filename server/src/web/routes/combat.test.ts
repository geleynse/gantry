import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import request from 'supertest';
import { createDatabase, closeDb, getDb } from '../../services/database.js';
import express from 'express';
import combatRoutes from './combat.js';

let app: express.Express;

// Track first-inserted id for encounter detail tests
let drifterFirstEventId: number;

beforeAll(() => {
  createDatabase(':memory:');
  const db = getDb();

  // Seed combat_events
  // drifter-gale: one encounter against 'Drifter' (dies), then a second against 'Raider' (survived)
  // sable-thorn: one encounter against 'Enforcer' (fled — hull > 0, no death)
  // Two drifter-gale events against 'Raider' are 10 minutes apart — should be split into 2 encounters
  const info = db.prepare(`
    INSERT INTO combat_events (agent, event_type, pirate_name, pirate_tier, damage, hull_after, max_hull, died, insurance_payout, system, created_at)
    VALUES
      ('drifter-gale', 'pirate_warning', 'Drifter', 'small', NULL, NULL, NULL, 0, NULL, 'krynn', '2026-02-26T10:00:00'),
      ('drifter-gale', 'pirate_combat', 'Drifter', 'small', 15, 85, 100, 0, NULL, 'krynn', '2026-02-26T10:01:00'),
      ('drifter-gale', 'pirate_combat', 'Drifter', 'small', 15, 0, 100, 0, NULL, 'krynn', '2026-02-26T10:02:00'),
      ('drifter-gale', 'player_died', NULL, NULL, NULL, NULL, NULL, 1, 2210, 'krynn', '2026-02-26T10:03:00'),
      ('sable-thorn', 'pirate_combat', 'Enforcer', 'large', 33, 67, 100, 0, NULL, 'sol', '2026-02-26T11:00:00')
  `).run();

  // Capture id of the first drifter-gale row for encounter-detail tests
  const firstId = Number(info.lastInsertRowid) - 4;
  drifterFirstEventId = firstId;

  app = express();
  app.use('/api/combat', combatRoutes);
});

afterAll(() => {
  closeDb();
});

describe('GET /api/combat/summary', () => {
  it('returns per-agent stats', async () => {
    const res = await request(app).get('/api/combat/summary');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('summary');
    const summary = res.body.summary as Array<{ agent: string; total_deaths: number; total_damage: number }>;
    const drifter = summary.find((s) => s.agent === 'drifter-gale');
    expect(drifter).toBeDefined();
    expect(drifter!.total_deaths).toBe(1);
    expect(drifter!.total_damage).toBe(30); // 15+15
  });
});

describe('GET /api/combat/log', () => {
  it('returns paginated events', async () => {
    const res = await request(app).get('/api/combat/log');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('events');
    expect(res.body).toHaveProperty('total');
    expect(res.body.total).toBe(5);
  });

  it('filters by agent', async () => {
    const res = await request(app).get('/api/combat/log?agent=sable-thorn');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.events[0].agent).toBe('sable-thorn');
  });

  it('respects limit and offset', async () => {
    const res = await request(app).get('/api/combat/log?limit=2&offset=0');
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(2);
  });
});

describe('GET /api/combat/systems', () => {
  it('returns top systems by encounter count', async () => {
    const res = await request(app).get('/api/combat/systems');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('systems');
    const systems = res.body.systems as Array<{ system: string; encounter_count: number }>;
    expect(systems.length).toBeGreaterThan(0);
    const krynn = systems.find((s) => s.system === 'krynn');
    expect(krynn).toBeDefined();
    expect(krynn!.encounter_count).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/combat/encounters
// ---------------------------------------------------------------------------

describe('GET /api/combat/encounters', () => {
  it('groups consecutive same-agent same-pirate events into one encounter', async () => {
    const res = await request(app).get('/api/combat/encounters?agent=drifter-gale');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('encounters');
    const encounters = res.body.encounters as Array<Record<string, unknown>>;
    // drifter-gale has one encounter (warning + 2 combat + died all within 5 min)
    expect(encounters).toHaveLength(1);
    expect(encounters[0].events_count).toBe(4);
  });

  it('creates a new encounter when pirate_name changes', async () => {
    const db = getDb();
    // Insert a second encounter for drifter-gale with a different pirate
    db.prepare(`
      INSERT INTO combat_events (agent, event_type, pirate_name, pirate_tier, damage, hull_after, max_hull, died, system, created_at)
      VALUES ('drifter-gale', 'pirate_combat', 'Warlord', 'medium', 20, 80, 100, 0, 'krynn', '2026-02-26T10:04:00')
    `).run();

    const res = await request(app).get('/api/combat/encounters?agent=drifter-gale');
    expect(res.status).toBe(200);
    const encounters = res.body.encounters as Array<{ pirate_name: string }>;
    const pirateNames = encounters.map((e) => e.pirate_name);
    expect(pirateNames).toContain('Warlord');
    expect(encounters.length).toBeGreaterThanOrEqual(2);
  });

  it('creates a new encounter when time gap exceeds 5 minutes', async () => {
    const db = getDb();
    // Add events for 'Drifter' but 10 minutes after the last Drifter event — should be new encounter
    db.prepare(`
      INSERT INTO combat_events (agent, event_type, pirate_name, pirate_tier, damage, hull_after, max_hull, died, system, created_at)
      VALUES ('drifter-gale', 'pirate_combat', 'Drifter', 'small', 5, 95, 100, 0, 'krynn', '2026-02-26T10:13:00')
    `).run();

    const res = await request(app).get('/api/combat/encounters?agent=drifter-gale');
    expect(res.status).toBe(200);
    const encounters = res.body.encounters as Array<{ pirate_name: string; started_at: string }>;
    const drifterEncounters = encounters.filter((e) => e.pirate_name === 'Drifter');
    // There should now be at least 2 Drifter encounters (original + gap encounter)
    expect(drifterEncounters.length).toBeGreaterThanOrEqual(2);
  });

  it('handles a single-event encounter correctly', async () => {
    const res = await request(app).get('/api/combat/encounters?agent=sable-thorn');
    expect(res.status).toBe(200);
    const encounters = res.body.encounters as Array<Record<string, unknown>>;
    expect(encounters).toHaveLength(1);
    expect(encounters[0].events_count).toBe(1);
    expect(encounters[0].agent).toBe('sable-thorn');
  });

  it('outcome is "died" when any event has died=1', async () => {
    const res = await request(app).get('/api/combat/encounters?agent=drifter-gale');
    expect(res.status).toBe(200);
    const encounters = res.body.encounters as Array<{ outcome: string; pirate_name: string; started_at: string }>;
    // The original Drifter encounter at 10:00 includes a player_died event
    const diedEncounter = encounters.find(
      (e) => e.pirate_name === 'Drifter' && e.started_at === '2026-02-26T10:00:00'
    );
    expect(diedEncounter).toBeDefined();
    expect(diedEncounter!.outcome).toBe('died');
  });

  it('outcome is "survived" when no died events and hull_end is 0', async () => {
    // The 'Warlord' encounter added earlier has hull_after=80 and no deaths → 'fled'
    // We need a clean scenario for 'survived'; insert a new agent encounter
    const db = getDb();
    db.prepare(`
      INSERT INTO combat_events (agent, event_type, pirate_name, pirate_tier, damage, hull_after, max_hull, died, system, created_at)
      VALUES ('nova-strike', 'pirate_combat', 'Bandit', 'small', 10, 0, 100, 0, 'sol', '2026-02-27T08:00:00')
    `).run();

    const res = await request(app).get('/api/combat/encounters?agent=nova-strike');
    expect(res.status).toBe(200);
    const encounters = res.body.encounters as Array<{ outcome: string }>;
    expect(encounters).toHaveLength(1);
    expect(encounters[0].outcome).toBe('survived');
  });

  it('filters by agent', async () => {
    const res = await request(app).get('/api/combat/encounters?agent=sable-thorn');
    expect(res.status).toBe(200);
    const encounters = res.body.encounters as Array<{ agent: string }>;
    expect(encounters.every((e) => e.agent === 'sable-thorn')).toBe(true);
  });

  it('filters by outcome', async () => {
    const res = await request(app).get('/api/combat/encounters?outcome=died');
    expect(res.status).toBe(200);
    const encounters = res.body.encounters as Array<{ outcome: string }>;
    expect(encounters.length).toBeGreaterThan(0);
    expect(encounters.every((e) => e.outcome === 'died')).toBe(true);
  });

  it('filters by pirate_tier', async () => {
    const res = await request(app).get('/api/combat/encounters?pirate_tier=large');
    expect(res.status).toBe(200);
    const encounters = res.body.encounters as Array<{ pirate_tier: string }>;
    expect(encounters.length).toBeGreaterThan(0);
    expect(encounters.every((e) => e.pirate_tier === 'large')).toBe(true);
  });

  it('filters by from/to date range', async () => {
    const res = await request(app).get(
      '/api/combat/encounters?from=2026-02-26T10:59:00&to=2026-02-26T11:01:00'
    );
    expect(res.status).toBe(200);
    const encounters = res.body.encounters as Array<{ agent: string }>;
    // Only the sable-thorn encounter at 11:00 falls in this window
    expect(encounters).toHaveLength(1);
    expect(encounters[0].agent).toBe('sable-thorn');
  });

  it('paginates with limit and offset', async () => {
    const resAll = await request(app).get('/api/combat/encounters');
    const total = resAll.body.total as number;

    const resPage = await request(app).get('/api/combat/encounters?limit=1&offset=0');
    expect(resPage.status).toBe(200);
    expect(resPage.body.encounters).toHaveLength(1);
    expect(resPage.body.total).toBe(total);
    expect(resPage.body.limit).toBe(1);
    expect(resPage.body.offset).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/combat/encounters/:id
// ---------------------------------------------------------------------------

describe('GET /api/combat/encounters/:id', () => {
  it('returns the encounter summary and raw events for a valid id', async () => {
    // Get valid id from the encounters list
    const listRes = await request(app).get('/api/combat/encounters?agent=sable-thorn');
    const encounterId = listRes.body.encounters[0].id as number;

    const res = await request(app).get(`/api/combat/encounters/${encounterId}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('encounter');
    expect(res.body).toHaveProperty('events');
    expect(res.body.encounter.agent).toBe('sable-thorn');
    expect(Array.isArray(res.body.events)).toBe(true);
    expect(res.body.events.length).toBeGreaterThanOrEqual(1);
  });

  it('returns 404 for an unknown id', async () => {
    const res = await request(app).get('/api/combat/encounters/999999');
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
  });

  it('returns 400 for a non-numeric id', async () => {
    const res = await request(app).get('/api/combat/encounters/not-a-number');
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });
});

// ---------------------------------------------------------------------------
// GET /api/combat/death-heatmap
// ---------------------------------------------------------------------------

describe('GET /api/combat/death-heatmap', () => {
  it('returns heatmap array', async () => {
    const res = await request(app).get('/api/combat/death-heatmap');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('heatmap');
    expect(Array.isArray(res.body.heatmap)).toBe(true);
  });

  it('each row has system, agent, date, deaths, encounters, damage fields', async () => {
    // Insert a death event in a recent timestamp so it falls within default 168h window
    const db = getDb();
    db.prepare(`
      INSERT INTO combat_events (agent, event_type, pirate_name, pirate_tier, damage, hull_after, max_hull, died, system, created_at)
      VALUES ('heatmap-agent', 'player_died', NULL, NULL, NULL, NULL, NULL, 1, 'heatmap-system', datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO combat_events (agent, event_type, pirate_name, pirate_tier, damage, hull_after, max_hull, died, system, created_at)
      VALUES ('heatmap-agent', 'pirate_combat', 'Raider', 'small', 25, 75, 100, 0, 'heatmap-system', datetime('now', '-1 minute'))
    `).run();

    const res = await request(app).get('/api/combat/death-heatmap');
    expect(res.status).toBe(200);
    const heatmap = res.body.heatmap as Array<{
      system: string; agent: string; date: string;
      deaths: number; encounters: number; damage: number;
    }>;
    const row = heatmap.find((r) => r.system === 'heatmap-system' && r.agent === 'heatmap-agent');
    expect(row).toBeDefined();
    expect(row!.deaths).toBe(1);
    expect(row!.encounters).toBe(1);
    expect(row!.damage).toBe(25);
    expect(typeof row!.date).toBe('string');
  });

  it('filters by hours param — old events excluded', async () => {
    // The seed data from beforeAll uses '2026-02-26' which is well outside 1 hour
    const res = await request(app).get('/api/combat/death-heatmap?hours=1');
    expect(res.status).toBe(200);
    const heatmap = res.body.heatmap as Array<{ system: string; agent: string }>;
    // Old seed events in 'krynn'/'sol' should not appear in the 1-hour window
    const oldRows = heatmap.filter((r) => r.system === 'krynn' || r.system === 'sol');
    expect(oldRows).toHaveLength(0);
  });

  it('groups multiple days for same system+agent as separate rows', async () => {
    const db = getDb();
    // Insert two death events on different days for same system+agent
    db.prepare(`
      INSERT INTO combat_events (agent, event_type, pirate_name, pirate_tier, damage, hull_after, max_hull, died, system, created_at)
      VALUES ('multi-day-agent', 'player_died', NULL, NULL, NULL, NULL, NULL, 1, 'multi-day-sys', datetime('now', '-1 day'))
    `).run();
    db.prepare(`
      INSERT INTO combat_events (agent, event_type, pirate_name, pirate_tier, damage, hull_after, max_hull, died, system, created_at)
      VALUES ('multi-day-agent', 'player_died', NULL, NULL, NULL, NULL, NULL, 1, 'multi-day-sys', datetime('now'))
    `).run();

    const res = await request(app).get('/api/combat/death-heatmap?hours=168');
    expect(res.status).toBe(200);
    const heatmap = res.body.heatmap as Array<{ system: string; agent: string; date: string; deaths: number }>;
    const rows = heatmap.filter((r) => r.system === 'multi-day-sys' && r.agent === 'multi-day-agent');
    // Should be 2 separate rows (one per day)
    expect(rows.length).toBe(2);
    // Each row should have exactly 1 death
    for (const row of rows) {
      expect(row.deaths).toBe(1);
    }
  });

  it('includes rows with null system (combat events without known location)', async () => {
    // Insert an event with null system — should be included (system may be unknown)
    const db = getDb();
    db.prepare(`
      INSERT INTO combat_events (agent, event_type, pirate_name, pirate_tier, damage, hull_after, max_hull, died, system, created_at)
      VALUES ('ghost-agent', 'pirate_combat', 'Ghost', 'small', 10, 90, 100, 0, NULL, datetime('now'))
    `).run();

    const res = await request(app).get('/api/combat/death-heatmap');
    expect(res.status).toBe(200);
    const heatmap = res.body.heatmap as Array<{ system: string | null; agent: string }>;
    const ghostRows = heatmap.filter((r) => r.agent === 'ghost-agent');
    expect(ghostRows.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/combat/timeline
// ---------------------------------------------------------------------------

describe('GET /api/combat/timeline', () => {
  it('returns daily aggregation grouped by agent', async () => {
    const res = await request(app).get('/api/combat/timeline');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('timeline');
    const timeline = res.body.timeline as Array<{ agent: string; date: string; encounters: number; deaths: number; damage: number }>;
    expect(Array.isArray(timeline)).toBe(true);
    expect(timeline.length).toBeGreaterThan(0);
    // Each row must have all required fields
    for (const row of timeline) {
      expect(typeof row.agent).toBe('string');
      expect(typeof row.date).toBe('string');
      expect(typeof row.encounters).toBe('number');
      expect(typeof row.deaths).toBe('number');
      expect(typeof row.damage).toBe('number');
    }
  });

  it('shows deaths and damage totals per agent per day', async () => {
    const res = await request(app).get('/api/combat/timeline');
    expect(res.status).toBe(200);
    const timeline = res.body.timeline as Array<{ agent: string; date: string; deaths: number; damage: number }>;

    // drifter-gale on 2026-02-26 should have 1 death and damage > 0
    const drifterRow = timeline.find((r) => r.agent === 'drifter-gale' && r.date === '2026-02-26');
    expect(drifterRow).toBeDefined();
    expect(drifterRow!.deaths).toBeGreaterThanOrEqual(1);
    expect(drifterRow!.damage).toBeGreaterThan(0);

    // sable-thorn on 2026-02-26 should have 0 deaths and damage = 33
    const sableRow = timeline.find((r) => r.agent === 'sable-thorn' && r.date === '2026-02-26');
    expect(sableRow).toBeDefined();
    expect(sableRow!.deaths).toBe(0);
    expect(sableRow!.damage).toBe(33);
  });
});
