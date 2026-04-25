/**
 * Prayer telemetry routes.
 *
 * Operator-visible surface for PrayerLang. Reads directly from proxy_tool_calls
 * where spacemolt_pray handlers already persist every call (see
 * proxy/tool-call-logger.ts + proxy/gantry-v2.ts handlePrayerAction).
 *
 * No new tables — prayer rows are identified by tool_name = 'pray'.
 */

import { Router } from 'express';
import { queryAll, queryOne } from '../../services/database.js';
import { AGENTS, validateAgentName } from '../../config.js';
import { queryString, queryInt } from '../middleware/query-helpers.js';

const router: Router = Router();

// --- Types mirrored from tool-call-logger -----------------------------------

interface PrayerRow {
  id: number;
  agent: string;
  args_summary: string | null;
  result_summary: string | null;
  success: number;
  error_code: string | null;
  duration_ms: number | null;
  status: string;
  trace_id: string | null;
  timestamp: string;
  created_at: string;
}

interface SubcallRow {
  id: number;
  parent_id: number | null;
  tool_name: string;
  args_summary: string | null;
  result_summary: string | null;
  success: number;
  error_code: string | null;
  duration_ms: number | null;
  timestamp: string;
}

export interface PrayerSummary {
  id: number;
  agent: string;
  timestamp: string;
  status: 'completed' | 'halted' | 'step_limit_reached' | 'interrupted' | 'error' | 'pending' | string;
  success: boolean;
  durationMs: number | null;
  traceId: string | null;
  script: string | null;
  maxSteps: number | null;
  timeoutTicks: number | null;
  normalizedScript: string | null;
  stepsExecuted: number | null;
  handoffReason: string | null;
  errorTier: 'parse' | 'analyze' | 'runtime' | null;
  errorCode: string | null;
  errorMessage: string | null;
  errorLine: number | null;
  errorCol: number | null;
  suggestions: string[] | null;
  diff: unknown;
  warnings: string[] | null;
  subcallCount: number;
  subcalls: Array<{
    id: number;
    toolName: string;
    success: boolean;
    durationMs: number | null;
    errorCode: string | null;
    argsSummary: string | null;
    resultSummary: string | null;
    timestamp: string;
  }>;
}

export interface AgentAdoption {
  agent: string;
  prayEnabled: boolean;
  prayerCount: number;
  turnCount: number;
  adoptionRatio: number; // prayers / turns, capped at 1 for display sanity
  avgStepsExecuted: number | null;
  successRate: number | null; // 0..1
  completedCount: number;
  errorCount: number;
  lastPrayerAt: string | null;
}

// --- Helpers ---------------------------------------------------------------

function parseJson<T>(s: string | null): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

// Status vocabulary note: there are two `status` fields in play here.
//   - row.status              ← proxy_tool_calls.status column: 'pending' | 'complete' | 'error'
//   - result.status           ← result_summary JSON payload: 'completed' | 'halted' |
//                                'step_limit_reached' | 'interrupted' | 'error' | ...
// The summary's `status` prefers the richer result_summary value and only
// falls back to the column when the call is still pending or has no payload.
function toSummary(
  row: PrayerRow,
  subcalls: SubcallRow[],
): PrayerSummary {
  const args = parseJson<{ script?: string; max_steps?: number; timeout_ticks?: number }>(row.args_summary) ?? {};
  const result = parseJson<{
    status?: string;
    steps_executed?: number;
    handoff_reason?: string;
    normalized_script?: string;
    warnings?: string[];
    diff?: unknown;
    error?: {
      tier?: 'parse' | 'analyze' | 'runtime';
      code?: string;
      message?: string;
      line?: number;
      col?: number;
      suggestions?: string[];
    };
  }>(row.result_summary) ?? {};

  const status = row.status === 'pending' ? 'pending' : (result.status ?? (row.success ? 'completed' : 'error'));

  return {
    id: row.id,
    agent: row.agent,
    timestamp: row.timestamp,
    status,
    success: row.success === 1,
    durationMs: row.duration_ms,
    traceId: row.trace_id,
    script: typeof args.script === 'string' ? args.script : null,
    maxSteps: typeof args.max_steps === 'number' ? args.max_steps : null,
    timeoutTicks: typeof args.timeout_ticks === 'number' ? args.timeout_ticks : null,
    normalizedScript: typeof result.normalized_script === 'string' ? result.normalized_script : null,
    stepsExecuted: typeof result.steps_executed === 'number' ? result.steps_executed : null,
    handoffReason: typeof result.handoff_reason === 'string' ? result.handoff_reason : null,
    errorTier: result.error?.tier ?? null,
    errorCode: result.error?.code ?? row.error_code ?? null,
    errorMessage: result.error?.message ?? null,
    errorLine: typeof result.error?.line === 'number' ? result.error.line : null,
    errorCol: typeof result.error?.col === 'number' ? result.error.col : null,
    suggestions: Array.isArray(result.error?.suggestions) ? result.error.suggestions : null,
    diff: result.diff ?? null,
    warnings: Array.isArray(result.warnings) ? result.warnings : null,
    subcallCount: subcalls.length,
    subcalls: subcalls.map((s) => ({
      id: s.id,
      toolName: s.tool_name,
      success: s.success === 1,
      durationMs: s.duration_ms,
      errorCode: s.error_code,
      argsSummary: s.args_summary,
      resultSummary: s.result_summary,
      timestamp: s.timestamp,
    })),
  };
}

function loadSubcalls(parentIds: number[]): Map<number, SubcallRow[]> {
  const byParent = new Map<number, SubcallRow[]>();
  if (parentIds.length === 0) return byParent;
  const placeholders = parentIds.map(() => '?').join(',');
  const rows = queryAll<SubcallRow>(
    `SELECT id, parent_id, tool_name, args_summary, result_summary, success, error_code, duration_ms, timestamp
     FROM proxy_tool_calls
     WHERE parent_id IN (${placeholders})
     ORDER BY id ASC`,
    ...parentIds,
  );
  for (const row of rows) {
    if (row.parent_id == null) continue;
    const list = byParent.get(row.parent_id) ?? [];
    list.push(row);
    byParent.set(row.parent_id, list);
  }
  return byParent;
}

// --- Routes ----------------------------------------------------------------

/**
 * GET /api/prayer/recent?agent=<name>&limit=<n>
 * Returns recent pray rows for an agent, with subcalls attached.
 */
router.get('/recent', (req, res) => {
  const agent = queryString(req, 'agent');
  if (!agent || !validateAgentName(agent)) {
    res.status(400).json({ error: 'invalid or missing agent' });
    return;
  }

  const limit = Math.min(Math.max(queryInt(req, 'limit') ?? 25, 1), 100);

  const rows = queryAll<PrayerRow>(
    `SELECT id, agent, args_summary, result_summary, success, error_code, duration_ms, status, trace_id, timestamp, created_at
     FROM proxy_tool_calls
     WHERE agent = ? AND tool_name = 'pray'
     ORDER BY id DESC
     LIMIT ?`,
    agent, limit,
  );

  const byParent = loadSubcalls(rows.map((r) => r.id));
  const prayers = rows.map((r) => toSummary(r, byParent.get(r.id) ?? []));

  res.json({ prayers });
});

/**
 * GET /api/prayer/:id
 * Single prayer detail with subcalls.
 */
router.get('/by-id/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id <= 0) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }

  const row = queryOne<PrayerRow>(
    `SELECT id, agent, args_summary, result_summary, success, error_code, duration_ms, status, trace_id, timestamp, created_at
     FROM proxy_tool_calls
     WHERE id = ? AND tool_name = 'pray'`,
    id,
  );
  if (!row) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const byParent = loadSubcalls([row.id]);
  res.json({ prayer: toSummary(row, byParent.get(row.id) ?? []) });
});

/**
 * GET /api/prayer/adoption?hours=<n>
 * Per-agent adoption stats. Returns a row per configured agent (even with zero prayers).
 */
router.get('/adoption', (req, res) => {
  const hours = Math.min(Math.max(queryInt(req, 'hours') ?? 24, 1), 24 * 30);
  const sinceExpr = `datetime('now', '-' || ? || ' hours')`;

  type PrayerAgg = {
    agent: string;
    count: number;
    avg_steps: number | null;
    completed_count: number;
    error_count: number;
    last_ts: string | null;
  };
  const prayerRows = queryAll<PrayerAgg>(
    `SELECT
       agent,
       COUNT(*) AS count,
       AVG(CASE
             WHEN result_summary IS NOT NULL
             THEN json_extract(result_summary, '$.steps_executed')
           END) AS avg_steps,
       SUM(CASE
             WHEN json_extract(result_summary, '$.status') = 'completed' THEN 1
             ELSE 0
           END) AS completed_count,
       SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS error_count,
       MAX(timestamp) AS last_ts
     FROM proxy_tool_calls
     WHERE tool_name = 'pray'
       AND created_at > ${sinceExpr}
     GROUP BY agent`,
    hours,
  );

  type TurnAgg = { agent: string; count: number };
  const turnRows = queryAll<TurnAgg>(
    `SELECT agent, COUNT(*) AS count
     FROM turns
     WHERE started_at > ${sinceExpr}
     GROUP BY agent`,
    hours,
  );

  const prayerByAgent = new Map(prayerRows.map((r) => [r.agent, r]));
  const turnByAgent = new Map(turnRows.map((r) => [r.agent, r.count]));

  const agents = AGENTS.map((a) => ({ name: a.name, prayEnabled: a.prayEnabled === true }));
  // Also surface prayer rows for agents no longer in config (defensive).
  for (const agent of prayerByAgent.keys()) {
    if (!agents.some((a) => a.name === agent)) {
      agents.push({ name: agent, prayEnabled: false });
    }
  }

  const adoption: AgentAdoption[] = agents.map((a) => {
    const p = prayerByAgent.get(a.name);
    const turnCount = turnByAgent.get(a.name) ?? 0;
    const prayerCount = p?.count ?? 0;
    const completed = p?.completed_count ?? 0;
    const errors = p?.error_count ?? 0;
    const attempted = prayerCount;
    const successRate = attempted > 0 ? completed / attempted : null;
    const adoptionRatio = turnCount > 0 ? Math.min(prayerCount / turnCount, 1) : 0;
    return {
      agent: a.name,
      prayEnabled: a.prayEnabled,
      prayerCount,
      turnCount,
      adoptionRatio,
      avgStepsExecuted: p?.avg_steps ?? null,
      successRate,
      completedCount: completed,
      errorCount: errors,
      lastPrayerAt: p?.last_ts ?? null,
    };
  });

  adoption.sort((a, b) => b.prayerCount - a.prayerCount || a.agent.localeCompare(b.agent));

  res.json({ hours, adoption });
});

export default router;
