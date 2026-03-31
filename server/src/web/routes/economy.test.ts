import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import request from 'supertest';
import { createDatabase, closeDb, getDb } from '../../services/database.js';
import express from 'express';
import economyRoutes from './economy.js';

let app: express.Express;

beforeAll(() => {
  createDatabase(':memory:');
  const db = getDb();

  // Seed agent_action_log with a variety of entries
  db.prepare(`
    INSERT INTO agent_action_log
      (agent, action_type, item, quantity, credits_delta, station, system, raw_data, game_timestamp, created_at)
    VALUES
      ('sable-thorn', 'sell', 'Iron Ore', 10, 1500, 'Anchor Station', 'krynn', '{}', '2026-03-01T10:00:00Z', '2026-03-01T10:00:01Z'),
      ('sable-thorn', 'buy',  'Steel',     5, -1000, 'Port Nexus',    'sol',   '{}', '2026-03-01T11:00:00Z', '2026-03-01T11:00:01Z'),
      ('drifter-gale', 'sell', 'Titanium', 3, 3000, 'Trade Hub', 'vega', '{}', '2026-03-01T12:00:00Z', '2026-03-01T12:00:01Z'),
      ('drifter-gale', 'rescue', NULL, NULL, 500, NULL, NULL, '{}', '2026-03-01T13:00:00Z', '2026-03-01T13:00:01Z'),
      ('ember-drift', 'faction_deposit', NULL, NULL, 750, 'HQ', 'sol', '{}', '2026-03-01T14:00:00Z', '2026-03-01T14:00:01Z')
  `).run();

  app = express();
  app.use('/api/economy', economyRoutes);
});

afterAll(() => {
  closeDb();
});

// ---------------------------------------------------------------------------
// GET /api/economy/actions
// ---------------------------------------------------------------------------

describe('GET /api/economy/actions', () => {
  it('returns all action log entries', async () => {
    const res = await request(app).get('/api/economy/actions');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('actions');
    expect(res.body).toHaveProperty('total');
    expect(res.body.total).toBe(5);
    expect(Array.isArray(res.body.actions)).toBe(true);
  });

  it('filters by agent', async () => {
    const res = await request(app).get('/api/economy/actions?agent=sable-thorn');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    for (const row of res.body.actions as Array<{ agent: string }>) {
      expect(row.agent).toBe('sable-thorn');
    }
  });

  it('filters by action type', async () => {
    const res = await request(app).get('/api/economy/actions?type=sell');
    expect(res.status).toBe(200);
    for (const row of res.body.actions as Array<{ action_type: string }>) {
      expect(row.action_type).toBe('sell');
    }
    expect(res.body.total).toBe(2); // sable-thorn + drifter-gale sell entries
  });

  it('combines agent and type filters', async () => {
    const res = await request(app).get('/api/economy/actions?agent=sable-thorn&type=sell');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.actions[0].agent).toBe('sable-thorn');
    expect(res.body.actions[0].action_type).toBe('sell');
  });

  it('respects limit and offset', async () => {
    const res = await request(app).get('/api/economy/actions?limit=2&offset=0');
    expect(res.status).toBe(200);
    expect(res.body.actions).toHaveLength(2);
    expect(res.body.total).toBe(5);
    expect(res.body.limit).toBe(2);
    expect(res.body.offset).toBe(0);
  });

  it('returns structured fields on each row', async () => {
    const res = await request(app).get('/api/economy/actions?agent=sable-thorn&type=sell');
    expect(res.status).toBe(200);
    const row = res.body.actions[0] as Record<string, unknown>;
    expect(typeof row.id).toBe('number');
    expect(row.agent).toBe('sable-thorn');
    expect(row.action_type).toBe('sell');
    expect(row.item).toBe('Iron Ore');
    expect(row.quantity).toBe(10);
    expect(row.credits_delta).toBe(1500);
    expect(row.station).toBe('Anchor Station');
    expect(row.system).toBe('krynn');
    expect(typeof row.created_at).toBe('string');
  });

  it('returns empty actions for unknown agent', async () => {
    const res = await request(app).get('/api/economy/actions?agent=nonexistent');
    expect(res.status).toBe(200);
    expect(res.body.actions).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });

  it('caps limit at 500', async () => {
    const res = await request(app).get('/api/economy/actions?limit=9999');
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(500);
  });

  it('returns rows sorted by created_at DESC', async () => {
    const res = await request(app).get('/api/economy/actions');
    expect(res.status).toBe(200);
    const rows = res.body.actions as Array<{ created_at: string }>;
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].created_at >= rows[i].created_at).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/economy/summary
// ---------------------------------------------------------------------------

describe('GET /api/economy/summary', () => {
  it('returns per-agent credit totals', async () => {
    const res = await request(app).get('/api/economy/summary?hours=99999');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('summary');
    const summary = res.body.summary as Array<{
      agent: string;
      total_earned: number;
      total_spent: number;
      net_credits: number;
      action_count: number;
    }>;

    const sable = summary.find(r => r.agent === 'sable-thorn');
    expect(sable).toBeDefined();
    expect(sable!.total_earned).toBe(1500);  // sell only
    expect(sable!.total_spent).toBe(1000);   // buy only
    expect(sable!.net_credits).toBe(500);    // 1500 - 1000
    expect(sable!.action_count).toBe(2);

    const drifter = summary.find(r => r.agent === 'drifter-gale');
    expect(drifter).toBeDefined();
    expect(drifter!.total_earned).toBe(3500); // 3000 sell + 500 rescue
    expect(drifter!.total_spent).toBe(0);
    expect(drifter!.net_credits).toBe(3500);
  });

  it('includes last_action_at', async () => {
    const res = await request(app).get('/api/economy/summary');
    const summary = res.body.summary as Array<{ agent: string; last_action_at: string | null }>;
    for (const row of summary) {
      expect(row.last_action_at).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/economy/types
// ---------------------------------------------------------------------------

describe('GET /api/economy/types', () => {
  it('returns distinct action types with counts', async () => {
    const res = await request(app).get('/api/economy/types');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('types');
    const types = res.body.types as Array<{ action_type: string; count: number }>;
    expect(types.length).toBeGreaterThan(0);

    const sellType = types.find(t => t.action_type === 'sell');
    expect(sellType).toBeDefined();
    expect(sellType!.count).toBe(2);

    const buyType = types.find(t => t.action_type === 'buy');
    expect(buyType).toBeDefined();
    expect(buyType!.count).toBe(1);
  });

  it('orders by count descending', async () => {
    const res = await request(app).get('/api/economy/types');
    const types = res.body.types as Array<{ action_type: string; count: number }>;
    for (let i = 1; i < types.length; i++) {
      expect(types[i - 1].count).toBeGreaterThanOrEqual(types[i].count);
    }
  });
});
