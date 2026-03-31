import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { createDatabase, getDb, closeDb } from '../../services/database.js';

import toolCallsRoutes from './tool-calls.js';

const app = express();
app.use(express.json());
app.use('/api/tool-calls', toolCallsRoutes);

describe('GET /api/tool-calls/missions', () => {
  beforeEach(() => {
    createDatabase(':memory:');
  });

  afterEach(() => {
    closeDb();
  });

  it('returns empty array when no mission data exists', async () => {
    const res = await request(app).get('/api/tool-calls/missions?agent=drifter-gale');
    expect(res.status).toBe(200);
    expect(res.body.missions).toEqual([]);
  });

  it('rejects missing or invalid agent name', async () => {
    const res1 = await request(app).get('/api/tool-calls/missions');
    expect(res1.status).toBe(400);

    const res2 = await request(app).get('/api/tool-calls/missions?agent=DROP%20TABLE');
    expect(res2.status).toBe(400);
  });

  it('returns parsed missions from latest get_active_missions result', async () => {
    const db = getDb();
    const missions = [
      { id: 'm1', title: 'Deliver Iron Ore', objectives: [{ type: 'delivery', target: 'iron_ore', count: 10 }], reward: { credits: 500 }, status: 'active' },
      { id: 'm2', title: 'Patrol Sol', objectives: [{ type: 'combat', target: 'pirates' }], reward: { credits: 1200 }, status: 'active' },
    ];
    db.prepare(`
      INSERT INTO proxy_tool_calls (agent, tool_name, result_summary, success, status, timestamp)
      VALUES (?, ?, ?, 1, 'complete', datetime('now'))
    `).run('drifter-gale', 'get_active_missions', JSON.stringify({ missions }));

    const res = await request(app).get('/api/tool-calls/missions?agent=drifter-gale');
    expect(res.status).toBe(200);
    expect(res.body.missions).toHaveLength(2);
    expect(res.body.missions[0].id).toBe('m1');
    expect(res.body.missions[1].id).toBe('m2');
  });

  it('returns empty array when result_summary is malformed JSON', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO proxy_tool_calls (agent, tool_name, result_summary, success, status, timestamp)
      VALUES (?, ?, ?, 1, 'complete', datetime('now'))
    `).run('drifter-gale', 'get_active_missions', '{"missions":[{truncated');

    const res = await request(app).get('/api/tool-calls/missions?agent=drifter-gale');
    expect(res.status).toBe(200);
    expect(res.body.missions).toEqual([]);
  });

  it('returns latest call result when multiple records exist', async () => {
    const db = getDb();
    const oldMissions = [{ id: 'old', title: 'Old Mission', reward: { credits: 100 }, status: 'completed' }];
    const newMissions = [{ id: 'new', title: 'New Mission', reward: { credits: 500 }, status: 'active' }];

    db.prepare(`
      INSERT INTO proxy_tool_calls (agent, tool_name, result_summary, success, status, timestamp)
      VALUES (?, ?, ?, 1, 'complete', datetime('now', '-1 hour'))
    `).run('drifter-gale', 'get_active_missions', JSON.stringify({ missions: oldMissions }));

    db.prepare(`
      INSERT INTO proxy_tool_calls (agent, tool_name, result_summary, success, status, timestamp)
      VALUES (?, ?, ?, 1, 'complete', datetime('now'))
    `).run('drifter-gale', 'get_active_missions', JSON.stringify({ missions: newMissions }));

    const res = await request(app).get('/api/tool-calls/missions?agent=drifter-gale');
    expect(res.status).toBe(200);
    expect(res.body.missions[0].id).toBe('new');
  });
});
