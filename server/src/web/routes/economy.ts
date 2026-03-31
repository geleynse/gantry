import { Router } from 'express';
import { queryAll, queryOne } from '../../services/database.js';
import { getPnlSummary, getSessionPnl } from '../../services/analytics-query.js';
import { extractQueryAgent } from '../middleware/query-agent.js';
import { queryString, queryInt } from '../middleware/query-helpers.js';

const router: Router = Router();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ActionLogRow {
  id: number;
  agent: string;
  action_type: string;
  item: string | null;
  quantity: number | null;
  credits_delta: number | null;
  station: string | null;
  system: string | null;
  raw_data: string | null;
  game_timestamp: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// GET /api/economy/actions
// Paginated, filterable action log entries.
// ---------------------------------------------------------------------------

router.get('/actions', (req, res) => {
  const agentFilter = extractQueryAgent(req);
  const typeFilter  = queryString(req, 'type');

  const limit  = Math.min(queryInt(req, 'limit') ?? 100, 500);
  const offset = Math.max(queryInt(req, 'offset') ?? 0, 0);

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (agentFilter) {
    conditions.push('agent = ?');
    params.push(agentFilter);
  }
  if (typeFilter) {
    conditions.push('action_type = ?');
    params.push(typeFilter);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = queryOne<{ total: number }>(
    `SELECT COUNT(*) as total FROM agent_action_log ${where}`,
    ...params
  );

  const rows = queryAll<ActionLogRow>(
    `SELECT
      id, agent, action_type, item, quantity, credits_delta,
      station, system, game_timestamp, created_at
    FROM agent_action_log
    ${where}
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?`,
    ...params, limit, offset
  );

  res.json({
    actions: rows,
    total: countRow?.total ?? 0,
    limit,
    offset,
  });
});

// ---------------------------------------------------------------------------
// GET /api/economy/summary
// Per-agent credit delta totals and action counts.
// ---------------------------------------------------------------------------

router.get('/summary', (req, res) => {
  const hours = queryInt(req, 'hours') ?? 168; // default 7 days
  const rows = queryAll<{
    agent: string;
    total_earned: number;
    total_spent: number;
    net_credits: number;
    action_count: number;
    last_action_at: string | null;
  }>(`
    SELECT
      agent,
      SUM(CASE WHEN credits_delta > 0 THEN credits_delta ELSE 0 END) AS total_earned,
      SUM(CASE WHEN credits_delta < 0 THEN ABS(credits_delta) ELSE 0 END) AS total_spent,
      SUM(COALESCE(credits_delta, 0)) AS net_credits,
      COUNT(*) AS action_count,
      MAX(created_at) AS last_action_at
    FROM agent_action_log
    WHERE created_at >= datetime('now', '-' || ? || ' hours')
    GROUP BY agent
    ORDER BY net_credits DESC
  `, hours);

  res.json({ summary: rows });
});

// ---------------------------------------------------------------------------
// GET /api/economy/types
// Distinct action types with counts (useful for filter dropdowns).
// ---------------------------------------------------------------------------

router.get('/types', (_req, res) => {
  const rows = queryAll<{ action_type: string; count: number }>(`
    SELECT action_type, COUNT(*) AS count
    FROM agent_action_log
    GROUP BY action_type
    ORDER BY count DESC
  `);

  res.json({ types: rows });
});

// ---------------------------------------------------------------------------
// GET /api/economy/pnl
// Per-agent P&L with top items, time-filtered.
// ---------------------------------------------------------------------------

router.get('/pnl', (req, res) => {
  const agent = extractQueryAgent(req);
  const hours = queryInt(req, 'hours');
  res.json(getPnlSummary({ hours, agent }));
});

// ---------------------------------------------------------------------------
// GET /api/economy/session-pnl
// Per-session P&L derived from session_handoffs + agent_action_log.
// ---------------------------------------------------------------------------

router.get('/session-pnl', (req, res) => {
  const agent = extractQueryAgent(req);
  const limit = Math.min(queryInt(req, 'limit') ?? 20, 200);
  const sessions = getSessionPnl(agent, limit);
  res.json({ sessions });
});

export default router;
