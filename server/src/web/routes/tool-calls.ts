import { Router } from 'express';
import { getDb, queryAll, queryOne, queryRun } from '../../services/database.js';
import { createLogger } from '../../lib/logger.js';
import { queryString, queryInt } from '../middleware/query-helpers.js';

const log = createLogger('tool-calls');
import { getRingBuffer, subscribe, unsubscribe, logAssistantText, logAgentReasoning, type ToolCallRecord } from '../../proxy/tool-call-logger.js';
import { initSSE, writeSSE } from '../sse.js';

export type { ToolCallRecord };

const AGENT_NAME_RE = /^[a-z0-9-]+$/;
const PRUNE_HOURS_DEFAULT = 168; // 7 days

const router: Router = Router();

// POST / — ingest tool call from proxy (kept for backward compatibility — direct DB writes preferred)
router.post('/', async (req, res) => {
  const body = req.body;

  // Support batch POST (array) or single record
  const records = Array.isArray(body) ? body : [body];

  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO proxy_tool_calls (agent, tool_name, args_summary, result_summary, success, error_code, duration_ms, is_compound, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const ids: number[] = [];
  const insertAll = db.transaction((recs: typeof records) => {
    for (const rec of recs) {
      if (!rec.agent || !rec.tool_name) continue;
      if (!AGENT_NAME_RE.test(rec.agent)) continue;

      const result = insert.run(
        rec.agent,
        rec.tool_name,
        rec.args_summary ?? null,
        rec.result_summary ?? null,
        rec.success !== false && rec.success !== 0 ? 1 : 0,
        rec.error_code ?? null,
        typeof rec.duration_ms === 'number' ? rec.duration_ms : null,
        rec.is_compound ? 1 : 0,
      );

      ids.push(Number(result.lastInsertRowid));
      // Note: ring buffer is populated by tool-call-logger when using direct DB path.
    }
  });

  insertAll(records);
  res.json({ ok: true, ids });
});

// GET / — query tool calls with filters
router.get('/', (req, res) => {
  const agent = queryString(req, 'agent');
  const tool = queryString(req, 'tool');
  const type = queryString(req, 'type');
  const since = queryString(req, 'since');
  const parentIdParam = queryString(req, 'parent_id');
  const limit = Math.min(queryInt(req, 'limit') ?? 50, 500);
  const offset = Math.max(queryInt(req, 'offset') ?? 0, 0);

  const conditions: string[] = [];
  const params: Array<string | number> = [];

  if (agent && AGENT_NAME_RE.test(agent)) {
    conditions.push('agent = ?');
    params.push(agent);
  }
  if (tool) {
    conditions.push('tool_name = ?');
    params.push(tool);
  }
  // ?type=reasoning filters to only __reasoning records
  if (type === 'reasoning') {
    conditions.push("tool_name = '__reasoning'");
  }
  if (since) {
    conditions.push("created_at > datetime(?)");
    params.push(since);
  }
  if (parentIdParam !== undefined) {
    const parentId = parseInt(parentIdParam, 10);
    if (!isNaN(parentId) && parentId > 0) {
      conditions.push('parent_id = ?');
      params.push(parentId);
    } else {
      res.status(400).json({ error: 'invalid parent_id' });
      return;
    }
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  params.push(limit, offset);

  const db = getDb();
  const rows = db.prepare(
    `SELECT id, agent, tool_name, args_summary, result_summary, success, error_code, duration_ms, is_compound, status, assistant_text, trace_id, parent_id, timestamp, created_at
     FROM proxy_tool_calls ${where}
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`
  ).all(...params) as ToolCallRecord[];

  res.json({ tool_calls: rows });
});

// POST /text — ingest assistant text chunks from agent runner
router.post('/text', (req, res) => {
  const body = req.body;
  const agent = typeof body?.agent === 'string' ? body.agent : null;
  const text = typeof body?.text === 'string' ? body.text : null;
  const traceId = typeof body?.trace_id === 'string' ? body.trace_id : null;

  if (!agent || !AGENT_NAME_RE.test(agent)) {
    res.status(400).json({ error: 'invalid or missing agent name' });
    return;
  }
  if (!text || !text.trim()) {
    res.status(400).json({ error: 'missing text' });
    return;
  }

  logAssistantText(agent, text, traceId);
  res.json({ ok: true });
});

// GET /stream — SSE endpoint for live tool calls
router.get('/stream', (req, res) => {
  const agentFilter = queryString(req, 'agent');

  initSSE(req, res);

  // Backfill: send last 50 from ring buffer as a tool_call event (array)
  const backfill = getRingBuffer().slice(-50).filter(
    (r) => !agentFilter || r.agent === agentFilter,
  );
  if (backfill.length > 0) {
    writeSSE(res, 'tool_call', backfill);
  }

  // Subscribe to new tool calls via push (no polling)
  // Wrap individual records in an array for consistent frontend handling
  const cb = (record: ToolCallRecord) => {
    if (agentFilter && record.agent !== agentFilter) return;
    writeSSE(res, 'tool_call', [record]);
  };

  if (!subscribe(cb)) {
    res.status(503).json({ error: "Too many SSE subscribers" });
    return;
  }

  req.on('close', () => {
    unsubscribe(cb);
    res.end();
  });
});

// DELETE /prune — cleanup old records
router.delete('/prune', (req, res) => {
  const hours = queryInt(req, 'hours') ?? PRUNE_HOURS_DEFAULT;
  const deleted = pruneOldToolCalls(hours);
  res.json({ ok: true, deleted });
});

// GET /missions — active missions for an agent from latest get_active_missions tool call
router.get('/missions', (req, res) => {
  const agent = queryString(req, 'agent');
  if (!agent || !AGENT_NAME_RE.test(agent)) {
    res.status(400).json({ error: 'invalid or missing agent name' });
    return;
  }

  const row = queryOne<{ result_summary: string | null }>(
    `SELECT result_summary
    FROM proxy_tool_calls
    WHERE agent = ? AND tool_name = 'get_active_missions' AND status = 'complete' AND success = 1
    ORDER BY created_at DESC
    LIMIT 1`,
    agent
  );

  if (!row?.result_summary) {
    res.json({ missions: [] });
    return;
  }

  try {
    const parsed = JSON.parse(row.result_summary) as Record<string, unknown>;
    const missions = Array.isArray(parsed.missions) ? parsed.missions : [];
    res.json({ missions });
  } catch (err) {
    log.debug(`Failed to parse missions for ${agent}`, { error: err instanceof Error ? err.message : String(err) });
    res.json({ missions: [] });
  }
});

export function pruneOldToolCalls(hours = PRUNE_HOURS_DEFAULT): number {
  try {
    return queryRun(
      "DELETE FROM proxy_tool_calls WHERE created_at < datetime('now', '-' || ? || ' hours')",
      hours
    );
  } catch (err) {
    log.error('Failed to prune old tool calls', { error: err instanceof Error ? err.message : String(err) });
    return 0;
  }
}

// GET /turn-costs — query turn cost data for tool-call feed cost badges
router.get('/turn-costs', (req, res) => {
  const agent = queryString(req, 'agent');
  const since = queryString(req, 'since');

  // Validate agent name
  if (!agent || !AGENT_NAME_RE.test(agent)) {
    res.status(400).json({ error: 'invalid or missing agent name' });
    return;
  }

  if (!since) {
    res.status(400).json({ error: 'missing since parameter' });
    return;
  }

  const rows = queryAll<{
    turn_number: number;
    started_at: string;
    completed_at: string | null;
    cost_usd: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_tokens: number | null;
    iterations: number | null;
    model: string | null;
  }>(
    `SELECT turn_number, started_at, completed_at, cost_usd, input_tokens, output_tokens, cache_read_tokens, iterations, model
    FROM turns
    WHERE agent = ? AND started_at >= ?
    ORDER BY started_at DESC
    LIMIT 100`,
    agent, since
  );

  const turns = rows.map(r => ({
    turnNumber: r.turn_number,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    costUsd: r.cost_usd,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    iterations: r.iterations,
    model: r.model,
  }));

  res.json({ turns });
});

// Agent reasoning router — mounted at /api/agents by app.ts
// POST /api/agents/:name/reasoning — ingest reasoning block from agent runner (admin-only via POST)
export const agentReasoningRouter: Router = Router();

agentReasoningRouter.post('/:name/reasoning', (req, res) => {
  const name = req.params.name as string;
  if (!AGENT_NAME_RE.test(name)) {
    res.status(400).json({ error: 'invalid agent name' });
    return;
  }

  const body = req.body;
  const text = typeof body?.text === 'string' ? body.text : null;
  const traceId = typeof body?.trace_id === 'string' ? body.trace_id : null;

  if (!text || !text.trim()) {
    res.status(400).json({ error: 'missing text' });
    return;
  }

  logAgentReasoning(name, text, traceId);
  res.status(204).end();
});

export default router;
