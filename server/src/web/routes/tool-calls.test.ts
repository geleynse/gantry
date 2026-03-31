import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { createDatabase, getDb, closeDb } from '../../services/database.js';

// Import route module
import toolCallsRoutes from './tool-calls.js';

const app = express();
app.use(express.json());
app.use('/api/tool-calls', toolCallsRoutes);

describe('tool-calls route', () => {
  beforeEach(() => {
    createDatabase(':memory:');
  });

  afterEach(() => {
    closeDb();
  });

  describe('POST /', () => {
    it('inserts a single tool call and returns id', async () => {
      const res = await request(app)
        .post('/api/tool-calls')
        .send({
          agent: 'drifter-gale',
          tool_name: 'mine',
          args_summary: '{}',
          result_summary: '{"ore": 5}',
          success: true,
          duration_ms: 150,
        });
      expect(res.status).toBe(200);
      const body = res.body as any;
      expect(body.ok).toBe(true);
      expect(body.ids).toHaveLength(1);
      expect(body.ids[0]).toBeGreaterThan(0);
    });

    it('inserts batch of tool calls', async () => {
      const res = await request(app)
        .post('/api/tool-calls')
        .send([
          { agent: 'drifter-gale', tool_name: 'mine', duration_ms: 100 },
          { agent: 'sable-thorn', tool_name: 'sell', duration_ms: 200, success: false, error_code: 'NO_DEMAND' },
        ]);
      expect(res.status).toBe(200);
      const body = res.body as any;
      expect(body.ids).toHaveLength(2);
    });

    it('stores full long args and result (no truncation)', async () => {
      const argsText = 'x'.repeat(300);
      const resultText = 'r'.repeat(500);
      const res = await request(app)
        .post('/api/tool-calls')
        .send({
          agent: 'drifter-gale',
          tool_name: 'mine',
          args_summary: argsText,
          result_summary: resultText,
        });
      expect(res.status).toBe(200);

      // Verify full text is stored (no truncation for activity page)
      const db = getDb();
      const row = db.prepare('SELECT args_summary, result_summary FROM proxy_tool_calls WHERE id = 1').get() as any;
      expect(row.args_summary).toBe(argsText);
      expect(row.result_summary).toBe(resultText);
    });

    it('rejects invalid agent names', async () => {
      const res = await request(app)
        .post('/api/tool-calls')
        .send({
          agent: 'DROP TABLE',
          tool_name: 'mine',
        });
      expect(res.status).toBe(200);
      const body = res.body as any;
      expect(body.ids).toHaveLength(0); // skipped invalid agent
    });
  });

  describe('GET /', () => {
    beforeEach(async () => {
      // Insert test data
      await request(app)
        .post('/api/tool-calls')
        .send([
          { agent: 'drifter-gale', tool_name: 'mine', duration_ms: 100 },
          { agent: 'sable-thorn', tool_name: 'sell', duration_ms: 200 },
          { agent: 'drifter-gale', tool_name: 'jump', duration_ms: 300 },
        ]);
    });

    it('returns all tool calls', async () => {
      const res = await request(app).get('/api/tool-calls');
      expect(res.status).toBe(200);
      const body = res.body as any;
      expect(body.tool_calls).toHaveLength(3);
    });

    it('filters by agent', async () => {
      const res = await request(app).get('/api/tool-calls?agent=drifter-gale');
      expect(res.status).toBe(200);
      const body = res.body as any;
      expect(body.tool_calls).toHaveLength(2);
      expect(body.tool_calls.every((c: any) => c.agent === 'drifter-gale')).toBe(true);
    });

    it('filters by tool name', async () => {
      const res = await request(app).get('/api/tool-calls?tool=mine');
      expect(res.status).toBe(200);
      const body = res.body as any;
      expect(body.tool_calls).toHaveLength(1);
      expect(body.tool_calls[0].tool_name).toBe('mine');
    });

    it('respects limit parameter', async () => {
      const res = await request(app).get('/api/tool-calls?limit=1');
      expect(res.status).toBe(200);
      const body = res.body as any;
      expect(body.tool_calls).toHaveLength(1);
    });
  });

  describe('DELETE /prune', () => {
    it('returns delete count', async () => {
      const res = await request(app).delete('/api/tool-calls/prune');
      expect(res.status).toBe(200);
      const body = res.body as any;
      expect(body.ok).toBe(true);
      expect(typeof body.deleted).toBe('number');
    });
  });
});
