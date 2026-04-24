/**
 * Tests for POST /api/agents/:name/order with type: "stop_after_turn"
 */
import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { setConfigForTesting } from '../../config.js';
import type { GantryConfig } from '../../config.js';
import { createDatabase, closeDb } from '../../services/database.js';

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

const mockRequestStopAfterTurn = mock(() => 'stop_after_turn' as const);

mock.module('../../proxy/session-shutdown.js', () => ({
  getSessionShutdownManager: () => ({
    requestStopAfterTurn: mockRequestStopAfterTurn,
  }),
}));

// Do NOT mock comms-db — use real in-memory DB to avoid poisoning
// the module registry for downstream tests (mock.module persists per-process).
mock.module('../../routines/routine-runner.js', () => ({
  getAvailableRoutines: () => ['sell_cycle'],
}));

// Stub out the online-check middleware so tests aren't blocked by the
// agent-offline gate (matches fleet-control.test.ts pattern).
mock.module('../../services/agent-queries.js', () => ({
  hasActiveProxySession: (_name: string) => true,
}));

mock.module('../../services/process-manager.js', () => ({
  hasSession: async (_name: string) => true,
}));

import { agentFleetControlRouter } from './fleet-control.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/agents', agentFleetControlRouter);
  return app;
}

beforeEach(() => {
  setConfigForTesting(testConfig);
  createDatabase(':memory:');
  mockRequestStopAfterTurn.mockClear();
});

afterEach(() => {
  closeDb();
});

describe('POST /api/agents/:name/order with type: stop_after_turn', () => {
  it('accepts { type: "stop_after_turn" } without requiring message', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/agents/drifter-gale/order')
      .send({ type: 'stop_after_turn' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.state).toBe('stop_after_turn');
  });

  it('calls requestStopAfterTurn on the shutdown manager', async () => {
    const app = makeApp();
    await request(app)
      .post('/api/agents/drifter-gale/order')
      .send({ type: 'stop_after_turn' });
    expect(mockRequestStopAfterTurn).toHaveBeenCalledTimes(1);
    expect(mockRequestStopAfterTurn).toHaveBeenCalledWith('drifter-gale', 'Order: stop_after_turn');
  });

  it('returns 404 for unknown agent even with stop_after_turn type', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/agents/ghost-agent/order')
      .send({ type: 'stop_after_turn' });
    expect(res.status).toBe(404);
    expect(mockRequestStopAfterTurn).not.toHaveBeenCalled();
  });

  it('normal message orders still work alongside the new type', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/agents/sable-thorn/order')
      .send({ message: 'Mine iron in SOL-001' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.id).toBeDefined();
    expect(mockRequestStopAfterTurn).not.toHaveBeenCalled();
  });

  it('returns 400 if neither message nor known type is provided', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/agents/drifter-gale/order')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/message/);
  });
});
