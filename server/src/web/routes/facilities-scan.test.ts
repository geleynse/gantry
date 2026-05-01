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
    expect(res.body.tab).toBeNull();

    const orders = queryAll<{ target_agent: string | null; priority: string; message: string }>(
      `SELECT target_agent, priority, message FROM fleet_orders`
    );
    expect(orders.length).toBe(1);
    expect(orders[0].target_agent).toBeNull();
    expect(orders[0].priority).toBe('high');
    // No tab: fires all four canonical actions
    expect(orders[0].message).toContain('spacemolt_facility(action="faction_list")');
    expect(orders[0].message).toContain('spacemolt_facility(action="types")');
    expect(orders[0].message).toContain('spacemolt_facility(action="personal_build")');
    expect(orders[0].message).toContain('spacemolt_facility(action="faction_build")');
    // Should NOT contain the bogus list_facilities action that the old code emitted
    expect(orders[0].message).not.toContain('list_facilities');
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

  // -------------------------------------------------------------------------
  // Tab parameter: dispatches the right action(s) for each tab
  // -------------------------------------------------------------------------

  describe('tab parameter', () => {
    it('build tab dispatches types + personal_build + faction_build', async () => {
      const app = makeApp();
      const res = await request(app)
        .post('/api/facilities-scan')
        .send({ tab: 'build' });

      expect(res.status).toBe(200);
      expect(res.body.tab).toBe('build');
      expect(res.body.actions).toEqual(['types', 'personal_build', 'faction_build']);

      const [order] = queryAll<{ message: string }>(`SELECT message FROM fleet_orders`);
      expect(order.message).toContain('spacemolt_facility(action="types")');
      expect(order.message).toContain('spacemolt_facility(action="personal_build")');
      expect(order.message).toContain('spacemolt_facility(action="faction_build")');
      // build tab does NOT include faction_list
      expect(order.message).not.toContain('spacemolt_facility(action="faction_list")');
    });

    it('faction tab dispatches faction_list + faction_build', async () => {
      const app = makeApp();
      const res = await request(app)
        .post('/api/facilities-scan')
        .send({ tab: 'faction' });

      expect(res.status).toBe(200);
      expect(res.body.tab).toBe('faction');
      expect(res.body.actions).toEqual(['faction_list', 'faction_build']);

      const [order] = queryAll<{ message: string }>(`SELECT message FROM fleet_orders`);
      expect(order.message).toContain('spacemolt_facility(action="faction_list")');
      expect(order.message).toContain('spacemolt_facility(action="faction_build")');
      expect(order.message).not.toContain('spacemolt_facility(action="types")');
      expect(order.message).not.toContain('spacemolt_facility(action="personal_build")');
    });

    it('owned tab dispatches faction_list + personal_build', async () => {
      const app = makeApp();
      const res = await request(app)
        .post('/api/facilities-scan')
        .send({ tab: 'owned' });

      expect(res.status).toBe(200);
      expect(res.body.tab).toBe('owned');
      expect(res.body.actions).toEqual(['faction_list', 'personal_build']);

      const [order] = queryAll<{ message: string }>(`SELECT message FROM fleet_orders`);
      expect(order.message).toContain('spacemolt_facility(action="faction_list")');
      expect(order.message).toContain('spacemolt_facility(action="personal_build")');
    });

    it('station tab dispatches faction_list + personal_build', async () => {
      const app = makeApp();
      const res = await request(app)
        .post('/api/facilities-scan')
        .send({ tab: 'station' });

      expect(res.status).toBe(200);
      expect(res.body.tab).toBe('station');
      expect(res.body.actions).toEqual(['faction_list', 'personal_build']);
    });

    it('combines agent and tab parameters', async () => {
      const app = makeApp();
      const res = await request(app)
        .post('/api/facilities-scan')
        .send({ agent: 'drifter-gale', tab: 'build' });

      expect(res.status).toBe(200);
      expect(res.body.target).toBe('drifter-gale');
      expect(res.body.tab).toBe('build');

      const [order] = queryAll<{ target_agent: string; message: string }>(
        `SELECT target_agent, message FROM fleet_orders`
      );
      expect(order.target_agent).toBe('drifter-gale');
      expect(order.message).toContain('spacemolt_facility(action="types")');
    });

    it('rejects unknown tab values', async () => {
      const app = makeApp();
      const res = await request(app)
        .post('/api/facilities-scan')
        .send({ tab: 'wat' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/tab must be one of/i);
    });

    it('rejects non-string tab values', async () => {
      const app = makeApp();
      const res = await request(app)
        .post('/api/facilities-scan')
        .send({ tab: 42 });

      expect(res.status).toBe(400);
    });

    it('treats null/empty tab as all-actions (default)', async () => {
      const app = makeApp();
      const res = await request(app)
        .post('/api/facilities-scan')
        .send({ tab: null });

      expect(res.status).toBe(200);
      expect(res.body.tab).toBeNull();
      expect(res.body.actions).toEqual([
        'faction_list',
        'types',
        'personal_build',
        'faction_build',
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // The user-facing message must instruct the agent to call REAL actions.
  // The old code told agents to call spacemolt(action="list_facilities"),
  // which is invalid; this regression-tests against that.
  // -------------------------------------------------------------------------

  it('never instructs agents to call the bogus list_facilities action', async () => {
    const app = makeApp();
    for (const tab of [undefined, 'station', 'owned', 'build', 'faction']) {
      await request(app).post('/api/facilities-scan').send(tab ? { tab } : {});
    }
    const orders = queryAll<{ message: string }>(`SELECT message FROM fleet_orders`);
    expect(orders.length).toBe(5);
    for (const order of orders) {
      expect(order.message).not.toContain('list_facilities');
      expect(order.message).toContain('spacemolt_facility(');
    }
  });
});
