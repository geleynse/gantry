/**
 * Route tests for /api/prayer/*.
 *
 * Seeds proxy_tool_calls (+ subcalls via parent_id) and turns in an in-memory
 * DB, then hits the real express router to verify recent/adoption behavior.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { createDatabase, getDb, closeDb } from '../../services/database.js';
import { setConfigForTesting } from '../../config.js';
import type { GantryConfig } from '../../config.js';
import prayerRoutes from './prayer.js';

const app = express();
app.use(express.json());
app.use('/api/prayer', prayerRoutes);

const testConfig: GantryConfig = {
  agents: [
    { name: 'drifter-gale', backend: 'claude', model: 'sonnet', prayEnabled: true },
    { name: 'sable-thorn', backend: 'claude', model: 'sonnet' },
    { name: 'rust-vane', backend: 'claude', model: 'sonnet', prayEnabled: true },
  ] as GantryConfig['agents'],
  mcpGameUrl: 'http://localhost',
  turnSleepMs: 1000,
  staggerDelay: 0,
  agentDeniedTools: {},
} as unknown as GantryConfig;

// --- Seeding helpers ---------------------------------------------------------

function insertPrayer(opts: {
  agent: string;
  args?: unknown;
  result?: unknown;
  success?: boolean;
  errorCode?: string | null;
  durationMs?: number | null;
  status?: string;
  traceId?: string | null;
  ageMinutes?: number;
}): number {
  const db = getDb();
  const argsJson = opts.args === undefined ? null : JSON.stringify(opts.args);
  const resultJson = opts.result === undefined ? null : JSON.stringify(opts.result);
  const created = `datetime('now', '-${opts.ageMinutes ?? 0} minutes')`;
  const r = db.prepare(`
    INSERT INTO proxy_tool_calls
      (agent, tool_name, args_summary, result_summary, success, error_code,
       duration_ms, is_compound, status, trace_id, timestamp, created_at)
    VALUES (?, 'pray', ?, ?, ?, ?, ?, 1, ?, ?, ${created}, ${created})
  `).run(
    opts.agent,
    argsJson,
    resultJson,
    opts.success === false ? 0 : 1,
    opts.errorCode ?? null,
    opts.durationMs ?? null,
    opts.status ?? 'complete',
    opts.traceId ?? null,
  );
  return Number(r.lastInsertRowid);
}

function insertSubcall(parentId: number, opts: {
  agent: string;
  toolName: string;
  args?: unknown;
  result?: unknown;
  success?: boolean;
  durationMs?: number | null;
}): number {
  const db = getDb();
  const r = getDb().prepare(`
    INSERT INTO proxy_tool_calls
      (agent, tool_name, args_summary, result_summary, success, duration_ms,
       is_compound, status, parent_id)
    VALUES (?, ?, ?, ?, ?, ?, 0, 'complete', ?)
  `).run(
    opts.agent,
    opts.toolName,
    opts.args === undefined ? null : JSON.stringify(opts.args),
    opts.result === undefined ? null : JSON.stringify(opts.result),
    opts.success === false ? 0 : 1,
    opts.durationMs ?? null,
    parentId,
  );
  return Number(r.lastInsertRowid);
}

function insertTurn(agent: string, turnNumber: number, ageMinutes = 0): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO turns (agent, turn_number, started_at, completed_at)
    VALUES (?, ?, datetime('now', '-${ageMinutes} minutes'), datetime('now', '-${ageMinutes} minutes'))
  `).run(agent, turnNumber);
}

// --- Tests -------------------------------------------------------------------

describe('GET /api/prayer/recent', () => {
  beforeEach(() => {
    createDatabase(':memory:');
    setConfigForTesting(testConfig);
  });
  afterEach(() => closeDb());

  it('returns 400 when agent is missing', async () => {
    const res = await request(app).get('/api/prayer/recent');
    expect(res.status).toBe(400);
  });

  it('returns 400 for unknown agent', async () => {
    const res = await request(app).get('/api/prayer/recent?agent=ghost-ship');
    expect(res.status).toBe(400);
  });

  it('returns empty prayers list when the agent has none', async () => {
    const res = await request(app).get('/api/prayer/recent?agent=drifter-gale');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ prayers: [] });
  });

  it('returns recent prayers parsed with subcalls attached', async () => {
    const parentId = insertPrayer({
      agent: 'drifter-gale',
      args: { script: 'dock\nsell all', max_steps: 20, timeout_ticks: 3 },
      result: { status: 'completed', steps_executed: 4, normalized_script: 'dock\nsell all' },
      durationMs: 1200,
      traceId: 'trace-abc',
    });
    insertSubcall(parentId, {
      agent: 'drifter-gale',
      toolName: 'spacemolt_market',
      args: { action: 'sell_all' },
      result: { ok: true, credits: 100 },
      durationMs: 150,
    });
    insertSubcall(parentId, {
      agent: 'drifter-gale',
      toolName: 'spacemolt_nav',
      args: { action: 'dock' },
      result: { ok: true },
      durationMs: 90,
    });

    const res = await request(app).get('/api/prayer/recent?agent=drifter-gale&limit=5');
    expect(res.status).toBe(200);
    const body = res.body as {
      prayers: Array<{
        id: number;
        status: string;
        success: boolean;
        script: string | null;
        stepsExecuted: number | null;
        subcallCount: number;
        subcalls: Array<{ toolName: string; success: boolean }>;
      }>;
    };
    expect(body.prayers.length).toBe(1);
    const p = body.prayers[0];
    expect(p.id).toBe(parentId);
    expect(p.status).toBe('completed');
    expect(p.success).toBe(true);
    expect(p.script).toBe('dock\nsell all');
    expect(p.stepsExecuted).toBe(4);
    expect(p.subcallCount).toBe(2);
    const toolNames = p.subcalls.map((s) => s.toolName).sort();
    expect(toolNames).toEqual(['spacemolt_market', 'spacemolt_nav']);
  });

  it('marks pending prayers with status=pending regardless of result payload', async () => {
    insertPrayer({
      agent: 'drifter-gale',
      args: { script: 'mine' },
      result: null,
      status: 'pending',
      durationMs: null,
    });

    const res = await request(app).get('/api/prayer/recent?agent=drifter-gale');
    expect(res.status).toBe(200);
    const body = res.body as { prayers: Array<{ status: string; success: boolean }> };
    expect(body.prayers[0].status).toBe('pending');
  });

  it('surfaces error tier + code on failed prayers', async () => {
    insertPrayer({
      agent: 'drifter-gale',
      args: { script: 'oops' },
      result: {
        status: 'error',
        error: {
          tier: 'parse',
          code: 'unexpected_token',
          message: 'Parse error at line 1',
          line: 1,
          col: 5,
          suggestions: ['Try a valid verb like mine'],
        },
      },
      success: false,
      errorCode: 'unexpected_token',
    });

    const res = await request(app).get('/api/prayer/recent?agent=drifter-gale');
    const body = res.body as {
      prayers: Array<{
        errorTier: string | null;
        errorCode: string | null;
        errorLine: number | null;
        suggestions: string[] | null;
      }>;
    };
    expect(body.prayers[0].errorTier).toBe('parse');
    expect(body.prayers[0].errorCode).toBe('unexpected_token');
    expect(body.prayers[0].errorLine).toBe(1);
    expect(body.prayers[0].suggestions).toEqual(['Try a valid verb like mine']);
  });

  it('orders newest first and respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      insertPrayer({ agent: 'drifter-gale', args: { script: `p${i}` }, result: { status: 'completed', steps_executed: i } });
    }
    const res = await request(app).get('/api/prayer/recent?agent=drifter-gale&limit=3');
    const body = res.body as { prayers: Array<{ id: number }> };
    expect(body.prayers.length).toBe(3);
    // Newest first ⇒ ids strictly decreasing.
    for (let i = 1; i < body.prayers.length; i++) {
      expect(body.prayers[i - 1].id).toBeGreaterThan(body.prayers[i].id);
    }
  });

  it('does not leak prayers from other agents', async () => {
    insertPrayer({ agent: 'drifter-gale', args: { script: 'a' }, result: { status: 'completed' } });
    insertPrayer({ agent: 'sable-thorn', args: { script: 'b' }, result: { status: 'completed' } });

    const res = await request(app).get('/api/prayer/recent?agent=drifter-gale');
    const body = res.body as { prayers: Array<{ agent: string }> };
    expect(body.prayers.length).toBe(1);
    expect(body.prayers[0].agent).toBe('drifter-gale');
  });
});

describe('GET /api/prayer/adoption', () => {
  beforeEach(() => {
    createDatabase(':memory:');
    setConfigForTesting(testConfig);
  });
  afterEach(() => closeDb());

  it('returns a row for every configured agent (even with zero prayers)', async () => {
    const res = await request(app).get('/api/prayer/adoption');
    expect(res.status).toBe(200);
    const body = res.body as {
      hours: number;
      adoption: Array<{ agent: string; prayerCount: number; turnCount: number; prayEnabled: boolean }>;
    };
    expect(body.hours).toBe(24);
    const byName = new Map(body.adoption.map((r) => [r.agent, r]));
    expect(byName.get('drifter-gale')?.prayEnabled).toBe(true);
    expect(byName.get('sable-thorn')?.prayEnabled).toBe(false);
    expect(byName.get('rust-vane')?.prayEnabled).toBe(true);
    for (const row of body.adoption) {
      expect(row.prayerCount).toBe(0);
      expect(row.turnCount).toBe(0);
    }
  });

  it('computes adoption ratio, success rate, and avg steps', async () => {
    // drifter-gale: 10 turns, 3 prayers (2 completed, 1 error), avg steps 4
    for (let i = 0; i < 10; i++) insertTurn('drifter-gale', i + 1, i);
    insertPrayer({ agent: 'drifter-gale', result: { status: 'completed', steps_executed: 2 } });
    insertPrayer({ agent: 'drifter-gale', result: { status: 'completed', steps_executed: 6 } });
    insertPrayer({ agent: 'drifter-gale', result: { status: 'error' }, success: false, errorCode: 'runtime' });

    const res = await request(app).get('/api/prayer/adoption?hours=24');
    const body = res.body as {
      adoption: Array<{
        agent: string;
        prayerCount: number;
        turnCount: number;
        adoptionRatio: number;
        successRate: number | null;
        avgStepsExecuted: number | null;
        completedCount: number;
        errorCount: number;
        lastPrayerAt: string | null;
      }>;
    };
    const row = body.adoption.find((r) => r.agent === 'drifter-gale')!;
    expect(row.prayerCount).toBe(3);
    expect(row.turnCount).toBe(10);
    expect(row.adoptionRatio).toBeCloseTo(0.3, 5);
    expect(row.completedCount).toBe(2);
    expect(row.errorCount).toBe(1);
    expect(row.successRate).toBeCloseTo(2 / 3, 5);
    // avg of (2, 6) — error row has no steps_executed value, so null contribution.
    // SQLite AVG ignores nulls.
    expect(row.avgStepsExecuted).toBeCloseTo(4, 5);
    expect(row.lastPrayerAt).toBeTruthy();
  });

  it('caps adoptionRatio at 1 for display sanity', async () => {
    insertTurn('drifter-gale', 1, 0);
    // Many prayers in a single turn — ratio would be > 1 without cap.
    for (let i = 0; i < 5; i++) {
      insertPrayer({ agent: 'drifter-gale', result: { status: 'completed' } });
    }

    const res = await request(app).get('/api/prayer/adoption');
    const body = res.body as { adoption: Array<{ agent: string; adoptionRatio: number }> };
    const row = body.adoption.find((r) => r.agent === 'drifter-gale')!;
    expect(row.adoptionRatio).toBe(1);
  });

  it('respects the hours window — older prayers excluded', async () => {
    // 48 hours ago (outside a 24h window), 1 hour ago (inside).
    insertPrayer({ agent: 'drifter-gale', result: { status: 'completed' }, ageMinutes: 48 * 60 });
    insertPrayer({ agent: 'drifter-gale', result: { status: 'completed' }, ageMinutes: 60 });

    const res = await request(app).get('/api/prayer/adoption?hours=24');
    const body = res.body as { adoption: Array<{ agent: string; prayerCount: number }> };
    const row = body.adoption.find((r) => r.agent === 'drifter-gale')!;
    expect(row.prayerCount).toBe(1);
  });

  it('sorts by prayer count desc', async () => {
    // rust-vane 2 prayers, drifter-gale 1 prayer, sable-thorn 0
    insertPrayer({ agent: 'rust-vane', result: { status: 'completed' } });
    insertPrayer({ agent: 'rust-vane', result: { status: 'completed' } });
    insertPrayer({ agent: 'drifter-gale', result: { status: 'completed' } });

    const res = await request(app).get('/api/prayer/adoption');
    const body = res.body as { adoption: Array<{ agent: string; prayerCount: number }> };
    // First two entries should be rust-vane (2) then drifter-gale (1), in that order.
    expect(body.adoption[0].agent).toBe('rust-vane');
    expect(body.adoption[0].prayerCount).toBe(2);
    expect(body.adoption[1].agent).toBe('drifter-gale');
    expect(body.adoption[1].prayerCount).toBe(1);
  });

  it('includes unknown/orphaned agents that have prayer rows', async () => {
    insertPrayer({ agent: 'legacy-ship', result: { status: 'completed' } });
    const res = await request(app).get('/api/prayer/adoption');
    const body = res.body as {
      adoption: Array<{ agent: string; prayEnabled: boolean; prayerCount: number }>;
    };
    const legacy = body.adoption.find((r) => r.agent === 'legacy-ship');
    expect(legacy).toBeDefined();
    expect(legacy?.prayEnabled).toBe(false);
    expect(legacy?.prayerCount).toBe(1);
  });
});

describe('GET /api/prayer/by-id/:id', () => {
  beforeEach(() => {
    createDatabase(':memory:');
    setConfigForTesting(testConfig);
  });
  afterEach(() => closeDb());

  it('returns 404 for missing id', async () => {
    const res = await request(app).get('/api/prayer/by-id/99999');
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid id', async () => {
    const res = await request(app).get('/api/prayer/by-id/abc');
    expect(res.status).toBe(400);
  });

  it('returns a single prayer with subcalls', async () => {
    const id = insertPrayer({
      agent: 'drifter-gale',
      args: { script: 'mine' },
      result: { status: 'completed', steps_executed: 1 },
    });
    insertSubcall(id, { agent: 'drifter-gale', toolName: 'spacemolt', result: { ok: true } });

    const res = await request(app).get(`/api/prayer/by-id/${id}`);
    expect(res.status).toBe(200);
    const body = res.body as { prayer: { id: number; subcallCount: number } };
    expect(body.prayer.id).toBe(id);
    expect(body.prayer.subcallCount).toBe(1);
  });
});
