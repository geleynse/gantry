import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createDatabase, getDb, closeDb } from './database.js';
import {
  getCostOverTime,
  getToolFrequency,
  getCreditsOverTime,
  getAgentComparison,
  getTurnDetail,
  getAgentTurns,
  getExpensiveTurns,
  getEfficiencyMetrics,
  getSessionPnl,
  getExploredSystems,
  getPnlSummary,
  getAgentTrails,
} from './analytics-query.js';

function insertTurn(agent: string, turnNumber: number, startedAt: string, opts: {
  completedAt?: string;
  durationMs?: number;
  cost?: number;
  inputTokens?: number;
  outputTokens?: number;
  iterations?: number;
  model?: string;
} = {}): number {
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO turns (agent, turn_number, started_at, completed_at, duration_ms,
      cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens,
      iterations, model, error_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    agent,
    turnNumber,
    startedAt,
    opts.completedAt ?? null,
    opts.durationMs ?? 60000,
    opts.cost ?? 0.10,
    opts.inputTokens ?? 5000,
    opts.outputTokens ?? 2000,
    0, 0,
    opts.iterations ?? 3,
    opts.model ?? 'claude-opus-4',
    null,
  );
  return Number(info.lastInsertRowid);
}

function insertToolCall(turnId: number, seq: number, toolName: string, success: boolean = true): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO tool_calls (turn_id, sequence_number, tool_name, args_json, result_summary, duration_ms, success)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(turnId, seq, toolName, '{}', 'ok', 100, success ? 1 : 0);
}

function insertActionLog(agent: string, actionType: string, creditsDelta: number, createdAt: string, item?: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO agent_action_log (agent, action_type, credits_delta, item, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(agent, actionType, creditsDelta, item ?? null, createdAt);
}

function insertSnapshot(turnId: number, agent: string, opts: {
  credits?: number;
  system?: string;
  poi?: string;
} = {}): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO game_snapshots (turn_id, agent, credits, fuel, fuel_max, cargo_used, cargo_max, system, poi, docked)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(turnId, agent, opts.credits ?? 10000, 80, 100, 20, 60, opts.system ?? 'Sol', opts.poi ?? 'Earth', 1);
}

describe('analytics-query', () => {
  beforeEach(() => {
    createDatabase(':memory:');
  });

  afterEach(() => {
    closeDb();
  });

  describe('getCostOverTime', () => {
    it('returns per-turn data for multiple agents', () => {
      insertTurn('drifter-gale', 1, '2026-02-15T10:00:00Z', { cost: 0.10, iterations: 2, durationMs: 30000, inputTokens: 3000, outputTokens: 1000 });
      insertTurn('drifter-gale', 2, '2026-02-15T10:05:00Z', { cost: 0.20, iterations: 4, durationMs: 60000, inputTokens: 6000, outputTokens: 2000 });
      insertTurn('sable-thorn', 1, '2026-02-15T10:02:00Z', { cost: 0.05, iterations: 1, durationMs: 15000, inputTokens: 1000, outputTokens: 500 });

      const data = getCostOverTime({});
      expect(data).toHaveLength(3);
      expect(data[0].agent).toBe('drifter-gale');
      expect(data[0].cost).toBeCloseTo(0.10);
      expect(data[0].iterations).toBe(2);
      expect(data[0].durationMs).toBe(30000);
      expect(data[0].inputTokens).toBe(3000);
      expect(data[0].outputTokens).toBe(1000);
    });

    it('filters by agent', () => {
      insertTurn('drifter-gale', 1, '2026-02-15T10:00:00Z');
      insertTurn('sable-thorn', 1, '2026-02-15T10:02:00Z');

      const data = getCostOverTime({ agent: 'sable-thorn' });
      expect(data).toHaveLength(1);
      expect(data[0].agent).toBe('sable-thorn');
    });

    it('filters by hours', () => {
      const now = new Date();
      const recent = new Date(now.getTime() - 30 * 60 * 1000).toISOString(); // 30 min ago
      const old = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString(); // 48h ago

      insertTurn('drifter-gale', 1, recent);
      insertTurn('drifter-gale', 2, old);

      const data = getCostOverTime({ hours: 1 });
      expect(data).toHaveLength(1);
    });

    it('filters by 1 hour for recent data with fractional seconds', () => {
      const now = new Date();
      const recentWithFraction = new Date(now.getTime() - 5 * 60 * 1000).toISOString(); // 5 min ago (has .123Z)
      const oldWithFraction = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString(); // 48h ago

      insertTurn('drifter-gale', 1, recentWithFraction, { cost: 0.10 });
      insertTurn('drifter-gale', 2, oldWithFraction, { cost: 0.20 });

      const data = getCostOverTime({ hours: 1 });
      expect(data).toHaveLength(1);
      expect(data[0].cost).toBeCloseTo(0.10); // Should get the recent one, not the old one
    });

    it('filters by 6 hour range correctly', () => {
      const now = new Date();
      const within6h = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString(); // 3h ago
      const outside6h = new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString(); // 12h ago

      insertTurn('sable-thorn', 1, within6h, { cost: 0.15 });
      insertTurn('sable-thorn', 2, outside6h, { cost: 0.25 });

      const data = getCostOverTime({ hours: 6 });
      expect(data).toHaveLength(1);
      expect(data[0].cost).toBeCloseTo(0.15);
    });

    it('filters by 24 hour range correctly', () => {
      const now = new Date();
      const within24h = new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString(); // 12h ago
      const outside24h = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString(); // 48h ago

      insertTurn('rust-vane', 1, within24h, { cost: 0.12 });
      insertTurn('rust-vane', 2, outside24h, { cost: 0.22 });

      const data = getCostOverTime({ hours: 24 });
      expect(data).toHaveLength(1);
      expect(data[0].cost).toBeCloseTo(0.12);
    });
  });

  describe('getToolFrequency', () => {
    it('counts tool usage correctly', () => {
      const t1 = insertTurn('drifter-gale', 1, '2026-02-15T10:00:00Z');
      insertToolCall(t1, 1, 'Bash', true);
      insertToolCall(t1, 2, 'Bash', true);
      insertToolCall(t1, 3, 'Read', true);
      insertToolCall(t1, 4, 'Read', false);

      const data = getToolFrequency({});
      expect(data).toHaveLength(2);

      const bash = data.find(d => d.toolName === 'Bash');
      expect(bash).toBeDefined();
      expect(bash!.count).toBe(2);
      expect(bash!.avgSuccess).toBeCloseTo(1.0);

      const read = data.find(d => d.toolName === 'Read');
      expect(read).toBeDefined();
      expect(read!.count).toBe(2);
      expect(read!.avgSuccess).toBeCloseTo(0.5);
    });

    it('filters by agent', () => {
      const t1 = insertTurn('drifter-gale', 1, '2026-02-15T10:00:00Z');
      const t2 = insertTurn('sable-thorn', 1, '2026-02-15T10:01:00Z');
      insertToolCall(t1, 1, 'Bash');
      insertToolCall(t2, 1, 'Write');

      const data = getToolFrequency({ agent: 'drifter-gale' });
      expect(data).toHaveLength(1);
      expect(data[0].toolName).toBe('Bash');
    });
  });

  describe('getCreditsOverTime', () => {
    it('returns credit history', () => {
      const t1 = insertTurn('drifter-gale', 1, '2026-02-15T10:00:00Z');
      const t2 = insertTurn('drifter-gale', 2, '2026-02-15T10:05:00Z');
      insertSnapshot(t1, 'drifter-gale', { credits: 10000, system: 'Sol', poi: 'Earth' });
      insertSnapshot(t2, 'drifter-gale', { credits: 12000, system: 'Alpha', poi: 'Station' });

      const data = getCreditsOverTime({});
      expect(data).toHaveLength(2);
      expect(data[0].credits).toBe(10000);
      expect(data[0].system).toBe('Sol');
      expect(data[0].poi).toBe('Earth');
      expect(data[1].credits).toBe(12000);
    });

    it('filters by agent', () => {
      const t1 = insertTurn('drifter-gale', 1, '2026-02-15T10:00:00Z');
      const t2 = insertTurn('sable-thorn', 1, '2026-02-15T10:01:00Z');
      insertSnapshot(t1, 'drifter-gale', { credits: 10000 });
      insertSnapshot(t2, 'sable-thorn', { credits: 5000 });

      const data = getCreditsOverTime({ agent: 'sable-thorn' });
      expect(data).toHaveLength(1);
      expect(data[0].credits).toBe(5000);
    });
  });

  describe('getAgentComparison', () => {
    it('returns per-agent summary', () => {
      insertTurn('drifter-gale', 1, '2026-02-15T10:00:00Z', { cost: 0.10, iterations: 2, durationMs: 30000 });
      insertTurn('drifter-gale', 2, '2026-02-15T10:05:00Z', { cost: 0.20, iterations: 4, durationMs: 60000 });
      insertTurn('sable-thorn', 1, '2026-02-15T10:02:00Z', { cost: 0.05, iterations: 1, durationMs: 15000 });

      const t1 = getDb().prepare('SELECT id FROM turns WHERE agent = ? ORDER BY turn_number LIMIT 1').get('drifter-gale') as { id: number };
      const t2 = getDb().prepare('SELECT id FROM turns WHERE agent = ? ORDER BY turn_number DESC LIMIT 1').get('drifter-gale') as { id: number };
      const t3 = getDb().prepare('SELECT id FROM turns WHERE agent = ?').get('sable-thorn') as { id: number };
      insertSnapshot(t1.id, 'drifter-gale', { credits: 10000 });
      insertSnapshot(t2.id, 'drifter-gale', { credits: 12000 });
      insertSnapshot(t3.id, 'sable-thorn', { credits: 5000 });

      const data = getAgentComparison({});
      expect(data).toHaveLength(2);

      const dg = data.find(d => d.agent === 'drifter-gale');
      expect(dg).toBeDefined();
      expect(dg!.turnCount).toBe(2);
      expect(dg!.totalCost).toBeCloseTo(0.30);
      expect(dg!.avgCostPerTurn).toBeCloseTo(0.15);
      expect(dg!.totalIterations).toBe(6);
      expect(dg!.avgDurationMs).toBe(45000);
      expect(dg!.latestCredits).toBe(12000);
      expect(dg!.creditsChange).toBe(2000);

      const st = data.find(d => d.agent === 'sable-thorn');
      expect(st).toBeDefined();
      expect(st!.turnCount).toBe(1);
      expect(st!.totalCost).toBeCloseTo(0.05);
      expect(st!.creditsChange).toBe(0); // only one snapshot
    });
  });

  describe('getTurnDetail', () => {
    it('returns turn with tool calls and snapshots', () => {
      const t1 = insertTurn('drifter-gale', 1, '2026-02-15T10:00:00Z');
      const t2 = insertTurn('drifter-gale', 2, '2026-02-15T10:05:00Z');
      insertToolCall(t2, 1, 'Bash');
      insertToolCall(t2, 2, 'Read');
      insertSnapshot(t1, 'drifter-gale', { credits: 10000 });
      insertSnapshot(t2, 'drifter-gale', { credits: 12000 });

      const detail = getTurnDetail(t2);
      expect(detail).not.toBeNull();
      expect(detail!.turn.agent).toBe('drifter-gale');
      expect(detail!.toolCalls).toHaveLength(2);
      expect(detail!.gameSnapshot).toBeDefined();
      expect(detail!.gameSnapshot!.credits).toBe(12000);
      expect(detail!.prevSnapshot).toBeDefined();
      expect(detail!.prevSnapshot!.credits).toBe(10000);
    });

    it('returns null for non-existent turn', () => {
      expect(getTurnDetail(999)).toBeNull();
    });
  });

  describe('getAgentTurns', () => {
    it('returns paginated turn list', () => {
      for (let i = 1; i <= 5; i++) {
        insertTurn('drifter-gale', i, `2026-02-15T10:0${i}:00Z`);
      }

      const result = getAgentTurns('drifter-gale', { limit: 2, offset: 0 });
      expect(result.total).toBe(5);
      expect(result.turns).toHaveLength(2);
      // Should be ordered by started_at DESC (most recent first)
      expect(result.turns[0].turn_number).toBe(5);
    });

    it('respects offset', () => {
      for (let i = 1; i <= 5; i++) {
        insertTurn('drifter-gale', i, `2026-02-15T10:0${i}:00Z`);
      }

      const result = getAgentTurns('drifter-gale', { limit: 2, offset: 2 });
      expect(result.total).toBe(5);
      expect(result.turns).toHaveLength(2);
      expect(result.turns[0].turn_number).toBe(3);
    });

    it('filters by hours', () => {
      const now = new Date();
      const recent = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
      const old = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();

      insertTurn('drifter-gale', 1, recent);
      insertTurn('drifter-gale', 2, old);

      const result = getAgentTurns('drifter-gale', { hours: 1, limit: 10, offset: 0 });
      expect(result.total).toBe(1);
      expect(result.turns).toHaveLength(1);
    });
  });

  describe('getExpensiveTurns', () => {
    it('returns turns ordered by cost descending', () => {
      insertTurn('drifter-gale', 1, '2026-02-15T10:00:00Z', { cost: 0.05 });
      insertTurn('drifter-gale', 2, '2026-02-15T10:05:00Z', { cost: 0.20 });
      insertTurn('sable-thorn', 1, '2026-02-15T10:02:00Z', { cost: 0.10 });

      const data = getExpensiveTurns({});
      expect(data.length).toBeGreaterThanOrEqual(3);
      expect(data[0].costUsd).toBeGreaterThanOrEqual(data[1].costUsd);
      expect(data[1].costUsd).toBeGreaterThanOrEqual(data[2].costUsd);
    });

    it('respects limit parameter', () => {
      for (let i = 1; i <= 5; i++) {
        insertTurn('drifter-gale', i, `2026-02-15T10:0${i}:00Z`, { cost: i * 0.01 });
      }

      const data = getExpensiveTurns({ limit: 2 });
      expect(data).toHaveLength(2);
    });

    it('filters by agent', () => {
      insertTurn('drifter-gale', 1, '2026-02-15T10:00:00Z', { cost: 0.15 });
      insertTurn('sable-thorn', 1, '2026-02-15T10:01:00Z', { cost: 0.25 });

      const data = getExpensiveTurns({ agent: 'sable-thorn' });
      expect(data).toHaveLength(1);
      expect(data[0].agent).toBe('sable-thorn');
    });

    it('filters by hours', () => {
      const now = new Date();
      const recent = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
      const old = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();

      insertTurn('drifter-gale', 1, recent, { cost: 0.10 });
      insertTurn('drifter-gale', 2, old, { cost: 0.20 });

      const data = getExpensiveTurns({ hours: 1 });
      expect(data).toHaveLength(1);
      expect(data[0].costUsd).toBeCloseTo(0.10);
    });

    it('excludes turns with NULL cost_usd', () => {
      const db = getDb();
      // Insert a turn with no cost
      db.prepare(`
        INSERT INTO turns (agent, turn_number, started_at, cost_usd)
        VALUES (?, ?, ?, ?)
      `).run('drifter-gale', 1, '2026-02-15T10:00:00Z', null);
      insertTurn('drifter-gale', 2, '2026-02-15T10:05:00Z', { cost: 0.10 });

      const data = getExpensiveTurns({});
      expect(data.every(t => t.costUsd != null)).toBe(true);
      expect(data).toHaveLength(1);
    });

    it('includes toolCallCount', () => {
      const t1 = insertTurn('drifter-gale', 1, '2026-02-15T10:00:00Z', { cost: 0.10 });
      insertToolCall(t1, 1, 'Bash');
      insertToolCall(t1, 2, 'Read');

      const data = getExpensiveTurns({});
      expect(data).toHaveLength(1);
      expect(data[0].toolCallCount).toBe(2);
    });
  });

  describe('getSessionPnl', () => {
    function insertHandoff(agent: string, credits: number, createdAt: string, system = 'Sol'): void {
      const db = getDb();
      db.prepare(`
        INSERT INTO session_handoffs (agent, credits, location_system, created_at)
        VALUES (?, ?, ?, ?)
      `).run(agent, credits, system, createdAt);
    }

    function insertActionLog(agent: string, actionType: string, creditsDelta: number, createdAt: string): void {
      const db = getDb();
      db.prepare(`
        INSERT INTO agent_action_log (agent, action_type, credits_delta, created_at)
        VALUES (?, ?, ?, ?)
      `).run(agent, actionType, creditsDelta, createdAt);
    }

    it('returns empty array for agent with 0 handoffs', () => {
      // No handoffs seeded — must not crash
      const result = getSessionPnl('drifter-gale');
      expect(result).toEqual([]);
    });

    it('returns empty array for agent with only 1 handoff', () => {
      insertHandoff('drifter-gale', 10000, '2026-03-01T10:00:00Z');
      const result = getSessionPnl('drifter-gale');
      expect(result).toEqual([]);
    });

    it('returns one session from two handoffs', () => {
      insertHandoff('drifter-gale', 10000, '2026-03-01T10:00:00Z', 'Sol');
      insertHandoff('drifter-gale', 13500, '2026-03-01T12:00:00Z', 'Vega');

      const result = getSessionPnl('drifter-gale');
      expect(result).toHaveLength(1);

      const session = result[0];
      expect(session.agent).toBe('drifter-gale');
      expect(session.creditsStart).toBe(10000);
      expect(session.creditsEnd).toBe(13500);
      expect(session.creditsDelta).toBe(3500);
      expect(session.location).toBe('Vega');
      expect(session.sessionStart).toBe('2026-03-01T10:00:00Z');
      expect(session.sessionEnd).toBe('2026-03-01T12:00:00Z');
    });

    it('includes action breakdown for the session window', () => {
      // NOTE: session_handoffs.created_at and agent_action_log.created_at are
      // never set explicitly by application code (see handoff.ts /
      // action-log-parser.ts) — both always take the schema default
      // `datetime('now')`, i.e. SQLite's own canonical "YYYY-MM-DD HH:MM:SS"
      // format (space separator, no 'T', no fractional seconds, no 'Z').
      // Using that real format here (not a JS toISOString() string) matters:
      // getSessionPnl's breakdown query compares the bare `created_at` column
      // against `datetime(?)`-normalized bounds to let SQLite use
      // idx_action_log_time — which is only correct when the column is
      // already in datetime()'s own canonical format (see analytics-query.ts
      // comments on breakdownStmt / isoHoursAgo for the format trap this
      // guards against).
      insertHandoff('drifter-gale', 10000, '2026-03-01 10:00:00');
      insertHandoff('drifter-gale', 13500, '2026-03-01 12:00:00');

      // Actions inside the window
      insertActionLog('drifter-gale', 'sell', 2000, '2026-03-01 10:30:00');
      insertActionLog('drifter-gale', 'sell', 1500, '2026-03-01 11:00:00');
      insertActionLog('drifter-gale', 'buy', -500, '2026-03-01 11:30:00');
      // Action outside the window (before sessionStart) — should be excluded
      insertActionLog('drifter-gale', 'sell', 9999, '2026-03-01 09:00:00');

      const result = getSessionPnl('drifter-gale');
      expect(result).toHaveLength(1);

      const { breakdown } = result[0];
      const sell = breakdown.find((b) => b.actionType === 'sell');
      const buy = breakdown.find((b) => b.actionType === 'buy');

      expect(sell).toBeDefined();
      expect(sell!.count).toBe(2);
      expect(sell!.totalDelta).toBe(3500);

      expect(buy).toBeDefined();
      expect(buy!.count).toBe(1);
      expect(buy!.totalDelta).toBe(-500);
    });

    it('returns multiple sessions for one agent with 3 handoffs', () => {
      insertHandoff('sable-thorn', 5000, '2026-03-01T08:00:00Z');
      insertHandoff('sable-thorn', 7000, '2026-03-01T10:00:00Z');
      insertHandoff('sable-thorn', 6500, '2026-03-01T12:00:00Z');

      const result = getSessionPnl('sable-thorn');
      expect(result).toHaveLength(2);

      // Results sorted newest-first
      const newest = result[0];
      expect(newest.sessionEnd).toBe('2026-03-01T12:00:00Z');
      expect(newest.creditsDelta).toBe(-500); // 6500 - 7000

      const older = result[1];
      expect(older.sessionEnd).toBe('2026-03-01T10:00:00Z');
      expect(older.creditsDelta).toBe(2000); // 7000 - 5000
    });

    it('filters by agent', () => {
      insertHandoff('drifter-gale', 1000, '2026-03-01T10:00:00Z');
      insertHandoff('drifter-gale', 2000, '2026-03-01T12:00:00Z');
      insertHandoff('sable-thorn', 500, '2026-03-01T10:00:00Z');
      insertHandoff('sable-thorn', 600, '2026-03-01T12:00:00Z');

      const result = getSessionPnl('drifter-gale');
      expect(result.every((s) => s.agent === 'drifter-gale')).toBe(true);
    });

    it('respects limit parameter', () => {
      // Create 5 handoffs → 4 sessions
      for (let i = 0; i < 5; i++) {
        insertHandoff('rust-vane', i * 1000, `2026-03-01T${(10 + i).toString().padStart(2, '0')}:00:00Z`);
      }

      const result = getSessionPnl('rust-vane', 2);
      expect(result).toHaveLength(2);
    });

    it('handles NULL credits in handoffs gracefully', () => {
      const db = getDb();
      db.prepare(`
        INSERT INTO session_handoffs (agent, credits, location_system, created_at)
        VALUES (?, NULL, ?, ?)
      `).run('ember-drift', 'Sol', '2026-03-01T10:00:00Z');
      db.prepare(`
        INSERT INTO session_handoffs (agent, credits, location_system, created_at)
        VALUES (?, ?, ?, ?)
      `).run('ember-drift', 5000, 'Vega', '2026-03-01T12:00:00Z');

      const result = getSessionPnl('ember-drift');
      expect(result).toHaveLength(1);
      expect(result[0].creditsStart).toBe(0); // NULL → 0
      expect(result[0].creditsEnd).toBe(5000);
      expect(result[0].creditsDelta).toBe(5000);
    });

    it('returns all agents when no agent filter given', () => {
      insertHandoff('drifter-gale', 1000, '2026-03-01T10:00:00Z');
      insertHandoff('drifter-gale', 2000, '2026-03-01T11:00:00Z');
      insertHandoff('sable-thorn', 500, '2026-03-01T10:00:00Z');
      insertHandoff('sable-thorn', 600, '2026-03-01T11:00:00Z');

      const result = getSessionPnl();
      const agents = new Set(result.map((s) => s.agent));
      expect(agents.has('drifter-gale')).toBe(true);
      expect(agents.has('sable-thorn')).toBe(true);
    });
  });

  describe('getEfficiencyMetrics', () => {
    it('computes cache hit rate correctly', () => {
      const db = getDb();
      // Insert a turn with known token counts
      db.prepare(`
        INSERT INTO turns (agent, turn_number, started_at, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, iterations, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('drifter-gale', 1, '2026-02-15T10:00:00Z', 0.05, 10000, 1000, 5000, 0, 3, 30000);

      const data = getEfficiencyMetrics({});
      const agent = data.find(d => d.agent === 'drifter-gale');
      expect(agent).toBeDefined();
      // cacheHitRate = 5000 / (10000 + 5000) ≈ 0.333
      expect(agent!.cacheHitRate).toBeCloseTo(5000 / 15000, 3);
    });

    it('returns 0 cache hit rate when no cache data', () => {
      const db = getDb();
      db.prepare(`
        INSERT INTO turns (agent, turn_number, started_at, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, iterations, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('sable-thorn', 1, '2026-02-15T10:00:00Z', 0.03, 5000, 800, 0, 0, 2, 20000);

      const data = getEfficiencyMetrics({});
      const agent = data.find(d => d.agent === 'sable-thorn');
      expect(agent).toBeDefined();
      expect(agent!.cacheHitRate).toBe(0);
    });

    it('estimates cache savings correctly', () => {
      const db = getDb();
      // 1M cache read tokens → savings = (3.00 - 0.30) = $2.70
      db.prepare(`
        INSERT INTO turns (agent, turn_number, started_at, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, iterations, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('rust-vane', 1, '2026-02-15T10:00:00Z', 0.30, 1000000, 100000, 1000000, 0, 5, 60000);

      const data = getEfficiencyMetrics({});
      const agent = data.find(d => d.agent === 'rust-vane');
      expect(agent).toBeDefined();
      expect(agent!.estimatedCacheSavings).toBeCloseTo(2.70, 2);
    });

    it('handles NULL cost_usd gracefully', () => {
      const db = getDb();
      db.prepare(`
        INSERT INTO turns (agent, turn_number, started_at, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, iterations, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('cinder-wake', 1, '2026-02-15T10:00:00Z', null, 3000, 500, 0, 0, 1, 10000);

      // Should not throw
      const data = getEfficiencyMetrics({});
      const agent = data.find(d => d.agent === 'cinder-wake');
      expect(agent).toBeDefined();
      expect(agent!.totalCost).toBe(0);
      expect(agent!.creditsPerDollar).toBeNull();
    });

    it('filters by agent', () => {
      insertTurn('drifter-gale', 1, '2026-02-15T10:00:00Z', { cost: 0.10 });
      insertTurn('sable-thorn', 1, '2026-02-15T10:01:00Z', { cost: 0.05 });

      const data = getEfficiencyMetrics({ agent: 'drifter-gale' });
      expect(data).toHaveLength(1);
      expect(data[0].agent).toBe('drifter-gale');
    });
  });

  describe('getExploredSystems', () => {
    it('returns empty array when no snapshots exist', () => {
      expect(getExploredSystems()).toEqual([]);
    });

    it('returns distinct systems from game_snapshots', () => {
      const t1 = insertTurn('gale', 1, '2026-02-15T10:00:00Z');
      const t2 = insertTurn('gale', 2, '2026-02-15T10:05:00Z');
      const t3 = insertTurn('sable', 1, '2026-02-15T10:01:00Z');
      insertSnapshot(t1, 'gale', { system: 'Sol' });
      insertSnapshot(t2, 'gale', { system: 'Vega' });
      insertSnapshot(t3, 'sable', { system: 'Sol' }); // duplicate Sol

      const systems = getExploredSystems();
      expect(systems.sort()).toEqual(['Sol', 'Vega']);
    });

    it('excludes null/empty systems', () => {
      const db = getDb();
      const t1 = insertTurn('gale', 1, '2026-02-15T10:00:00Z');
      insertSnapshot(t1, 'gale', { system: 'Sol' });
      // Insert a row with empty system
      db.prepare(`
        INSERT INTO game_snapshots (turn_id, agent, credits, system, poi, docked)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(t1, 'gale', 100, '', 'Earth', 1);

      const systems = getExploredSystems();
      expect(systems).toEqual(['Sol']);
    });
  });

  describe('getPnlSummary', () => {
    it('returns empty result when no action log entries exist', () => {
      const result = getPnlSummary({});
      expect(result.agents).toEqual([]);
      expect(result.topRevenue).toEqual([]);
      expect(result.topCosts).toEqual([]);
      expect(result.fleetTotals.earned).toBe(0);
      expect(result.fleetTotals.spent).toBe(0);
      expect(result.fleetTotals.net).toBe(0);
    });

    it('returns PnlResponse with agents, topRevenue, topCosts when hours filter is set — regression for UNION ALL param-count bug', () => {
      const now = new Date();
      const recent = new Date(now.getTime() - 30 * 60 * 1000).toISOString(); // 30 min ago
      const old = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString(); // 48h ago

      insertActionLog('drifter-gale', 'sell', 3000, recent, 'Iron Ore');
      insertActionLog('drifter-gale', 'buy', -1000, recent, 'Steel');
      insertActionLog('drifter-gale', 'sell', 500, old, 'Copper'); // outside window

      // This call would throw "SQLite query expected 2 values, received 1" before the fix
      const result = getPnlSummary({ hours: 24 });

      expect(Array.isArray(result.agents)).toBe(true);
      expect(Array.isArray(result.topRevenue)).toBe(true);
      expect(Array.isArray(result.topCosts)).toBe(true);

      const agent = result.agents.find(a => a.agent === 'drifter-gale');
      expect(agent).toBeDefined();
      expect(agent!.totalEarned).toBe(3000);
      expect(agent!.totalSpent).toBe(1000);
      expect(agent!.netPnl).toBe(2000);

      // Old entry excluded by hours filter
      expect(result.fleetTotals.net).toBe(2000);
    });

    it('handles both hours and agent filters active — 4 placeholders total spread twice', () => {
      const now = new Date();
      const recent = new Date(now.getTime() - 30 * 60 * 1000).toISOString();

      insertActionLog('foo', 'sell', 5000, recent, 'Plasma');
      insertActionLog('bar', 'sell', 2000, recent, 'Gas');

      // Both filter conditions active — WHERE clause has 2 params, UNION ALL doubles to 4
      const result = getPnlSummary({ hours: 24, agent: 'foo' });

      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].agent).toBe('foo');
      expect(result.agents[0].totalEarned).toBe(5000);

      // bar not included
      expect(result.agents.find(a => a.agent === 'bar')).toBeUndefined();
    });

    it('returns correct topRevenue and topCosts', () => {
      insertActionLog('rust-vane', 'sell', 8000, new Date().toISOString(), 'Gold');
      insertActionLog('rust-vane', 'sell', 3000, new Date().toISOString(), 'Silver');
      insertActionLog('rust-vane', 'buy', -2000, new Date().toISOString(), 'Fuel');

      const result = getPnlSummary({});
      expect(result.topRevenue.length).toBeGreaterThan(0);
      expect(result.topCosts.length).toBeGreaterThan(0);

      const gold = result.topRevenue.find(r => r.item === 'Gold');
      expect(gold).toBeDefined();
      expect(gold!.totalCredits).toBe(8000);

      const fuel = result.topCosts.find(r => r.item === 'Fuel');
      expect(fuel).toBeDefined();
      expect(fuel!.totalCredits).toBe(2000);
    });
  });

  // ---------------------------------------------------------------------------
  // #115 regression guards: hours-filter queries must use an index (not a full
  // scan) AND must still return exactly the same rows the old
  // `datetime(column) >= datetime('now', ...)` predicate returned.
  //
  // The tricky failure mode this guards against: turns.started_at is stored as
  // a full ISO-8601 string with a 'T' separator (new Date().toISOString() in
  // turn-ingestor.ts), while SQLite's own datetime('now', ...) output uses a
  // space separator. Comparing the raw column against that space-separated
  // form directly is WRONG — ASCII 'T' (0x54) > ' ' (0x20), so any row sharing
  // the cutoff's calendar date spuriously satisfies `>=` regardless of
  // time-of-day. These tests deliberately put rows and cutoffs on the SAME
  // calendar date — the exact shape that stayed silent for the 24h-window
  // tests above (see 'filters by 24 hour range correctly') because a
  // 24h-aligned cutoff always lands on the previous calendar date, masking
  // the bug by lucky date-prefix disambiguation.
  // ---------------------------------------------------------------------------
  describe('#115: hours-filter index usage + same-day correctness', () => {
    it('excludes a same-calendar-date row that is outside the hours window', () => {
      const now = new Date();
      // Both timestamps are same-day as long as the test doesn't run in the
      // last few hours before UTC midnight — an accepted trade-off already
      // used by the pre-existing 'filters by N hour range' tests above.
      const within1h = new Date(now.getTime() - 20 * 60 * 1000).toISOString(); // 20 min ago
      const outside1hSameDay = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString(); // 3h ago, same day

      insertTurn('drifter-gale', 1, within1h, { cost: 0.11 });
      insertTurn('drifter-gale', 2, outside1hSameDay, { cost: 0.22 });

      const data = getCostOverTime({ hours: 1 });
      expect(data).toHaveLength(1);
      expect(data[0].cost).toBeCloseTo(0.11);
    });

    it('matches results across all hours-filtered analytics queries for a same-day dataset', () => {
      const now = new Date();
      const within6h = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
      const outside6hSameDay = new Date(now.getTime() - 7 * 60 * 60 * 1000).toISOString(); // 7h ago
      const outside6hPriorDay = new Date(now.getTime() - 30 * 60 * 60 * 1000).toISOString(); // 30h ago

      // getAgentComparison / getEfficiencyMetrics / getExpensiveTurns / getAgentTurns
      // all share buildTimeClause — one dataset, assert each independently.
      insertTurn('rust-vane', 1, within6h, { cost: 0.05 });
      insertTurn('rust-vane', 2, outside6hSameDay, { cost: 0.50 });
      insertTurn('rust-vane', 3, outside6hPriorDay, { cost: 5.00 });

      expect(getCostOverTime({ hours: 6 })).toHaveLength(1);
      expect(getExpensiveTurns({ hours: 6 })).toHaveLength(1);
      expect(getAgentTurns('rust-vane', { hours: 6, limit: 10, offset: 0 }).total).toBe(1);

      const cmp = getAgentComparison({ hours: 6 }).find(a => a.agent === 'rust-vane');
      expect(cmp?.turnCount).toBe(1);

      const eff = getEfficiencyMetrics({ hours: 6 }).find(a => a.agent === 'rust-vane');
      expect(eff?.totalCost).toBeCloseTo(0.05);
    });

    it('getAgentTrails excludes a same-day row outside the hours window', () => {
      const now = new Date();
      const within2h = new Date(now.getTime() - 30 * 60 * 1000).toISOString(); // 30 min ago
      const outside2hSameDay = new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString(); // 4h ago, same day

      const t1 = insertTurn('lumen-shoal', 1, within2h);
      const t2 = insertTurn('lumen-shoal', 2, outside2hSameDay);
      insertSnapshot(t1, 'lumen-shoal', { system: 'Vega' });
      insertSnapshot(t2, 'lumen-shoal', { system: 'Krynn' });

      const trails = getAgentTrails(2, 10);
      const trail = trails.find(t => t.agent === 'lumen-shoal');
      expect(trail).toBeDefined();
      expect(trail!.systems).toEqual(['Vega']);
    });

    it('uses an index (not a full scan) for the buildTimeClause hours predicate', () => {
      const db = getDb();
      // Seed enough rows that SQLite's planner would consider a scan if the
      // index weren't usable (tiny tables sometimes get scanned regardless).
      for (let i = 0; i < 500; i++) {
        insertTurn('drifter-gale', i, new Date(Date.now() - i * 60_000).toISOString());
      }
      const plan = db.query(`
        EXPLAIN QUERY PLAN
        SELECT agent, started_at, cost_usd, iterations, duration_ms, input_tokens, output_tokens
        FROM turns t
        WHERE t.started_at >= ? AND t.agent != 'overseer'
        ORDER BY t.started_at ASC
      `).all(new Date(Date.now() - 3_600_000).toISOString()) as Array<{ detail: string }>;

      const detail = plan.map(p => p.detail).join(' | ');
      expect(detail).not.toMatch(/SCAN t\b/);
      expect(detail).toMatch(/USING (COVERING )?INDEX idx_turns/);
    });

    it('uses an index (not a full scan) for a plain created_at-filtered agent_action_log query', () => {
      // getPnlSummary's own agent-grouped query independently chooses to scan
      // via idx_action_log_agent (for GROUP BY agent, regardless of this fix —
      // verified via EXPLAIN QUERY PLAN during the #115 investigation), so it
      // isn't a useful place to assert the WHERE-clause index win. The
      // topRevenue/topCosts queries (GROUP BY item, no index on item) are the
      // ones that actually benefit: this asserts that underlying WHERE-clause
      // win directly against the created_at predicate in isolation.
      const db = getDb();
      for (let i = 0; i < 500; i++) {
        db.prepare(`
          INSERT INTO agent_action_log (agent, action_type, credits_delta, created_at)
          VALUES (?, ?, ?, datetime('now', '-' || ? || ' minutes'))
        `).run('rust-vane', 'sell', 100, i);
      }
      const plan = db.query(`
        EXPLAIN QUERY PLAN
        SELECT * FROM agent_action_log WHERE created_at >= datetime('now', ?)
      `).all('-24 hours') as Array<{ detail: string }>;

      const detail = plan.map(p => p.detail).join(' | ');
      expect(detail).not.toMatch(/^SCAN agent_action_log$/);
      expect(detail).toMatch(/SEARCH agent_action_log USING INDEX idx_action_log_time/);
    });
  });
});
