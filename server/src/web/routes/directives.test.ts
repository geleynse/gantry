import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { createDatabase, closeDb } from '../../services/database.js';
import { setConfigForTesting } from '../../config.js';
import type { GantryConfig } from '../../config.js';

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
  agentDeniedTools: {},
  callLimits: {},
  turnSleepMs: 90,
  staggerDelay: 20,
};

// Mock nudge-integration since it may not be initialized
mock.module('../../proxy/nudge-integration.js', () => ({
  getAgentNudgeState: () => null,
}));

// Mock rate limiter to be a no-op in tests
mock.module('../middleware/rate-limit.js', () => ({
  agentControlLimiter: (_req: any, _res: any, next: any) => next(),
  generalPostLimiter: (_req: any, _res: any, next: any) => next(),
  sessionLimiter: (_req: any, _res: any, next: any) => next(),
}));

import directivesRouter from './directives.js';

const app = express();
app.use(express.json());
app.use('/api/agents', directivesRouter);

describe('directives routes', () => {
  beforeEach(() => {
    createDatabase(':memory:');
    setConfigForTesting(testConfig);
  });

  afterEach(() => {
    closeDb();
  });

  describe('GET /api/agents/:name/directives', () => {
    it('returns empty directives for known agent', async () => {
      const res = await request(app).get('/api/agents/drifter-gale/directives');
      expect(res.status).toBe(200);
      expect(res.body.directives).toEqual([]);
      expect(res.body).toHaveProperty('nudgeState');
    });

    it('returns 404 for unknown agent', async () => {
      const res = await request(app).get('/api/agents/unknown-agent/directives');
      expect(res.status).toBe(404);
    });

    it('returns active directives', async () => {
      await request(app)
        .post('/api/agents/drifter-gale/directives')
        .send({ text: 'Stay in Sol', priority: 'high' });

      const res = await request(app).get('/api/agents/drifter-gale/directives');
      expect(res.status).toBe(200);
      expect(res.body.directives).toHaveLength(1);
      expect(res.body.directives[0].directive).toBe('Stay in Sol');
      expect(res.body.directives[0].priority).toBe('high');
    });
  });

  describe('POST /api/agents/:name/directives', () => {
    it('adds a directive and returns id', async () => {
      const res = await request(app)
        .post('/api/agents/drifter-gale/directives')
        .send({ text: 'Mine crystal ore', priority: 'normal' });

      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
      expect(typeof res.body.id).toBe('number');
    });

    it('returns 400 for missing text', async () => {
      const res = await request(app)
        .post('/api/agents/drifter-gale/directives')
        .send({ priority: 'normal' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation_error');
    });

    it('returns 400 for empty text', async () => {
      const res = await request(app)
        .post('/api/agents/drifter-gale/directives')
        .send({ text: '   ' });
      expect(res.status).toBe(400);
    });

    it('defaults priority to normal', async () => {
      await request(app)
        .post('/api/agents/drifter-gale/directives')
        .send({ text: 'Test directive' });

      const list = await request(app).get('/api/agents/drifter-gale/directives');
      expect(list.body.directives[0].priority).toBe('normal');
    });

    it('accepts expires_in_minutes', async () => {
      const res = await request(app)
        .post('/api/agents/drifter-gale/directives')
        .send({ text: 'Temp directive', expires_in_minutes: 30 });
      expect(res.status).toBe(201);

      const list = await request(app).get('/api/agents/drifter-gale/directives');
      expect(list.body.directives[0].expires_at).not.toBeNull();
    });

    it('returns 404 for unknown agent', async () => {
      const res = await request(app)
        .post('/api/agents/unknown/directives')
        .send({ text: 'Test' });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/agents/:name/directives/:id', () => {
    it('deactivates a directive', async () => {
      const post = await request(app)
        .post('/api/agents/drifter-gale/directives')
        .send({ text: 'To be deleted' });
      const id = post.body.id;

      const del = await request(app).delete(`/api/agents/drifter-gale/directives/${id}`);
      expect(del.status).toBe(200);
      expect(del.body.ok).toBe(true);

      const list = await request(app).get('/api/agents/drifter-gale/directives');
      expect(list.body.directives).toHaveLength(0);
    });

    it('returns 404 for non-existent id', async () => {
      const res = await request(app).delete('/api/agents/drifter-gale/directives/99999');
      expect(res.status).toBe(404);
    });

    it('returns 400 for invalid id', async () => {
      const res = await request(app).delete('/api/agents/drifter-gale/directives/notanumber');
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/agents/:name/nudge', () => {
    it('sends a nudge message', async () => {
      const res = await request(app)
        .post('/api/agents/drifter-gale/nudge')
        .send({ message: 'Refuel now' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('returns 400 for missing message', async () => {
      const res = await request(app)
        .post('/api/agents/drifter-gale/nudge')
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation_error');
    });

    it('returns 404 for unknown agent', async () => {
      const res = await request(app)
        .post('/api/agents/unknown/nudge')
        .send({ message: 'Test' });
      expect(res.status).toBe(404);
    });
  });
});
