import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { setConfigForTesting } from '../../config.js';
import type { GantryConfig } from '../../config.js';
import { createDatabase, closeDb } from '../../services/database.js';

// Use setConfigForTesting instead of mock.module('../config.js') to avoid
// cross-test contamination. mock.module() persists for the entire worker
// process with maxConcurrency=1 (CI), breaking subsequent tests that import config.

const testConfig: GantryConfig = {
  agents: [
    { name: 'drifter-gale' },
    { name: 'sable-thorn' },
  ] as GantryConfig['agents'],
  gameUrl: 'ws://localhost',
  gameApiUrl: 'http://localhost',
  gameMcpUrl: 'http://localhost',
  agentDeniedTools: {},
  callLimits: {},
  turnSleepMs: 90,
  staggerDelay: 20,
};

// comms-db uses real in-memory DB — read back with listOrders() for assertions

// Only mock routine-runner (no real routines available in test).
// Do NOT mock comms-db — use real in-memory DB instead to avoid poisoning
// the module registry for downstream tests (mock.module persists per-process).
mock.module('../../routines/routine-runner.js', () => ({
  getAvailableRoutines: () => ['sell_cycle', 'mining_loop', 'refuel_repair'],
  hasRoutine: (name: string) => ['sell_cycle', 'mining_loop', 'refuel_repair'].includes(name),
}));

// Stub out the online-check middleware so existing tests aren't blocked by the
// agent-offline gate. Tests for the middleware itself live in agent-online.test.ts.
mock.module('../../services/agent-queries.js', () => ({
  hasActiveProxySession: (_name: string) => true,
}));

mock.module('../../services/process-manager.js', () => ({
  hasSession: async (_name: string) => true,
}));

import { agentFleetControlRouter, routinesRouter } from './fleet-control.js';
import { listOrders } from '../../services/comms-db.js';
import { clearRoutineJobsForTesting, completeRoutineJob, createRoutineJob, failRoutineJob } from '../../services/routine-jobs.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/agents', agentFleetControlRouter);
  app.use('/api/routines', routinesRouter);
  return app;
}

beforeEach(() => {
  setConfigForTesting(testConfig);
  createDatabase(':memory:');
  clearRoutineJobsForTesting();
});

afterEach(() => {
  closeDb();
});

// ---------------------------------------------------------------------------
// POST /api/agents/:name/order
// ---------------------------------------------------------------------------

describe('POST /api/agents/:name/order', () => {
  it('creates an order for a valid agent', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/agents/drifter-gale/order')
      .send({ message: 'Mine iron in SOL-001' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.id).toBe('number');
  });

  it('returns 404 for unknown agent', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/agents/ghost-agent/order')
      .send({ message: 'Do something' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBeTruthy();
  });

  it('returns 400 when message is missing', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/agents/drifter-gale/order')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/message/);
  });

  it('accepts urgent priority', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/agents/sable-thorn/order')
      .send({ message: 'Urgent order', priority: 'urgent' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('accepts normal priority', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/agents/drifter-gale/order')
      .send({ message: 'Normal order', priority: 'normal' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 400 for invalid priority', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/agents/drifter-gale/order')
      .send({ message: 'Bad priority', priority: 'superurgent' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/priority/);
  });
});

// ---------------------------------------------------------------------------
// POST /api/agents/:name/routine
// ---------------------------------------------------------------------------

describe('POST /api/agents/:name/routine', () => {
  it('triggers a valid routine', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/agents/drifter-gale/routine')
      .send({ routine: 'sell_cycle' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.id).toBe('number');
  });

  it('returns 404 for unknown agent', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/agents/ghost-agent/routine')
      .send({ routine: 'sell_cycle' });
    expect(res.status).toBe(404);
  });

  it('returns 400 for missing routine name', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/agents/drifter-gale/routine')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/routine/);
  });

  it('returns 400 for unknown routine', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/agents/drifter-gale/routine')
      .send({ routine: 'super_secret_routine' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown routine/);
    expect(Array.isArray(res.body.available)).toBe(true);
  });

  it('formats the order message with [OPERATOR] prefix', async () => {
    const app = makeApp();
    await request(app)
      .post('/api/agents/drifter-gale/routine')
      .send({ routine: 'mining_loop' });
    const orders = listOrders();
    const last = orders[orders.length - 1];
    expect(last.message).toContain('[OPERATOR] Execute routine: mining_loop');
  });

  it('includes params in the order message when provided', async () => {
    const app = makeApp();
    await request(app)
      .post('/api/agents/drifter-gale/routine')
      .send({ routine: 'mining_loop', params: { target: 'SOL-001' } });
    const orders = listOrders();
    const last = orders[orders.length - 1];
    expect(last.message).toContain('"target":"SOL-001"');
  });

  it('sends routine orders with urgent priority', async () => {
    const app = makeApp();
    await request(app)
      .post('/api/agents/sable-thorn/routine')
      .send({ routine: 'refuel_repair' });
    const orders = listOrders();
    const last = orders[orders.length - 1];
    expect(last.priority).toBe('urgent');
    expect(last.target_agent).toBe('sable-thorn');
  });
});

// ---------------------------------------------------------------------------
// GET /api/routines
// ---------------------------------------------------------------------------

describe('GET /api/routines', () => {
  it('returns available routines list', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/routines');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.routines)).toBe(true);
  });

  it('includes expected routine names', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/routines');
    expect(res.body.routines).toContain('sell_cycle');
    expect(res.body.routines).toContain('mining_loop');
  });

  it('returns at least one routine', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/routines');
    expect(res.body.routines.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/routines/jobs
// ---------------------------------------------------------------------------

describe('GET /api/routines/jobs', () => {
  it('returns recent routine jobs newest first', async () => {
    const app = makeApp();
    const older = createRoutineJob({ agentName: 'drifter-gale', routineId: 'sell_cycle', traceId: 'trace-1' });
    completeRoutineJob(older, { status: 'completed', summary: 'sold cargo', data: {}, phases: [], durationMs: 0 }, 'sold cargo', 1200);
    const newer = createRoutineJob({ agentName: 'sable-thorn', routineId: 'mining_loop', traceId: 'trace-2' });

    const res = await request(app).get('/api/routines/jobs');

    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(2);
    expect(res.body.jobs[0].id).toBe(newer.id);
    expect(res.body.jobs[0].status).toBe('running');
    expect(res.body.jobs[1].id).toBe(older.id);
    expect(res.body.jobs[1].result.summary).toBe('sold cargo');
  });

  it('filters routine jobs by agent and status', async () => {
    const app = makeApp();
    const running = createRoutineJob({ agentName: 'drifter-gale', routineId: 'sell_cycle', traceId: 'trace-1' });
    const failed = createRoutineJob({ agentName: 'drifter-gale', routineId: 'mining_loop', traceId: 'trace-2' });
    failRoutineJob(failed, 'boom', 2500);
    createRoutineJob({ agentName: 'sable-thorn', routineId: 'refuel_repair', traceId: 'trace-3' });

    const res = await request(app).get('/api/routines/jobs?agent=drifter-gale&status=running');

    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(1);
    expect(res.body.jobs[0].id).toBe(running.id);
  });

  it('returns one routine job by id', async () => {
    const app = makeApp();
    const job = createRoutineJob({ agentName: 'drifter-gale', routineId: 'sell_cycle', traceId: 'trace-1' });

    const res = await request(app).get(`/api/routines/jobs/${job.id}`);

    expect(res.status).toBe(200);
    expect(res.body.job.id).toBe(job.id);
    expect(res.body.job.agent).toBe('drifter-gale');
  });

  it('rejects invalid job status filters', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/routines/jobs?status=stale');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/status/);
  });
});
