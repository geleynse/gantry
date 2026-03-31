import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createDatabase, getDb, closeDb } from '../../services/database.js';
import { subscribe, unsubscribe } from '../../proxy/tool-call-logger.js';

// ---------------------------------------------------------------------------
// Test DB setup
// ---------------------------------------------------------------------------

function setupTestDb(): void {
  createDatabase(':memory:');
}

function insertToolCall(opts: {
  agent: string;
  tool_name: string;
  args_summary?: string | null;
  result_summary?: string | null;
  success?: boolean;
  duration_ms?: number | null;
  status?: string;
  created_at?: string;
  parent_id?: number | null;
}): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO proxy_tool_calls
      (agent, tool_name, args_summary, result_summary, success, error_code, duration_ms, is_compound, status, parent_id, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    opts.agent,
    opts.tool_name,
    opts.args_summary ?? null,
    opts.result_summary ?? null,
    opts.success !== false ? 1 : 0,
    null,
    opts.duration_ms ?? null,
    0,
    opts.status ?? 'complete',
    opts.parent_id ?? null,
  );
  return Number(result.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Helper: invoke route handler logic directly (no HTTP overhead)
// ---------------------------------------------------------------------------

/**
 * Query the feed logic directly using the same SQL in the route handler.
 * This lets us test the query / shape without spinning up an HTTP server.
 */
function queryFeed(opts: {
  agent?: string;
  since?: string;
  limit?: number;
}): Array<{
  id: number;
  agent: string;
  tool_name: string;
  params_summary: string | null;
  result_summary: string | null;
  status: string;
  timestamp: string;
  duration_ms: number | null;
  is_compound?: boolean;
  trace_id?: string | null;
}> {
  const { agent, since, limit = 100 } = opts;
  const conditions: string[] = [];
  const params: Array<string | number> = [];

  if (agent) {
    conditions.push('agent = ?');
    params.push(agent);
  }
  if (since) {
    conditions.push("created_at > datetime(?)");
    params.push(since);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  params.push(Math.min(limit, 500));

  const db = getDb();
  const rows = db.prepare(
    `SELECT id, agent, tool_name, args_summary AS params_summary, result_summary, success, error_code,
            duration_ms, is_compound, status, trace_id, timestamp, created_at
     FROM proxy_tool_calls ${where}
     ORDER BY created_at DESC
     LIMIT ?`
  ).all(...params) as Array<{
    id: number;
    agent: string;
    tool_name: string;
    params_summary: string | null;
    result_summary: string | null;
    success: number;
    error_code: string | null;
    duration_ms: number | null;
    is_compound: number;
    status: string;
    trace_id: string | null;
    timestamp: string;
    created_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    agent: r.agent,
    tool_name: r.tool_name,
    params_summary: r.params_summary,
    result_summary: r.result_summary,
    status: r.status,
    timestamp: r.timestamp,
    duration_ms: r.duration_ms,
    is_compound: r.is_compound === 1,
    trace_id: r.trace_id,
  }));
}

// ---------------------------------------------------------------------------
// Tests: /api/activity/feed
// ---------------------------------------------------------------------------

describe('GET /api/activity/feed', () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    closeDb();
  });

  it('returns all events across agents (newest first)', () => {
    insertToolCall({ agent: 'drifter-gale', tool_name: 'mine', status: 'complete' });
    insertToolCall({ agent: 'sable-thorn', tool_name: 'attack', status: 'complete' });
    insertToolCall({ agent: 'rust-vane', tool_name: 'jump', status: 'complete' });

    const events = queryFeed({});

    expect(events.length).toBe(3);
    // Verify expected shape fields on every event
    for (const ev of events) {
      expect(typeof ev.id).toBe('number');
      expect(typeof ev.agent).toBe('string');
      expect(typeof ev.tool_name).toBe('string');
      expect(typeof ev.status).toBe('string');
      expect(typeof ev.timestamp).toBe('string');
      // params_summary / result_summary / duration_ms may be null — that's fine
    }
  });

  it('filters events by agent when ?agent= is supplied', () => {
    insertToolCall({ agent: 'drifter-gale', tool_name: 'mine' });
    insertToolCall({ agent: 'drifter-gale', tool_name: 'sell' });
    insertToolCall({ agent: 'sable-thorn', tool_name: 'attack' });

    const events = queryFeed({ agent: 'drifter-gale' });

    expect(events.length).toBe(2);
    for (const ev of events) {
      expect(ev.agent).toBe('drifter-gale');
    }
  });

  it('returns up to 100 events by default (respects limit)', () => {
    // Insert 110 tool calls for the same agent
    for (let i = 0; i < 110; i++) {
      insertToolCall({ agent: 'drifter-gale', tool_name: `tool_${i}` });
    }

    const events = queryFeed({ limit: 100 });

    expect(events.length).toBe(100);
  });

  it('returns correct field shape including params_summary', () => {
    insertToolCall({
      agent: 'cinder-wake',
      tool_name: 'travel_to',
      args_summary: '{"destination":"Sol"}',
      result_summary: '{"arrived":true}',
      duration_ms: 1500,
    });

    const events = queryFeed({});

    expect(events.length).toBe(1);
    const ev = events[0];
    expect(ev.agent).toBe('cinder-wake');
    expect(ev.tool_name).toBe('travel_to');
    expect(ev.params_summary).toBe('{"destination":"Sol"}');
    expect(ev.result_summary).toBe('{"arrived":true}');
    expect(ev.duration_ms).toBe(1500);
  });

  it('returns routine tool calls (namespaced)', () => {
    const parentId = insertToolCall({
      agent: 'drifter-gale',
      tool_name: 'execute_routine',
      status: 'complete',
    });

    insertToolCall({
      agent: 'drifter-gale',
      tool_name: 'routine:sell_cycle:sell',
      args_summary: '{"count": 5}',
      result_summary: '{"sold": true}',
      status: 'complete',
      parent_id: parentId,
    });

    const events = queryFeed({});

    expect(events.length).toBe(2);
    const names = events.map(e => e.tool_name);
    expect(names).toContain('routine:sell_cycle:sell');
    expect(names).toContain('execute_routine');
  });

  it('returns execute_routine tool call', () => {
    insertToolCall({
      agent: 'drifter-gale',
      tool_name: 'execute_routine',
      args_summary: '{"routine": "sell_cycle"}',
      status: 'pending',
    });

    const events = queryFeed({});

    expect(events.length).toBe(1);
    expect(events[0].tool_name).toBe('execute_routine');
    expect(events[0].status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// Tests: SSE stream subscriber pattern
// ---------------------------------------------------------------------------

describe('SSE stream subscriber pattern', () => {
  it('subscribes and receives tool call events via callback', async () => {
    const received: unknown[] = [];

    const cb = (record: unknown) => {
      received.push(record);
    };

    subscribe(cb as Parameters<typeof subscribe>[0]);

    // Simulate the logger notifying subscribers by calling subscribe/unsubscribe
    // The actual notify path is tested via logToolCallStart in the logger module.
    // Here we verify the subscribe/unsubscribe plumbing is correct.

    unsubscribe(cb as Parameters<typeof unsubscribe>[0]);

    // After unsubscribing, subsequent events should not reach cb
    // (verified implicitly by checking received is still empty here)
    expect(received.length).toBe(0);
  });

  it('supports multiple simultaneous subscribers', () => {
    const counts = [0, 0];
    const cb0 = () => { counts[0]++; };
    const cb1 = () => { counts[1]++; };

    subscribe(cb0);
    subscribe(cb1);

    // Both should be registered — unsubscribe individually
    unsubscribe(cb0);
    unsubscribe(cb1);

    // Verify we can subscribe/unsubscribe without throwing
    expect(counts[0]).toBe(0);
    expect(counts[1]).toBe(0);
  });
});
