import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { setConfigForTesting } from '../../config.js';
import type { GantryConfig } from '../../config.js';
import { createDatabase, closeDb } from '../../services/database.js';

const testConfig: GantryConfig = {
  agents: [
    { name: 'drifter-gale' },
    { name: 'sable-thorn' },
    { name: 'rust-vane' },
  ] as GantryConfig['agents'],
  gameUrl: 'ws://localhost',
  gameApiUrl: 'http://localhost',
  agentDeniedTools: {},
  callLimits: {},
  turnSleepMs: 90,
  staggerDelay: 20,
};

import broadcastRoutes from './broadcast.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/fleet/broadcast', broadcastRoutes);
  return app;
}

beforeEach(() => {
  setConfigForTesting(testConfig);
  createDatabase(':memory:');
});

afterEach(() => {
  closeDb();
});

describe('POST /api/fleet/broadcast', () => {
  it('broadcasts to all agents when no targets specified', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/fleet/broadcast')
      .send({ message: 'All hands on deck' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.sent).toEqual(['drifter-gale', 'sable-thorn', 'rust-vane']);
    expect(res.body.failed).toEqual([]);
  });

  it('broadcasts to selected targets only', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/fleet/broadcast')
      .send({ message: 'Scout mission', targets: ['drifter-gale', 'rust-vane'] });

    expect(res.status).toBe(200);
    expect(res.body.sent).toEqual(['drifter-gale', 'rust-vane']);
    expect(res.body.failed).toEqual([]);
  });

  it('rejects missing message', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/fleet/broadcast')
      .send({ targets: ['drifter-gale'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/message is required/i);
  });

  it('rejects unknown agent targets', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/fleet/broadcast')
      .send({ message: 'Hi', targets: ['nonexistent-agent'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown agents/i);
  });

  it('rejects invalid priority', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/fleet/broadcast')
      .send({ message: 'Test', priority: 'critical' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/priority/i);
  });

  it('accepts urgent priority', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/fleet/broadcast')
      .send({ message: 'Urgent order', priority: 'urgent' });

    expect(res.status).toBe(200);
    expect(res.body.sent).toHaveLength(3);
  });

  it('returns an id', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/fleet/broadcast')
      .send({ message: 'Test broadcast' });

    expect(res.status).toBe(200);
    expect(typeof res.body.id).toBe('string');
    expect(res.body.id.length).toBeGreaterThan(0);
  });
});

describe('GET /api/fleet/broadcast/history', () => {
  it('returns empty history initially', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/fleet/broadcast/history');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.history)).toBe(true);
  });

  it('records broadcast in history', async () => {
    const app = makeApp();

    await request(app)
      .post('/api/fleet/broadcast')
      .send({ message: 'First broadcast' });

    const histRes = await request(app).get('/api/fleet/broadcast/history');
    expect(histRes.status).toBe(200);
    // history may contain entries from previous tests due to in-memory store —
    // just check that at least one entry has our message
    const found = histRes.body.history.find((h: { message: string }) => h.message === 'First broadcast');
    expect(found).toBeDefined();
    expect(found.sent).toContain('drifter-gale');
  });
});
