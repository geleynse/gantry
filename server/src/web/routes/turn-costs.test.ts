import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { createDatabase, getDb, closeDb } from '../../services/database.js';

// Will import the route after implementing it
import toolCallsRoutes from './tool-calls.js';

const app = express();
app.use(express.json());
app.use('/api/tool-calls', toolCallsRoutes);

describe('turn-costs endpoint', () => {
  beforeEach(() => {
    createDatabase(':memory:');
    // Insert test turns data
    const db = getDb();
    db.prepare(`
      INSERT INTO turns (agent, turn_number, started_at, completed_at, duration_ms, cost_usd, input_tokens, output_tokens, cache_read_tokens, iterations, model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('drifter-gale', 1, '2026-03-06T10:00:00Z', '2026-03-06T10:00:30Z', 30000, 0.047, 12000, 5000, 0, 3, 'claude-opus');

    db.prepare(`
      INSERT INTO turns (agent, turn_number, started_at, completed_at, duration_ms, cost_usd, input_tokens, output_tokens, cache_read_tokens, iterations, model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('drifter-gale', 2, '2026-03-06T10:01:00Z', '2026-03-06T10:01:45Z', 45000, 0.063, 15000, 8000, 1000, 5, 'claude-opus');

    db.prepare(`
      INSERT INTO turns (agent, turn_number, started_at, completed_at, duration_ms, cost_usd, input_tokens, output_tokens, cache_read_tokens, iterations, model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('sable-thorn', 1, '2026-03-06T09:50:00Z', '2026-03-06T09:50:20Z', 20000, 0.032, 8000, 2000, 0, 2, 'claude-opus');
  });

  afterEach(() => {
    closeDb();
  });

  it('returns recent turns for an agent with cost data', async () => {
    const res = await request(app).get('/api/tool-calls/turn-costs?agent=drifter-gale&since=2026-03-06T09:00:00Z');
    expect(res.status).toBe(200);
    const body = res.body as any;
    expect(body.turns).toBeDefined();
    expect(Array.isArray(body.turns)).toBe(true);
    expect(body.turns.length).toBe(2);
  });

  it('returns turns with correct cost and token format', async () => {
    const res = await request(app).get('/api/tool-calls/turn-costs?agent=drifter-gale&since=2026-03-06T09:00:00Z');
    expect(res.status).toBe(200);
    const body = res.body as any;
    const first = body.turns[0];

    expect(first).toHaveProperty('turnNumber');
    expect(first).toHaveProperty('startedAt');
    expect(first).toHaveProperty('completedAt');
    expect(first).toHaveProperty('costUsd');
    expect(first).toHaveProperty('inputTokens');
    expect(first).toHaveProperty('outputTokens');
    expect(first).toHaveProperty('cacheReadTokens');
    expect(first).toHaveProperty('iterations');
    expect(first).toHaveProperty('model');

    expect(first.costUsd).toBe(0.063); // Most recent (turn 2)
    expect(first.inputTokens).toBe(15000);
    expect(first.outputTokens).toBe(8000);
    expect(first.cacheReadTokens).toBe(1000);
    expect(first.iterations).toBe(5);
  });

  it('filters by agent name', async () => {
    const res = await request(app).get('/api/tool-calls/turn-costs?agent=sable-thorn&since=2026-03-06T09:00:00Z');
    expect(res.status).toBe(200);
    const body = res.body as any;
    expect(body.turns.length).toBe(1);
    expect(body.turns[0].turnNumber).toBe(1);
  });

  it('rejects invalid agent names', async () => {
    const res = await request(app).get('/api/tool-calls/turn-costs?agent=DROP%20TABLE&since=2026-03-06T09:00:00Z');
    expect(res.status).toBe(400);
  });

  it('orders turns by started_at DESC (most recent first)', async () => {
    const res = await request(app).get('/api/tool-calls/turn-costs?agent=drifter-gale&since=2026-03-06T09:00:00Z');
    expect(res.status).toBe(200);
    const body = res.body as any;
    expect(body.turns[0].turnNumber).toBe(2); // Most recent
    expect(body.turns[1].turnNumber).toBe(1); // Earlier
  });

  it('limits results to 100 turns', async () => {
    const db = getDb();
    // Insert many turns
    for (let i = 3; i <= 150; i++) {
      db.prepare(`
        INSERT INTO turns (agent, turn_number, started_at, completed_at, duration_ms, cost_usd, input_tokens, output_tokens, cache_read_tokens, iterations, model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('drifter-gale', i, new Date(Date.parse('2026-03-06T10:00:00Z') + i * 60000).toISOString(), null, 30000, 0.05, 10000, 5000, 0, 3, 'claude-opus');
    }

    const res = await request(app).get('/api/tool-calls/turn-costs?agent=drifter-gale&since=2026-03-06T09:00:00Z');
    expect(res.status).toBe(200);
    const body = res.body as any;
    expect(body.turns.length).toBeLessThanOrEqual(100);
  });
});
