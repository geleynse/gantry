import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import request from 'supertest';
import express from 'express';
import { createDatabase, closeDb, getDb } from '../../services/database.js';
import economyRoutes from '../routes/economy.js';
import { jsonErrorHandler } from './error-handler.js';

// ---------------------------------------------------------------------------
// App with error handler wired up — mirrors production setup
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/economy', economyRoutes);
  // Error handler MUST be last
  app.use(jsonErrorHandler);
  return app;
}

let app: express.Express;

beforeAll(() => {
  createDatabase(':memory:');
  app = makeApp();
});

afterAll(() => {
  closeDb();
});

// ---------------------------------------------------------------------------
// Trigger a real error by inserting a broken DB state then calling /api/economy/pnl
// We replicate the original bug: getPnlSummary with hours filter previously
// threw "SQLite query expected 2 values, received 1". That bug is now fixed,
// so we trigger a different error using a route that explicitly throws.
// ---------------------------------------------------------------------------

describe('jsonErrorHandler', () => {
  it('returns application/json on unhandled route errors', async () => {
    // Temporarily override the DB to force a throw from within a route
    const fakeApp = express();
    fakeApp.use(express.json());
    fakeApp.get('/boom', (_req, _res) => {
      throw new Error('boom at /home/server/src/index.js:86807:6 at handleRequest');
    });
    fakeApp.use(jsonErrorHandler);

    const res = await request(fakeApp).get('/boom');

    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('does not leak file paths, line numbers, or stack traces to the client', async () => {
    const fakeApp = express();
    fakeApp.use(express.json());
    fakeApp.get('/boom', (_req, _res) => {
      const err = new Error('internal detail');
      (err as any).stack = 'Error: internal detail\n    at boom (/home/spacemolt/gantry-server/dist/index.js:86807:6)\n    at Layer.handle';
      throw err;
    });
    fakeApp.use(jsonErrorHandler);

    const res = await request(fakeApp).get('/boom');
    const body = JSON.stringify(res.body);

    // Must not contain file path patterns
    expect(body).not.toMatch(/\/home\//);
    expect(body).not.toMatch(/\/usr\//);
    expect(body).not.toMatch(/\.js:/);
    expect(body).not.toMatch(/\bat\b/);
  });

  it('response body has an error field', async () => {
    const fakeApp = express();
    fakeApp.use(express.json());
    fakeApp.get('/boom', (_req, _res) => {
      throw new Error('something went wrong');
    });
    fakeApp.use(jsonErrorHandler);

    const res = await request(fakeApp).get('/boom');
    expect(typeof res.body.error).toBe('string');
    expect(res.body.error.length).toBeGreaterThan(0);
  });

  it('preserves 4xx status codes set by route handlers', async () => {
    const fakeApp = express();
    fakeApp.use(express.json());
    fakeApp.get('/not-found', (_req, res, next) => {
      const err = Object.assign(new Error('not found'), { status: 404 });
      next(err);
    });
    fakeApp.use(jsonErrorHandler);

    const res = await request(fakeApp).get('/not-found');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('existing JSON error responses from routes are unaffected', async () => {
    // Economy routes return structured JSON errors for bad input via res.status().json()
    // These should pass through the error handler untouched (they never call next(err))
    const res = await request(app).get('/api/economy/actions');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('actions');
  });

  it('pnl endpoint works end-to-end with hours filter (regression: UNION ALL param-count)', async () => {
    const db = getDb();
    const now = new Date();
    const recent = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO agent_action_log (agent, action_type, credits_delta, item, created_at) VALUES (?, ?, ?, ?, ?)`
    ).run('test-agent', 'sell', 1000, 'Iron', recent);

    const res = await request(app).get('/api/economy/pnl?hours=24');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toHaveProperty('agents');
    expect(res.body).toHaveProperty('topRevenue');
    expect(res.body).toHaveProperty('topCosts');
  });
});
