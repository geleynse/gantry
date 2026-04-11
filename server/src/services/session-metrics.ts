import { queryOne, queryAll } from './database.js';
import type { SessionInfo, LatencyMetrics, ErrorRateBreakdown } from '../shared/types.js';

/**
 * Get session start time and last tool call timestamp for an agent.
 * Session start is inferred from the oldest proxy_tool_call record.
 * Last tool call is the most recent timestamp.
 */
export function getSessionInfo(agentName: string): SessionInfo {
  const result = queryOne<{ session_started_at: string | null; last_tool_call_at: string | null }>(
    `SELECT MIN(created_at) as session_started_at, MAX(created_at) as last_tool_call_at
     FROM proxy_tool_calls WHERE agent = ?`,
    agentName
  );

  // Get the most recent real tool name (exclude internal pseudo-tools)
  const toolResult = queryOne<{ tool_name: string | null }>(
    `SELECT tool_name FROM proxy_tool_calls
     WHERE agent = ? AND tool_name NOT LIKE '\\_\\_%' ESCAPE '\\' AND tool_name NOT LIKE 'ws:%'
     ORDER BY created_at DESC LIMIT 1`,
    agentName
  );

  return {
    agent: agentName,
    sessionStartedAt: result?.session_started_at ?? null,
    lastToolCallAt: result?.last_tool_call_at ?? null,
    lastToolName: toolResult?.tool_name ?? null,
  };
}

/**
 * Get the total number of turns for an agent from the turns table.
 */
export function getTurnCountFromDb(agentName: string): number {
  try {
    const result = queryOne<{ cnt: number }>('SELECT COUNT(*) as cnt FROM turns WHERE agent = ?', agentName);
    return result?.cnt ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Calculate latency percentiles (p50, p95, p99) for an agent.
 * Prefers proxy_tool_calls.duration_ms; falls back to turns.duration_ms (whole-turn duration).
 */
export function getLatencyMetrics(agentName: string): LatencyMetrics {
  // Try proxy_tool_calls first (individual tool call latency)
  const proxyRecords = queryAll<{ duration_ms: number }>(
    `SELECT duration_ms FROM proxy_tool_calls
     WHERE agent = ? AND duration_ms IS NOT NULL AND duration_ms > 0
     ORDER BY duration_ms ASC`,
    agentName
  );

  // Fall back to turns.duration_ms (whole-turn duration)
  const records = proxyRecords.length > 0 ? proxyRecords : queryAll<{ duration_ms: number }>(
    `SELECT duration_ms FROM turns
     WHERE agent = ? AND duration_ms IS NOT NULL AND duration_ms > 0
     ORDER BY duration_ms ASC`,
    agentName
  );

  // SQL already filters NULL/<=0 and sorts ASC — extract directly
  const sorted = records.map(r => r.duration_ms);

  if (sorted.length === 0) {
    return {
      agent: agentName,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
      avgMs: null,
    };
  }
  const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;

  const percentile = (p: number): number => {
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  };

  return {
    agent: agentName,
    p50Ms: percentile(50),
    p95Ms: percentile(95),
    p99Ms: percentile(99),
    avgMs: Math.round(avg),
  };
}

/**
 * Calculate error rate and breakdown by error type for an agent.
 */
export function getErrorRateBreakdown(agentName: string): ErrorRateBreakdown {
  const result = queryAll<{ total_calls: number; successful_calls: number; error_code: string | null }>(
    `SELECT COUNT(*) as total_calls,
            SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successful_calls,
            error_code
     FROM proxy_tool_calls WHERE agent = ? AND created_at >= datetime('now', '-24 hours') GROUP BY error_code`,
    agentName
  );

  let totalCalls = 0;
  let successfulCalls = 0;
  const errorsByType: Record<string, number> = {};
  let countRateLimit = 0;
  let countConnection = 0;

  for (const row of result) {
    totalCalls += row.total_calls;
    successfulCalls += row.successful_calls;
    if (row.error_code) {
      const errorCount = row.total_calls - row.successful_calls;
      errorsByType[row.error_code] = (errorsByType[row.error_code] ?? 0) + errorCount;

      // Track rate limit and connection errors
      if (row.error_code === "429" || row.error_code === "rate_limited") {
        countRateLimit += errorCount;
      } else if (row.error_code.startsWith("connection_")) {
        countConnection += errorCount;
      }
    }
  }

  const successRate = totalCalls > 0 ? (successfulCalls / totalCalls) * 100 : 0;

  return {
    agent: agentName,
    totalCalls,
    successRate: Math.round(successRate),
    errorsByType,
    countRateLimit,
    countConnection,
  };
}

/**
 * Get the timestamp of the last successful tool call for an agent.
 */
export function getLastSuccessfulCommand(agentName: string): string | null {
  const result = queryOne<{ created_at: string }>(
    `SELECT created_at FROM proxy_tool_calls
     WHERE agent = ? AND success = 1 ORDER BY created_at DESC LIMIT 1`,
    agentName
  );
  return result?.created_at ?? null;
}
