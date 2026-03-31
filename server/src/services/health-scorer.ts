import type { HealthScore } from '../shared/types.js';
import { AGENTS, getAgent, getAgentLabel } from '../config.js';
import * as proc from './process-manager.js';
import { parseAgentLog } from './log-parser.js';
import { queryOne } from './database.js';
import type { BreakerRegistry } from '../proxy/circuit-breaker.js';

export async function getHealthScore(agentName: string, breakerRegistry: BreakerRegistry | null): Promise<HealthScore> {
  const agent = getAgent(agentName);
  if (!agent) return { name: agentName, backend: 'unknown', score: 0, issues: ['unknown agent'] };

  let score = 100;
  const issues: string[] = [];

  const running = await proc.hasSession(agentName);
  if (!running) {
    return {
      name: agentName,
      backend: getAgentLabel(agent),
      model: agent.model,
      score: 0,
      issues: ['NOT RUNNING'],
    };
  }

  const log = await parseAgentLog(agentName);
  if (!log) {
    return {
      name: agentName,
      backend: getAgentLabel(agent),
      model: agent.model,
      score: 80,
      issues: ['no-log'],
    };
  }

  // Quota hits
  if (log.quotaHits > 0) {
    score -= log.quotaHits > 5 ? 30 : 10;
    issues.push(`quota:${log.quotaHits}`);
  }

  // Staleness
  if (log.lastTurnAgeSeconds !== null) {
    if (log.lastTurnAgeSeconds > 1800) {
      score -= 40;
      issues.push(`stale:${Math.floor(log.lastTurnAgeSeconds / 60)}m`);
    } else if (log.lastTurnAgeSeconds > 600) {
      score -= 15;
      issues.push(`slow:${Math.floor(log.lastTurnAgeSeconds / 60)}m`);
    }
  }

  // Auth errors
  if (log.authHits > 0) {
    score -= 50;
    issues.push(`auth-error:${log.authHits}`);
  }

  // Turn count
  if (log.turnCount < 5) {
    score -= 20;
    issues.push(`low-turns:${log.turnCount}`);
  }

  // DB-backed checks
  try {
    // High error rate from tool_calls table (>10% failures)
    const errorStats = queryOne<{ total: number; failures: number }>(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN tc.success = 0 THEN 1 ELSE 0 END) as failures
      FROM tool_calls tc
      JOIN turns t ON tc.turn_id = t.id
      WHERE t.agent = ?
    `, agentName);

    if (errorStats && errorStats.total > 10) {
      const errorRate = errorStats.failures / errorStats.total;
      if (errorRate > 0.1) {
        score -= 20;
        issues.push(`high-error-rate:${Math.round(errorRate * 100)}%`);
      }
    }

    // MCP tools missing — check if proxy_call_trackers shows empty tool list
    const tracker = queryOne<{ called_tools_json: string }>(
      'SELECT called_tools_json FROM proxy_call_trackers WHERE agent = ?',
      agentName,
    );

    if (tracker) {
      let tools: unknown[] = [];
      try { tools = JSON.parse(tracker.called_tools_json); } catch { /* ignore */ }
      if (tools.length === 0) {
        issues.push('mcp_tools_missing');
      }
    }
  } catch {
    // DB may not be initialized — skip DB checks
  }

  // Circuit breaker open
  try {
    const breakers = breakerRegistry?.getAll();
    const breaker = breakers?.get(agentName);
    if (breaker && breaker.getState() === 'open') {
      score -= 30;
      issues.push('circuit_breaker_open');
    }
  } catch {
    // Circuit breaker registry may not be populated
  }

  if (score < 0) score = 0;

  return {
    name: agentName,
    backend: getAgentLabel(agent),
    model: agent.model,
    score,
    issues,
  };
}

export async function getAllHealthScores(breakerRegistry: BreakerRegistry | null): Promise<HealthScore[]> {
  return Promise.all(AGENTS.map(a => getHealthScore(a.name, breakerRegistry)));
}
