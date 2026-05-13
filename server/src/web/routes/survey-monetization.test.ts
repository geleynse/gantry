/**
 * Route tests for /api/survey-monetization.
 *
 * Mirrors the pattern in economy.test.ts: in-memory DB, seed proxy_tool_calls,
 * mount the router on a bare Express app and supertest it.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import request from 'supertest';
import express from 'express';
import { createDatabase, closeDb, getDb } from '../../services/database.js';
import surveyRoutes from './survey-monetization.js';

let app: express.Express;

beforeAll(() => {
  createDatabase(':memory:');
  app = express();
  app.use('/api/survey-monetization', surveyRoutes);
});

afterAll(() => {
  closeDb();
});

beforeEach(() => {
  getDb().run('DELETE FROM proxy_tool_calls');
  getDb().run('DELETE FROM session_handoffs');
});

function seedNote(opts: {
  agent: string;
  title: string;
  price: number;
  result?: string | null;
  success?: number;
  hoursAgo?: number;
}) {
  const ts = new Date(Date.now() - (opts.hoursAgo ?? 0) * 3600 * 1000).toISOString();
  getDb()
    .prepare(`
      INSERT INTO proxy_tool_calls (agent, tool_name, args_summary, result_summary, success, created_at, timestamp)
      VALUES (?, 'create_note', ?, ?, ?, ?, ?)
    `)
    .run(
      opts.agent,
      JSON.stringify({ title: opts.title, price: opts.price }),
      opts.result ?? null,
      opts.success ?? 1,
      ts,
      ts,
    );
}

describe('GET /api/survey-monetization', () => {
  it('returns zero counts for both spec agents on empty DB', async () => {
    const res = await request(app).get('/api/survey-monetization');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ hours: 24 });
    expect(res.body.agents).toHaveLength(2);
    for (const a of res.body.agents as Array<{ notesPosted: number }>) {
      expect(a.notesPosted).toBe(0);
    }
    expect(res.body.recent).toEqual([]);
  });

  it('counts seeded notes per agent', async () => {
    seedNote({ agent: 'drifter-gale', title: 'INTEL-SIRIUS-2026-04-27', price: 1000 });
    seedNote({ agent: 'drifter-gale', title: 'INTEL-VEGA-2026-04-28',   price: 1000 });
    seedNote({ agent: 'lumen-shoal',  title: 'BELT-REPORT-Y-2026-05-06', price: 500 });

    const res = await request(app).get('/api/survey-monetization?hours=168');
    expect(res.status).toBe(200);

    const drifter = (res.body.agents as Array<{ agent: string; notesPosted: number }>)
      .find((a) => a.agent === 'drifter-gale');
    expect(drifter?.notesPosted).toBe(2);

    const lumen = (res.body.agents as Array<{ agent: string; notesPosted: number }>)
      .find((a) => a.agent === 'lumen-shoal');
    expect(lumen?.notesPosted).toBe(1);

    expect(res.body.recent.length).toBe(3);
  });

  it('honours the agent query param', async () => {
    seedNote({ agent: 'drifter-gale', title: 'INTEL-SIRIUS-2026-04-27', price: 1000 });
    seedNote({ agent: 'lumen-shoal',  title: 'BELT-REPORT-Y-2026-05-06', price: 500 });

    const res = await request(app).get('/api/survey-monetization?agent=drifter-gale');
    expect(res.status).toBe(200);
    expect(res.body.agents).toHaveLength(1);
    expect(res.body.agents[0].agent).toBe('drifter-gale');
    expect(res.body.recent.every((n: { recordedAgent: string }) => n.recordedAgent === 'drifter-gale')).toBe(true);
  });

  it('clamps hours to [1, 720]', async () => {
    const tooHigh = await request(app).get('/api/survey-monetization?hours=99999');
    expect(tooHigh.status).toBe(200);
    expect(tooHigh.body.hours).toBe(720);

    const tooLow = await request(app).get('/api/survey-monetization?hours=0');
    expect(tooLow.status).toBe(200);
    expect(tooLow.body.hours).toBe(1);
  });

  it('reports sell-through and credits earned when result data has buyer info', async () => {
    seedNote({
      agent: 'drifter-gale',
      title: 'INTEL-S-2026-05-06',
      price: 1000,
      result: '{"id":"n1","sold":true,"sale_price":1000,"buyer_id":"p2"}',
    });
    seedNote({
      agent: 'drifter-gale',
      title: 'INTEL-T-2026-05-06',
      price: 1000,
      result: '{"id":"n2","status":"listed","price":1000}',
    });

    const res = await request(app).get('/api/survey-monetization');
    const drifter = (res.body.agents as Array<{
      agent: string; sellThroughRate: number | null; totalCreditsEarned: number;
    }>).find((a) => a.agent === 'drifter-gale')!;
    expect(drifter.sellThroughRate).toBeCloseTo(0.5, 5);
    expect(drifter.totalCreditsEarned).toBe(1000);
  });

  it('includes a per-session timeline with the target flag', async () => {
    seedNote({ agent: 'drifter-gale', title: 'INTEL-SIRIUS-2026-05-12', price: 1000 });

    const res = await request(app).get('/api/survey-monetization?hours=24');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.sessions)).toBe(true);

    const open = (res.body.sessions as Array<{
      agent: string; sessionEnd: string | null; notesPosted: number; meetsTarget: boolean;
    }>).find((s) => s.agent === 'drifter-gale' && s.sessionEnd === null)!;
    expect(open.notesPosted).toBe(1);
    expect(open.meetsTarget).toBe(true);

    const lumenOpen = (res.body.sessions as Array<{
      agent: string; sessionEnd: string | null; meetsTarget: boolean;
    }>).find((s) => s.agent === 'lumen-shoal' && s.sessionEnd === null)!;
    expect(lumenOpen.meetsTarget).toBe(false);
  });

  it('does not double-count drifter-gale prose mentions in __reasoning rows', async () => {
    // Seed a __reasoning row that mentions INTEL-* — this should not boost
    // drifter-gale's notesPosted count.
    const ts = new Date().toISOString();
    getDb()
      .prepare(`
        INSERT INTO proxy_tool_calls (agent, tool_name, args_summary, result_summary, success, created_at, timestamp)
        VALUES (?, '__reasoning', NULL, ?, 1, ?, ?)
      `)
      .run('drifter-gale', 'I will post INTEL-SIRIUS-2026-05-06 next session', ts, ts);

    const res = await request(app).get('/api/survey-monetization');
    const drifter = (res.body.agents as Array<{ agent: string; notesPosted: number }>)
      .find((a) => a.agent === 'drifter-gale')!;
    expect(drifter.notesPosted).toBe(0);
  });

  it('does not count get_notes read results as new note posts', async () => {
    const ts = new Date().toISOString();
    getDb()
      .prepare(`
        INSERT INTO proxy_tool_calls (agent, tool_name, args_summary, result_summary, success, created_at, timestamp)
        VALUES (?, 'spacemolt_social', ?, ?, 1, ?, ?)
      `)
      .run(
        'drifter-gale',
        JSON.stringify({ action: 'get_notes' }),
        JSON.stringify([{ title: 'INTEL-SIRIUS-2026-05-06', price: 1000, sold: true }]),
        ts,
        ts,
      );

    const res = await request(app).get('/api/survey-monetization');
    const drifter = (res.body.agents as Array<{ agent: string; notesPosted: number }>)
      .find((a) => a.agent === 'drifter-gale')!;
    expect(drifter.notesPosted).toBe(0);
    expect(res.body.recent).toEqual([]);
  });
});
