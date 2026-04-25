import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { setConfigForTesting } from '../../config.js';
import type { GantryConfig } from '../../config.js';
import { createDatabase, closeDb, queryAll } from '../../services/database.js';
import facilitiesScanRoutes from './facilities-scan.js';

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

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/facilities-scan', facilitiesScanRoutes);
  return app;
}

beforeEach(() => {
  setConfigForTesting(testConfig);
  createDatabase(':memory:');
});

afterEach(() => {
  closeDb();
});

describe('POST /api/facilities-scan', () => {
  it('queues a fleet-wide order when no agent is provided', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/facilities-scan').send({});

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.orderId).toBe('number');
    expect(res.body.target).toBeNull();

    const orders = queryAll<{ target_agent: string | null; priority: string; message: string }>(
      `SELECT target_agent, priority, message FROM fleet_orders`
    );
    expect(orders.length).toBe(1);
    expect(orders[0].target_agent).toBeNull();
    expect(orders[0].priority).toBe('high');
    expect(orders[0].message).toContain('list_facilities');
  });

  it('queues an agent-targeted order when agent is provided', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/facilities-scan')
      .send({ agent: 'sable-thorn' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.target).toBe('sable-thorn');

    const orders = queryAll<{ target_agent: string | null }>(
      `SELECT target_agent FROM fleet_orders`
    );
    expect(orders.length).toBe(1);
    expect(orders[0].target_agent).toBe('sable-thorn');
  });

  it('rejects unknown agent names', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/facilities-scan')
      .send({ agent: 'nope-bot' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/unknown agent/i);
  });

  it('rejects non-string agent values', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/facilities-scan')
      .send({ agent: 42 });

    expect(res.status).toBe(400);
  });

  it('treats null/empty agent as fleet-wide', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/facilities-scan')
      .send({ agent: null });

    expect(res.status).toBe(200);
    expect(res.body.target).toBeNull();
  });
});
