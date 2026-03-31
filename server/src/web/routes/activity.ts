import { Router } from 'express';
import { queryAll } from '../../services/database.js';
import { getRingBuffer, subscribe, unsubscribe, type ToolCallRecord } from '../../proxy/tool-call-logger.js';
import { startTailing, stopTailing } from '../../services/log-streamer.js';
import { initSSE, writeSSE } from '../sse.js';
import { validateAgentName } from '../config.js';
import { extractQueryAgent } from '../middleware/query-agent.js';
import { queryString, queryInt } from '../middleware/query-helpers.js';
import { createLogger } from '../../lib/logger.js';

export type { ToolCallRecord };

const log = createLogger('activity');
const FEED_LIMIT = 100;

const router: Router = Router();

/**
 * GET /api/activity/feed
 * Returns recent tool call events across all agents, newest first.
 * Query params:
 *   ?agent=name    — filter to a single agent
 *   ?since=ISO     — only events after this timestamp (incremental)
 *   ?limit=N       — max results (default 100, max 500)
 */
router.get('/feed', (req, res) => {
  const agentFilter = extractQueryAgent(req);
  const since = queryString(req, 'since');
  const limit = Math.min(queryInt(req, 'limit') ?? FEED_LIMIT, 500);

  const conditions: string[] = [];
  const params: Array<string | number> = [];

  if (agentFilter) {
    conditions.push('agent = ?');
    params.push(agentFilter);
  }

  if (since) {
    conditions.push("created_at > datetime(?)");
    params.push(since);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  params.push(limit);

  interface FeedRow {
    id: number; agent: string; tool_name: string; params_summary: string | null;
    result_summary: string | null; success: number; error_code: string | null;
    duration_ms: number | null; is_compound: number; status: string;
    trace_id: string | null; timestamp: string; created_at: string;
  }
  const rows = queryAll<FeedRow>(
    `SELECT id, agent, tool_name, args_summary AS params_summary, result_summary, success, error_code,
            duration_ms, is_compound, status, trace_id, timestamp, created_at
     FROM proxy_tool_calls ${where}
     ORDER BY created_at DESC
     LIMIT ?`,
    ...params
  );

  const events = rows.map((r) => ({
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

  res.json({ events, count: events.length });
});

/**
 * GET /api/activity/stream
 * SSE endpoint that pushes new tool call events as they happen across all agents.
 * Reuses the tool-call-logger subscriber pattern.
 * Query params:
 *   ?agent=name    — filter to a single agent
 */
router.get('/stream', (req, res) => {
  const agentFilter = extractQueryAgent(req);

  initSSE(req, res);

  // Backfill: send the last 50 from the ring buffer as an initial batch
  const backfill = getRingBuffer().slice(-50).filter(
    (r) => !agentFilter || r.agent === agentFilter,
  );
  if (backfill.length > 0) {
    const events = backfill.map(toActivityEvent);
    writeSSE(res, 'activity', events);
  }

  // Push new events as they arrive
  const cb = (record: ToolCallRecord) => {
    if (agentFilter && record.agent !== agentFilter) return;
    writeSSE(res, 'activity', [toActivityEvent(record)]);
  };

  subscribe(cb);

  req.on('close', () => {
    unsubscribe(cb);
    res.end();
  });
});

/** Map a ToolCallRecord to the slimmer ActivityEvent shape */
function toActivityEvent(r: ToolCallRecord) {
  return {
    id: r.id,
    agent: r.agent,
    tool_name: r.tool_name,
    params_summary: r.args_summary,
    result_summary: r.result_summary,
    status: r.status,
    timestamp: r.timestamp,
    duration_ms: r.duration_ms,
    is_compound: r.is_compound === 1,
    trace_id: r.trace_id,
  };
}

/**
 * GET /api/activity/agent-stream/:name
 * SSE endpoint that streams live agent log output as it is written.
 * Each event has type "agent_output" and carries a JSON payload:
 *   { agent: string; line: string; timestamp: string }
 *
 * The stream starts from the current end-of-file so only new output
 * after the connection is established is sent. The tailer is stopped
 * automatically when the client disconnects.
 */
router.get('/agent-stream/:name', (req, res) => {
  const { name } = req.params;

  if (!name || !validateAgentName(name)) {
    res.status(400).json({ error: 'invalid agent name' });
    return;
  }

  initSSE(req, res);

  startTailing(name, (line: string) => {
    writeSSE(res, 'agent_output', {
      agent: name,
      line,
      timestamp: new Date().toISOString(),
    });
  }).catch((err: unknown) => {
    // Non-fatal — log server-side and let the client reconnect
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Tailing failed for ${name}`, { error: msg });
    writeSSE(res, 'error', { message: `Tailing failed: ${msg}` });
  });

  req.on('close', () => {
    stopTailing(name);
    res.end();
  });
});

export default router;
