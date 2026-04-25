import type { SQLQueryBindings } from 'bun:sqlite';
import { getDb } from './database.js';

// --- Types ---

export interface TimeFilter {
  hours?: number;
  agent?: string;
}

export interface CostDataPoint {
  agent: string;
  timestamp: string;
  cost: number;
  iterations: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ToolFrequencyEntry {
  toolName: string;
  count: number;
  avgSuccess: number;
}

export interface CreditsDataPoint {
  timestamp: string;
  credits: number;
  system: string;
  poi: string;
}

export interface HullShieldDataPoint {
  agent: string;
  timestamp: string;
  hull: number | null;
  hullMax: number | null;
  shield: number | null;
  shieldMax: number | null;
}

export interface AgentComparisonEntry {
  agent: string;
  turnCount: number;
  totalCost: number;
  avgCostPerTurn: number;
  totalIterations: number;
  avgDurationMs: number;
  latestCredits: number | null;
  creditsChange: number;
}

// --- Helpers ---

function buildTimeClause(filter: TimeFilter, tableAlias: string = 't'): { where: string; params: SQLQueryBindings[] } {
  const clauses: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (filter.hours != null && filter.hours > 0) {
    clauses.push(`datetime(${tableAlias}.started_at) >= datetime('now', ?)`);
    params.push(`-${filter.hours} hours`);
  }
  if (filter.agent) {
    clauses.push(`${tableAlias}.agent = ?`);
    params.push(filter.agent);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return { where, params };
}

/**
 * Append `agent != 'overseer'` to a built WHERE clause so per-agent fleet
 * aggregates exclude the overseer (which is a supervisor agent, not a
 * trader/combat agent — its turns are recorded by turn-ingestor like any
 * other Claude Code agent, but it would otherwise pollute fleet-wide
 * cost / efficiency / comparison rollups).
 *
 * Pass-through when the caller has already filtered to a specific agent
 * (`filter.agent` set), since the overseer would never match a fleet-agent
 * name anyway.
 */
function withoutOverseer(
  where: string,
  tableAlias: string = 't',
  filter?: TimeFilter,
): string {
  if (filter?.agent) return where;
  const clause = `${tableAlias}.agent != 'overseer'`;
  return where ? `${where} AND ${clause}` : `WHERE ${clause}`;
}

// --- Query Functions ---

export function getCostOverTime(filter: TimeFilter): CostDataPoint[] {
  const db = getDb();
  const { where, params } = buildTimeClause(filter);
  const whereWithoutOverseer = withoutOverseer(where, 't', filter);

  const rows = db.prepare(`
    SELECT agent, started_at, cost_usd, iterations, duration_ms, input_tokens, output_tokens
    FROM turns t
    ${whereWithoutOverseer}
    ORDER BY t.started_at ASC
  `).all(...params) as Array<{
    agent: string;
    started_at: string;
    cost_usd: number;
    iterations: number;
    duration_ms: number;
    input_tokens: number;
    output_tokens: number;
  }>;

  return rows.map(r => ({
    agent: r.agent,
    timestamp: r.started_at,
    cost: r.cost_usd,
    iterations: r.iterations,
    durationMs: r.duration_ms,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
  }));
}

export function getToolFrequency(filter: TimeFilter): ToolFrequencyEntry[] {
  const db = getDb();
  const { where, params } = buildTimeClause(filter);

  const rows = db.prepare(`
    SELECT tc.tool_name, COUNT(*) as count, AVG(tc.success) as avg_success
    FROM tool_calls tc
    JOIN turns t ON tc.turn_id = t.id
    ${where}
    GROUP BY tc.tool_name
    ORDER BY count DESC
  `).all(...params) as Array<{
    tool_name: string;
    count: number;
    avg_success: number;
  }>;

  return rows.map(r => ({
    toolName: r.tool_name,
    count: r.count,
    avgSuccess: r.avg_success,
  }));
}

export function getCreditsOverTime(filter: TimeFilter): CreditsDataPoint[] {
  const db = getDb();
  const { where, params } = buildTimeClause(filter);

  const rows = db.prepare(`
    SELECT t.started_at, gs.credits, gs.system, gs.poi
    FROM game_snapshots gs
    JOIN turns t ON gs.turn_id = t.id
    ${where}
    ORDER BY t.started_at ASC
  `).all(...params) as Array<{
    started_at: string;
    credits: number;
    system: string;
    poi: string;
  }>;

  return rows.map(r => ({
    timestamp: r.started_at,
    credits: r.credits,
    system: r.system,
    poi: r.poi,
  }));
}

export function getHullShieldOverTime(filter: TimeFilter): HullShieldDataPoint[] {
  const db = getDb();
  const { where, params } = buildTimeClause(filter);
  const whereWithoutOverseer = withoutOverseer(where, 't', filter);
  const hullFilter = whereWithoutOverseer
    ? `${whereWithoutOverseer} AND gs.hull IS NOT NULL`
    : 'WHERE gs.hull IS NOT NULL';

  const rows = db.prepare(`
    SELECT gs.agent, t.started_at, gs.hull, gs.hull_max, gs.shield, gs.shield_max
    FROM game_snapshots gs
    JOIN turns t ON gs.turn_id = t.id
    ${hullFilter}
    ORDER BY t.started_at ASC
  `).all(...params) as Array<{
    agent: string;
    started_at: string;
    hull: number | null;
    hull_max: number | null;
    shield: number | null;
    shield_max: number | null;
  }>;

  return rows.map(r => ({
    agent: r.agent,
    timestamp: r.started_at,
    hull: r.hull,
    hullMax: r.hull_max,
    shield: r.shield,
    shieldMax: r.shield_max,
  }));
}

export function getAgentComparison(filter: TimeFilter): AgentComparisonEntry[] {
  const db = getDb();
  const { where, params } = buildTimeClause(filter);
  const whereWithoutOverseer = withoutOverseer(where, 't', filter);

  // Get per-agent turn stats
  const turnStats = db.prepare(`
    SELECT
      t.agent,
      COUNT(*) as turn_count,
      SUM(t.cost_usd) as total_cost,
      AVG(t.cost_usd) as avg_cost_per_turn,
      SUM(t.iterations) as total_iterations,
      AVG(t.duration_ms) as avg_duration_ms
    FROM turns t
    ${whereWithoutOverseer}
    GROUP BY t.agent
  `).all(...params) as Array<{
    agent: string;
    turn_count: number;
    total_cost: number;
    avg_cost_per_turn: number;
    total_iterations: number;
    avg_duration_ms: number;
  }>;

  const latestSnapshotStmt = db.prepare(`
    SELECT gs.credits
    FROM game_snapshots gs
    JOIN turns t ON gs.turn_id = t.id
    WHERE gs.agent = ? AND gs.credits IS NOT NULL
    ORDER BY t.started_at DESC
    LIMIT 1
  `);
  const earliestSnapshotStmt = db.prepare(`
    SELECT gs.credits
    FROM game_snapshots gs
    JOIN turns t ON gs.turn_id = t.id
    WHERE gs.agent = ? AND gs.credits IS NOT NULL
    ORDER BY t.started_at ASC
    LIMIT 1
  `);
  const proxyStateStmt = db.prepare(`
    SELECT state_json FROM proxy_game_state WHERE agent = ?
  `);

  return turnStats.map(ts => {
    const latestSnapshot = latestSnapshotStmt.get(ts.agent) as { credits: number } | undefined;
    const earliestSnapshot = earliestSnapshotStmt.get(ts.agent) as { credits: number } | undefined;

    // Fallback: use proxy_game_state (live cache) if game_snapshots has no credits
    let latestCredits = latestSnapshot?.credits ?? null;
    if (latestCredits === null) {
      const proxyState = proxyStateStmt.get(ts.agent) as { state_json: string } | undefined;
      if (proxyState?.state_json) {
        try {
          // state_json structure: { data: { player?: { credits? }, ... }, fetchedAt: number }
          const state = JSON.parse(proxyState.state_json) as { data?: Record<string, unknown> };
          const playerData = state?.data?.player as Record<string, unknown> | undefined;
          const creds = (playerData?.credits ?? state?.data?.credits) as number | null | undefined;
          if (typeof creds === 'number') latestCredits = creds;
        } catch {
          // ignore parse errors
        }
      }
    }

    const creditsChange = (latestSnapshot && earliestSnapshot)
      ? latestSnapshot.credits - earliestSnapshot.credits
      : 0;

    return {
      agent: ts.agent,
      turnCount: ts.turn_count,
      totalCost: ts.total_cost,
      avgCostPerTurn: ts.avg_cost_per_turn,
      totalIterations: ts.total_iterations,
      avgDurationMs: ts.avg_duration_ms,
      latestCredits,
      creditsChange,
    };
  });
}

export interface EconomicTransaction {
  id: number;
  agent: string;
  tool_name: string;
  args_json: string | null;
  result_summary: string | null;
  success: number;
  started_at: string;
}

// Tools that represent economic transactions
const ECONOMIC_TOOL_NAMES = [
  'sell', 'buy', 'multi_sell', 'commission_ship',
  'supply_commission', 'craft', 'buy_listed_ship',
];

export function getEconomicTransactions(filter: TimeFilter): EconomicTransaction[] {
  const db = getDb();
  const { where, params } = buildTimeClause(filter);

  const inList = ECONOMIC_TOOL_NAMES.map(() => '?').join(', ');
  const toolFilter = `tc.tool_name IN (${inList})`;

  const combinedWhere = where
    ? `${where} AND ${toolFilter}`
    : `WHERE ${toolFilter}`;

  const rows = db.prepare(`
    SELECT tc.id, t.agent, tc.tool_name, tc.args_json, tc.result_summary,
           tc.success, t.started_at
    FROM tool_calls tc
    JOIN turns t ON tc.turn_id = t.id
    ${combinedWhere}
    ORDER BY t.started_at DESC
    LIMIT 100
  `).all(...params, ...ECONOMIC_TOOL_NAMES) as EconomicTransaction[];

  return rows;
}

export function getTurnDetail(turnId: number): {
  turn: Record<string, unknown>;
  toolCalls: Record<string, unknown>[];
  gameSnapshot: Record<string, unknown> | null;
  prevSnapshot: Record<string, unknown> | null;
  prevId: number | null;
  nextId: number | null;
} | null {
  const db = getDb();

  const turn = db.prepare('SELECT * FROM turns WHERE id = ?').get(turnId) as Record<string, unknown> | undefined;
  if (!turn) return null;

  const toolCalls = db.prepare(
    'SELECT * FROM tool_calls WHERE turn_id = ? ORDER BY sequence_number ASC'
  ).all(turnId) as Record<string, unknown>[];

  const gameSnapshot = db.prepare(
    'SELECT * FROM game_snapshots WHERE turn_id = ?'
  ).get(turnId) as Record<string, unknown> | undefined ?? null;

  // Find the previous turn for this agent to get prevSnapshot
  let prevSnapshot: Record<string, unknown> | null = null;
  const prevTurn = db.prepare(`
    SELECT id FROM turns
    WHERE agent = ? AND started_at < ?
    ORDER BY started_at DESC
    LIMIT 1
  `).get(turn.agent as string, turn.started_at as string) as { id: number } | undefined;

  if (prevTurn) {
    prevSnapshot = db.prepare(
      'SELECT * FROM game_snapshots WHERE turn_id = ?'
    ).get(prevTurn.id) as Record<string, unknown> | undefined ?? null;
  }

  // Find next turn ID for this agent (prev already fetched above)
  const nextTurnNav = db.prepare(`
    SELECT id FROM turns
    WHERE agent = ? AND started_at > ?
    ORDER BY started_at ASC
    LIMIT 1
  `).get(turn.agent as string, turn.started_at as string) as { id: number } | undefined;

  return {
    turn,
    toolCalls,
    gameSnapshot,
    prevSnapshot,
    prevId: prevTurn?.id ?? null,
    nextId: nextTurnNav?.id ?? null,
  };
}

export function getAgentTurns(
  agent: string,
  filter: { hours?: number; limit?: number; offset?: number },
): { turns: Record<string, unknown>[]; total: number } {
  const db = getDb();
  const { where, params } = buildTimeClause({ hours: filter.hours, agent });

  const countRow = db.prepare(`SELECT COUNT(*) as total FROM turns t ${where}`).get(...params) as { total: number };

  const limit = filter.limit ?? 20;
  const offset = filter.offset ?? 0;

  const turns = db.prepare(`
    SELECT * FROM turns t
    ${where}
    ORDER BY t.started_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as Record<string, unknown>[];

  return { turns, total: countRow.total };
}

// ---------------------------------------------------------------------------
// Cost tracking: expensive turns + efficiency metrics
// ---------------------------------------------------------------------------

export interface ExpensiveTurn {
  id: number;
  agent: string;
  turnNumber: number;
  startedAt: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  iterations: number;
  durationMs: number;
  model: string | null;
  toolCallCount: number;
}

export function getExpensiveTurns(filter: TimeFilter & { limit?: number }): ExpensiveTurn[] {
  const db = getDb();
  const { where, params } = buildTimeClause(filter);
  const limit = filter.limit ?? 10;

  const rows = db.prepare(`
    SELECT
      t.id,
      t.agent,
      t.turn_number,
      t.started_at,
      t.cost_usd,
      t.input_tokens,
      t.output_tokens,
      t.cache_read_tokens,
      t.iterations,
      t.duration_ms,
      t.model,
      COUNT(tc.id) as tool_call_count
    FROM turns t
    LEFT JOIN tool_calls tc ON tc.turn_id = t.id
    ${where ? where + ' AND t.cost_usd IS NOT NULL' : 'WHERE t.cost_usd IS NOT NULL'}
    GROUP BY t.id
    ORDER BY t.cost_usd DESC
    LIMIT ?
  `).all(...params, limit) as Array<{
    id: number;
    agent: string;
    turn_number: number;
    started_at: string;
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    iterations: number;
    duration_ms: number;
    model: string | null;
    tool_call_count: number;
  }>;

  return rows.map(r => ({
    id: r.id,
    agent: r.agent,
    turnNumber: r.turn_number,
    startedAt: r.started_at,
    costUsd: r.cost_usd,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    iterations: r.iterations,
    durationMs: r.duration_ms,
    model: r.model,
    toolCallCount: r.tool_call_count,
  }));
}

export interface AgentEfficiencyEntry {
  agent: string;
  totalCost: number;
  avgCostPerTurn: number;
  avgInputTokensPerTurn: number;
  avgOutputTokensPerTurn: number;
  cacheHitRate: number;        // cache_read / (input + cache_read)
  estimatedCacheSavings: number; // (cache_read_tokens / 1M) * (3.00 - 0.30)
  creditsPerDollar: number | null;
}

export function getEfficiencyMetrics(filter: TimeFilter): AgentEfficiencyEntry[] {
  const db = getDb();
  const { where, params } = buildTimeClause(filter);
  const whereWithoutOverseer = withoutOverseer(where, 't', filter);

  const rows = db.prepare(`
    SELECT
      t.agent,
      SUM(t.cost_usd) as total_cost,
      AVG(t.cost_usd) as avg_cost_per_turn,
      AVG(t.input_tokens) as avg_input_tokens,
      AVG(t.output_tokens) as avg_output_tokens,
      SUM(t.cache_read_tokens) as total_cache_read,
      SUM(t.input_tokens) as total_input
    FROM turns t
    ${whereWithoutOverseer}
    GROUP BY t.agent
  `).all(...params) as Array<{
    agent: string;
    total_cost: number;
    avg_cost_per_turn: number;
    avg_input_tokens: number;
    avg_output_tokens: number;
    total_cache_read: number;
    total_input: number;
  }>;

  const creditsDeltaStmt = db.prepare(`
    SELECT
      (SELECT gs2.credits FROM game_snapshots gs2
       JOIN turns t2 ON gs2.turn_id = t2.id
       WHERE gs2.agent = ? AND gs2.credits IS NOT NULL
       ORDER BY t2.started_at DESC LIMIT 1) -
      (SELECT gs3.credits FROM game_snapshots gs3
       JOIN turns t3 ON gs3.turn_id = t3.id
       WHERE gs3.agent = ? AND gs3.credits IS NOT NULL
       ORDER BY t3.started_at ASC LIMIT 1) as credits_delta
  `);

  return rows.map(row => {
    const totalInput = row.total_input ?? 0;
    const totalCacheRead = row.total_cache_read ?? 0;
    const cacheHitRate = (totalInput + totalCacheRead) > 0
      ? totalCacheRead / (totalInput + totalCacheRead)
      : 0;
    // Cache reads cost $0.30/MTok vs $3.00/MTok fresh input — savings = diff
    const estimatedCacheSavings = (totalCacheRead / 1_000_000) * (3.00 - 0.30);

    // Credits per dollar: (last credits - first credits) / total cost
    const creditsResult = creditsDeltaStmt.get(row.agent, row.agent) as { credits_delta: number | null } | undefined;

    let creditsPerDollar: number | null = null;
    const totalCost = row.total_cost ?? 0;
    if (creditsResult?.credits_delta != null && totalCost > 0) {
      creditsPerDollar = creditsResult.credits_delta / totalCost;
    }

    return {
      agent: row.agent,
      totalCost,
      avgCostPerTurn: row.avg_cost_per_turn ?? 0,
      avgInputTokensPerTurn: row.avg_input_tokens ?? 0,
      avgOutputTokensPerTurn: row.avg_output_tokens ?? 0,
      cacheHitRate,
      estimatedCacheSavings,
      creditsPerDollar,
    };
  });
}

// ---------------------------------------------------------------------------
// P&L Summary — per-agent profit/loss with top items
// ---------------------------------------------------------------------------

export interface PnlSummary {
  agent: string;
  totalEarned: number;
  totalSpent: number;
  netPnl: number;
  actionCount: number;
}

export interface PnlTopItem {
  item: string;
  totalCredits: number;
  quantity: number;
}

export interface PnlResponse {
  agents: PnlSummary[];
  fleetTotals: { earned: number; spent: number; net: number };
  topRevenue: PnlTopItem[];
  topCosts: PnlTopItem[];
}

export function getPnlSummary(filter: TimeFilter): PnlResponse {
  const db = getDb();

  const clauses: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (filter.hours != null && filter.hours > 0) {
    clauses.push(`datetime(created_at) >= datetime('now', ?)`);
    params.push(`-${filter.hours} hours`);
  }
  if (filter.agent) {
    clauses.push(`agent = ?`);
    params.push(filter.agent);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  const agents = db.prepare(`
    SELECT
      agent,
      SUM(CASE WHEN credits_delta > 0 THEN credits_delta ELSE 0 END) AS total_earned,
      SUM(CASE WHEN credits_delta < 0 THEN ABS(credits_delta) ELSE 0 END) AS total_spent,
      SUM(COALESCE(credits_delta, 0)) AS net_pnl,
      COUNT(*) AS action_count
    FROM agent_action_log ${where}
    GROUP BY agent
    ORDER BY net_pnl DESC
  `).all(...params) as Array<{
    agent: string; total_earned: number; total_spent: number; net_pnl: number; action_count: number;
  }>;

  const topRevenue = db.prepare(`
    SELECT item, SUM(credits_delta) AS total_credits, SUM(quantity) AS quantity
    FROM agent_action_log
    ${where ? where + ' AND credits_delta > 0 AND item IS NOT NULL' : 'WHERE credits_delta > 0 AND item IS NOT NULL'}
    GROUP BY item ORDER BY total_credits DESC LIMIT 10
  `).all(...params) as Array<{ item: string; total_credits: number; quantity: number }>;

  const topCosts = db.prepare(`
    SELECT item, SUM(ABS(credits_delta)) AS total_credits, SUM(quantity) AS quantity
    FROM agent_action_log
    ${where ? where + ' AND credits_delta < 0 AND item IS NOT NULL' : 'WHERE credits_delta < 0 AND item IS NOT NULL'}
    GROUP BY item ORDER BY total_credits DESC LIMIT 10
  `).all(...params) as Array<{ item: string; total_credits: number; quantity: number }>;

  let earned = 0, spent = 0, net = 0;
  for (const a of agents) { earned += a.total_earned; spent += a.total_spent; net += a.net_pnl; }

  return {
    agents: agents.map(a => ({
      agent: a.agent, totalEarned: a.total_earned, totalSpent: a.total_spent,
      netPnl: a.net_pnl, actionCount: a.action_count,
    })),
    fleetTotals: { earned, spent, net },
    topRevenue: topRevenue.map(r => ({ item: r.item, totalCredits: r.total_credits, quantity: r.quantity })),
    topCosts: topCosts.map(r => ({ item: r.item, totalCredits: r.total_credits, quantity: r.quantity })),
  };
}

// ---------------------------------------------------------------------------
// Model Cost Comparison — cost/efficiency grouped by model
// ---------------------------------------------------------------------------

export interface ModelCostEntry {
  model: string;
  turnCount: number;
  totalCost: number;
  avgCostPerTurn: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  totalHours: number;
  costPerHour: number;
  outputTokensPerDollar: number | null;
}

export function getModelCostComparison(filter: TimeFilter): ModelCostEntry[] {
  const db = getDb();
  const { where, params } = buildTimeClause(filter);

  const modelFilter = where
    ? `${where} AND t.model IS NOT NULL AND t.model != ''`
    : "WHERE t.model IS NOT NULL AND t.model != ''";

  const rows = db.prepare(`
    SELECT
      t.model,
      COUNT(*) as turn_count,
      SUM(t.cost_usd) as total_cost,
      AVG(t.cost_usd) as avg_cost_per_turn,
      AVG(t.input_tokens) as avg_input_tokens,
      AVG(t.output_tokens) as avg_output_tokens,
      SUM(t.output_tokens) as total_output_tokens,
      MIN(t.started_at) as first_turn,
      MAX(t.started_at) as last_turn
    FROM turns t
    ${modelFilter}
    GROUP BY t.model
    ORDER BY total_cost DESC
  `).all(...params) as Array<{
    model: string; turn_count: number; total_cost: number; avg_cost_per_turn: number;
    avg_input_tokens: number; avg_output_tokens: number; total_output_tokens: number;
    first_turn: string; last_turn: string;
  }>;

  return rows.map(r => {
    const elapsedMs = new Date(r.last_turn).getTime() - new Date(r.first_turn).getTime();
    const totalHours = elapsedMs / 3_600_000;
    const totalCost = r.total_cost ?? 0;
    // Only compute $/hour when there's at least 5 minutes of data and 2+ turns;
    // otherwise the rate is meaninglessly inflated
    const minHoursForRate = 5 / 60; // 5 minutes
    const hasEnoughData = totalHours >= minHoursForRate && r.turn_count >= 2;
    return {
      model: r.model,
      turnCount: r.turn_count,
      totalCost,
      avgCostPerTurn: r.avg_cost_per_turn ?? 0,
      avgInputTokens: Math.round(r.avg_input_tokens ?? 0),
      avgOutputTokens: Math.round(r.avg_output_tokens ?? 0),
      totalHours: Math.round(Math.max(totalHours, 0.1) * 10) / 10,
      costPerHour: hasEnoughData ? totalCost / totalHours : 0,
      outputTokensPerDollar: totalCost > 0 ? (r.total_output_tokens ?? 0) / totalCost : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Session P&L — per-session profit/loss derived from session_handoffs
// ---------------------------------------------------------------------------

export interface SessionPnlBreakdown {
  actionType: string;
  totalDelta: number;
  count: number;
}

export interface SessionPnl {
  agent: string;
  sessionStart: string;
  sessionEnd: string;
  creditsStart: number;
  creditsEnd: number;
  creditsDelta: number;
  breakdown: SessionPnlBreakdown[];
  location: string;
}

export function getSessionPnl(agentName?: string, limit = 20): SessionPnl[] {
  const db = getDb();

  // Pull handoff records ordered per agent, newest first
  const agentClause = agentName ? 'WHERE agent = ?' : '';
  const agentParams: SQLQueryBindings[] = agentName ? [agentName] : [];

  const handoffs = db.prepare(`
    SELECT id, agent, credits, location_system, created_at
    FROM session_handoffs
    ${agentClause}
    ORDER BY agent ASC, created_at ASC
  `).all(...agentParams) as Array<{
    id: number;
    agent: string;
    credits: number | null;
    location_system: string | null;
    created_at: string;
  }>;

  // Group consecutive pairs per agent into sessions
  const sessions: SessionPnl[] = [];

  // Group by agent
  const byAgent: Record<string, typeof handoffs> = {};
  for (const h of handoffs) {
    if (!byAgent[h.agent]) byAgent[h.agent] = [];
    byAgent[h.agent].push(h);
  }

  for (const [agent, agentHandoffs] of Object.entries(byAgent)) {
    // Need at least 2 handoffs to form a session
    if (agentHandoffs.length < 2) continue;

    // Walk pairs: [i, i+1] — i is the "start" handoff, i+1 is the "end"
    for (let i = agentHandoffs.length - 1; i >= 1; i--) {
      const start = agentHandoffs[i - 1];
      const end = agentHandoffs[i];

      const creditsStart = start.credits ?? 0;
      const creditsEnd = end.credits ?? 0;
      const creditsDelta = creditsEnd - creditsStart;

      // Sum agent_action_log within the session window, grouped by action_type
      const breakdown = db.prepare(`
        SELECT action_type, SUM(COALESCE(credits_delta, 0)) AS total_delta, COUNT(*) AS count
        FROM agent_action_log
        WHERE agent = ?
          AND datetime(created_at) > datetime(?)
          AND datetime(created_at) <= datetime(?)
        GROUP BY action_type
        ORDER BY total_delta DESC
      `).all(agent, start.created_at, end.created_at) as Array<{
        action_type: string;
        total_delta: number;
        count: number;
      }>;

      sessions.push({
        agent,
        sessionStart: start.created_at,
        sessionEnd: end.created_at,
        creditsStart,
        creditsEnd,
        creditsDelta,
        breakdown: breakdown.map(b => ({
          actionType: b.action_type,
          totalDelta: b.total_delta,
          count: b.count,
        })),
        location: end.location_system ?? '',
      });

      if (sessions.length >= limit) break;
    }

    if (sessions.length >= limit) break;
  }

  // Sort by sessionEnd descending (most recent first) and apply limit
  sessions.sort((a, b) => b.sessionEnd.localeCompare(a.sessionEnd));
  return sessions.slice(0, limit);
}

// ---------------------------------------------------------------------------
// System POIs — distinct POIs seen per system from game_snapshots
// ---------------------------------------------------------------------------

/**
 * Returns distinct POIs grouped by system, ordered by visit count desc.
 * Result: Record<systemId, string[]> — list of POI names seen in that system.
 * Pass systemId to filter to a single system.
 */
export function getSystemPois(systemId?: string): Record<string, string[]> {
  const db = getDb();

  // Primary source: galaxy_pois table (complete POI lists from get_system responses)
  const poiWhere = systemId ? "WHERE system = ?" : "";
  const poiParams: SQLQueryBindings[] = systemId ? [systemId] : [];
  const poiRows = db.prepare(`
    SELECT system, name FROM galaxy_pois ${poiWhere} ORDER BY system, name
  `).all(...poiParams) as Array<{ system: string; name: string }>;

  const result: Record<string, string[]> = {};
  for (const row of poiRows) {
    if (!result[row.system]) result[row.system] = [];
    if (!result[row.system].includes(row.name)) result[row.system].push(row.name);
  }

  // Fallback: merge in POIs from game_snapshots that might not be in galaxy_pois
  // (e.g., visited POIs whose system wasn't queried via get_system)
  const snapWhere = systemId
    ? "WHERE poi IS NOT NULL AND poi != '' AND system = ?"
    : "WHERE poi IS NOT NULL AND poi != ''";
  const snapParams: SQLQueryBindings[] = systemId ? [systemId] : [];
  const snapRows = db.prepare(`
    SELECT DISTINCT system, poi FROM game_snapshots ${snapWhere} ORDER BY system
  `).all(...snapParams) as Array<{ system: string; poi: string }>;

  for (const row of snapRows) {
    if (!result[row.system]) result[row.system] = [];
    if (!result[row.system].includes(row.poi)) result[row.system].push(row.poi);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Explored Systems — distinct systems from game_snapshots
// ---------------------------------------------------------------------------

/**
 * Returns the set of system IDs that any agent has visited (appeared in game_snapshots).
 * Used for fog-of-war overlay on the galaxy map.
 */
export function getExploredSystems(): string[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT DISTINCT system FROM game_snapshots
    WHERE system IS NOT NULL AND system != ''
  `).all() as Array<{ system: string }>;
  return rows.map(r => r.system);
}

// ---------------------------------------------------------------------------
// Agent Trails — recent system history per agent
// ---------------------------------------------------------------------------

export interface AgentTrail {
  agent: string;
  systems: string[];
}

/**
 * Returns last `limit` distinct systems visited per agent within `hours` hours.
 * Systems are ordered most-recent first.
 */
export function getAgentTrails(hours = 24, limit = 10): AgentTrail[] {
  const safeHours = Math.max(1, Math.min(8760, Number(hours) || 24));
  const db = getDb();
  const rows = db.prepare(`
    SELECT gs.agent, gs.system, MAX(t.started_at) as last_seen
    FROM game_snapshots gs
    JOIN turns t ON gs.turn_id = t.id
    WHERE datetime(t.started_at) >= datetime('now', '-' || ? || ' hours')
      AND gs.system IS NOT NULL AND gs.system != ''
    GROUP BY gs.agent, gs.system
    ORDER BY gs.agent, last_seen DESC
  `).all(safeHours) as Array<{ agent: string; system: string; last_seen: string }>;

  const byAgent: Record<string, string[]> = {};
  for (const row of rows) {
    if (!byAgent[row.agent]) byAgent[row.agent] = [];
    if (byAgent[row.agent].length < limit) {
      byAgent[row.agent].push(row.system);
    }
  }

  return Object.entries(byAgent).map(([agent, systems]) => ({ agent, systems }));
}
