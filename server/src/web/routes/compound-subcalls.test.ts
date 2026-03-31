/**
 * Tests for compound tool sub-call linking via parent_id.
 * Verifies that:
 *  1. GET /api/tool-calls?parent_id=X returns only sub-calls for that parent.
 *  2. GET /api/tool-calls includes parent_id in each returned row.
 *  3. Filtering by parent_id=invalid returns 400.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { createDatabase, getDb, closeDb } from '../../services/database.js';
import { logToolCallStart, logToolCallComplete } from '../../proxy/tool-call-logger.js';
import toolCallsRoutes from './tool-calls.js';

const app = express();
app.use(express.json());
app.use('/api/tool-calls', toolCallsRoutes);

describe('compound sub-call linking (parent_id)', () => {
  beforeEach(() => {
    createDatabase(':memory:');
  });

  afterEach(() => {
    closeDb();
  });

  it('GET / includes parent_id field in returned records', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO proxy_tool_calls (agent, tool_name, args_summary, result_summary, success, is_compound, status)
       VALUES ('drifter-gale', 'batch_mine', '{}', '{"ore":5}', 1, 1, 'complete')`
    ).run();

    const res = await request(app)
      .get('/api/tool-calls?agent=drifter-gale');

    expect(res.status).toBe(200);
    const body = res.body as { tool_calls: Array<Record<string, unknown>> };
    expect(body.tool_calls.length).toBeGreaterThan(0);
    // parent_id should be present (null for top-level calls)
    expect('parent_id' in body.tool_calls[0]).toBe(true);
  });

  it('GET /?parent_id=X returns only sub-calls for that compound tool', async () => {
    // Insert a compound tool call (parent)
    const db = getDb();
    const parentResult = db.prepare(
      `INSERT INTO proxy_tool_calls (agent, tool_name, args_summary, result_summary, success, is_compound, status)
       VALUES ('drifter-gale', 'batch_mine', '{}', '{"ore":10}', 1, 1, 'complete')`
    ).run();
    const parentId = Number(parentResult.lastInsertRowid);

    // Insert sub-calls with parent_id
    db.prepare(
      `INSERT INTO proxy_tool_calls (agent, tool_name, args_summary, result_summary, success, is_compound, status, parent_id)
       VALUES ('drifter-gale', 'mine', '{}', '{"ore":5}', 1, 0, 'complete', ?)`
    ).run(parentId);
    db.prepare(
      `INSERT INTO proxy_tool_calls (agent, tool_name, args_summary, result_summary, success, is_compound, status, parent_id)
       VALUES ('drifter-gale', 'mine', '{}', '{"ore":5}', 1, 0, 'complete', ?)`
    ).run(parentId);

    // Insert an unrelated call (no parent_id)
    db.prepare(
      `INSERT INTO proxy_tool_calls (agent, tool_name, args_summary, result_summary, success, is_compound, status)
       VALUES ('drifter-gale', 'jump', '{}', '{"ok":true}', 1, 0, 'complete')`
    ).run();

    const res = await request(app)
      .get(`/api/tool-calls?agent=drifter-gale&parent_id=${parentId}`);

    expect(res.status).toBe(200);
    const body = res.body as { tool_calls: Array<Record<string, unknown>> };
    // Only the 2 sub-calls should be returned, not the parent or unrelated call
    expect(body.tool_calls.length).toBe(2);
    for (const row of body.tool_calls) {
      expect(row.parent_id).toBe(parentId);
      expect(row.tool_name).toBe('mine');
    }
  });

  it('GET /?parent_id=invalid returns 400', async () => {
    const res = await request(app)
      .get('/api/tool-calls?parent_id=notanumber');
    expect(res.status).toBe(400);
  });

  it('logToolCallStart stores parent_id and it appears in DB', () => {
    // Insert a parent record directly
    const db = getDb();
    const parentResult = db.prepare(
      `INSERT INTO proxy_tool_calls (agent, tool_name, args_summary, result_summary, success, is_compound, status)
       VALUES ('sable-thorn', 'multi_sell', '{}', null, 1, 1, 'pending')`
    ).run();
    const parentId = Number(parentResult.lastInsertRowid);

    // Log a sub-call using the logger with parentId
    const subId = logToolCallStart('sable-thorn', 'sell', { item: 'ore' }, {
      isCompound: false,
      parentId,
    });
    expect(subId).toBeGreaterThan(0);

    // Verify parent_id stored correctly
    const row = db.prepare('SELECT parent_id FROM proxy_tool_calls WHERE id = ?').get(subId) as
      { parent_id: number | null } | undefined;
    expect(row?.parent_id).toBe(parentId);
  });
});
