import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { setConfigForTesting } from '../../config.js';
import type { GantryConfig } from '../../config.js';
import { createDatabase, closeDb } from '../../services/database.js';

// Use setConfigForTesting instead of mock.module('../config.js') to avoid
// cross-test contamination with maxConcurrency=1.
const testConfig: GantryConfig = {
  agents: [
    { name: 'drifter-gale' },
    { name: 'sable-thorn' },
  ] as GantryConfig['agents'],
  gameUrl: 'ws://localhost',
  gameApiUrl: 'http://localhost',
  agentDeniedTools: {},
  callLimits: {},
  turnSleepMs: 90,
  staggerDelay: 20,
};

// Do NOT use mock.module for session-metrics or health-scorer — it poisons
// the module registry for downstream tests (mock.module persists per-process).
// Instead, use real in-memory DB. The functions will return empty/null results
// which is fine for testing route shape and connection status.

// Only mock health-scorer since it doesn't use DB but has complex deps
mock.module('../../services/health-scorer.js', () => ({
  getAllHealthScores: () => ({
    'drifter-gale': { overall: 100, latency: 100, errorRate: 100, availability: 100 },
    'sable-thorn': { overall: 100, latency: 100, errorRate: 100, availability: 100 },
  }),
}));

// ── Import after mocks ────────────────────────────────────────────────────────
import { createHealthRouter, getConnectionStatus } from './health-details.js';
import type { BreakerRegistry, CircuitState } from '../../proxy/circuit-breaker.js';

// ── Minimal in-process mock registry — no module mocking required ─────────────
function makeRegistry(entries: Record<string, CircuitState>): BreakerRegistry {
  const map = new Map(
    Object.entries(entries).map(([label, state]) => [
      label,
      { getState: () => state } as unknown as ReturnType<BreakerRegistry['getAll']> extends Map<string, infer B> ? B : never,
    ]),
  );
  return {
    getAll: () => map as any,
    getOrCreate: () => { throw new Error('not implemented'); },
    register: () => {},
    remove: () => {},
    getAggregateStatus: () => { throw new Error('not implemented'); },
    getPerAgentStatus: () => ({}),
  } as unknown as BreakerRegistry;
}

beforeEach(() => {
  setConfigForTesting(testConfig);
  createDatabase(':memory:');
});

afterEach(() => {
  closeDb();
});

function makeApp(breakerEntries: Record<string, CircuitState> = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/health', createHealthRouter(makeRegistry(breakerEntries)));
  return app;
}

// ── Unit tests for getConnectionStatus ────────────────────────────────────────

describe('getConnectionStatus', () => {
  it('returns disconnected when agent has no registry entry', () => {
    const registry = makeRegistry({});
    expect(getConnectionStatus('drifter-gale', registry)).toBe('disconnected');
  });

  it('returns connected for closed circuit', () => {
    const registry = makeRegistry({ 'drifter-gale': 'closed' });
    expect(getConnectionStatus('drifter-gale', registry)).toBe('connected');
  });

  it('returns disconnected for open circuit', () => {
    const registry = makeRegistry({ 'drifter-gale': 'open' });
    expect(getConnectionStatus('drifter-gale', registry)).toBe('disconnected');
  });

  it('returns reconnecting for half-open circuit', () => {
    const registry = makeRegistry({ 'drifter-gale': 'half-open' });
    expect(getConnectionStatus('drifter-gale', registry)).toBe('reconnecting');
  });
});

// ── Route integration tests ───────────────────────────────────────────────────

describe('health-details route', () => {
  // ── /detailed/:agent ─────────────────────────────────────────────────────

  describe('GET /api/health/detailed/:agent', () => {
    it('returns 404 for unknown agent', async () => {
      const app = makeApp();
      const res = await request(app).get('/api/health/detailed/unknown-agent');
      expect(res.status).toBe(404);
    });

    it('returns disconnected when no breaker registered', async () => {
      const app = makeApp({});
      const res = await request(app).get('/api/health/detailed/drifter-gale');
      expect(res.status).toBe(200);
      expect(res.body.connectionStatus).toBe('disconnected');
    });

    it('returns connected when circuit is closed', async () => {
      const app = makeApp({ 'drifter-gale': 'closed' });
      const res = await request(app).get('/api/health/detailed/drifter-gale');
      expect(res.status).toBe(200);
      expect(res.body.connectionStatus).toBe('connected');
    });

    it('returns disconnected when circuit is open', async () => {
      const app = makeApp({ 'drifter-gale': 'open' });
      const res = await request(app).get('/api/health/detailed/drifter-gale');
      expect(res.status).toBe(200);
      expect(res.body.connectionStatus).toBe('disconnected');
    });

    it('returns reconnecting when circuit is half-open', async () => {
      const app = makeApp({ 'drifter-gale': 'half-open' });
      const res = await request(app).get('/api/health/detailed/drifter-gale');
      expect(res.status).toBe(200);
      expect(res.body.connectionStatus).toBe('reconnecting');
    });

    it('returns expected response shape', async () => {
      const app = makeApp({ 'drifter-gale': 'closed' });
      const res = await request(app).get('/api/health/detailed/drifter-gale');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        agent: 'drifter-gale',
        connectionStatus: 'connected',
        latency: expect.objectContaining({ agent: 'drifter-gale' }),
        errorRate: expect.objectContaining({ agent: 'drifter-gale' }),
      });
    });
  });

  // ── /detailed (all agents) ────────────────────────────────────────────────

  describe('GET /api/health/detailed', () => {
    it('returns array of all agents', async () => {
      const app = makeApp();
      const res = await request(app).get('/api/health/detailed');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(2);
    });

    it('derives connection status per-agent from registry', async () => {
      const app = makeApp({ 'drifter-gale': 'closed', 'sable-thorn': 'open' });
      const res = await request(app).get('/api/health/detailed');
      expect(res.status).toBe(200);

      const byName = Object.fromEntries(res.body.map((a: any) => [a.agent, a]));
      expect(byName['drifter-gale'].connectionStatus).toBe('connected');
      expect(byName['sable-thorn'].connectionStatus).toBe('disconnected');
    });

    it('defaults to disconnected for agents with no breaker entry', async () => {
      const app = makeApp({ 'drifter-gale': 'half-open' }); // sable-thorn has no entry
      const res = await request(app).get('/api/health/detailed');

      const byName = Object.fromEntries(res.body.map((a: any) => [a.agent, a]));
      expect(byName['drifter-gale'].connectionStatus).toBe('reconnecting');
      expect(byName['sable-thorn'].connectionStatus).toBe('disconnected');
    });
  });

  // ── /sessions ─────────────────────────────────────────────────────────────

  describe('GET /api/health/sessions', () => {
    let app: express.Express;

    beforeEach(() => { app = makeApp(); });

    it('returns session info for all agents', async () => {
      const res = await request(app).get('/api/health/sessions');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(2);
    });

    it('returns 404 for unknown agent', async () => {
      const res = await request(app).get('/api/health/sessions/bogus');
      expect(res.status).toBe(404);
    });

    it('returns session info for specific agent', async () => {
      const res = await request(app).get('/api/health/sessions/drifter-gale');
      expect(res.status).toBe(200);
      expect(res.body.agent).toBe('drifter-gale');
    });
  });

  // ── /latency ──────────────────────────────────────────────────────────────

  describe('GET /api/health/latency', () => {
    let app: express.Express;

    beforeEach(() => { app = makeApp(); });

    it('returns latency for all agents', async () => {
      const res = await request(app).get('/api/health/latency');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('returns 404 for unknown agent', async () => {
      const res = await request(app).get('/api/health/latency/bogus');
      expect(res.status).toBe(404);
    });

    it('returns latency for specific agent', async () => {
      const res = await request(app).get('/api/health/latency/drifter-gale');
      expect(res.status).toBe(200);
      expect(res.body.agent).toBe('drifter-gale');
    });
  });

  // ── /errors ───────────────────────────────────────────────────────────────

  describe('GET /api/health/errors', () => {
    let app: express.Express;

    beforeEach(() => { app = makeApp(); });

    it('returns error breakdown for all agents', async () => {
      const res = await request(app).get('/api/health/errors');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('returns 404 for unknown agent', async () => {
      const res = await request(app).get('/api/health/errors/bogus');
      expect(res.status).toBe(404);
    });

    it('returns error breakdown for specific agent', async () => {
      const res = await request(app).get('/api/health/errors/drifter-gale');
      expect(res.status).toBe(200);
      expect(res.body.agent).toBe('drifter-gale');
    });
  });
});
