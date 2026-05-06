import { queryOne } from './database.js';

export function hasActiveProxySession(agentName: string): boolean {
  try {
    const result = queryOne(
      `SELECT 1 FROM mcp_sessions WHERE agent = ? AND expires_at > datetime('now') LIMIT 1`,
      agentName
    );
    return result !== null;
  } catch {
    return false;
  }
}

export function getLastActivityAt(agentName: string): string | null {
  try {
    const result = queryOne<{ last_seen_at: string }>(
      `SELECT last_seen_at FROM mcp_sessions WHERE agent = ? ORDER BY last_seen_at DESC LIMIT 1`,
      agentName
    );
    return result?.last_seen_at ?? null;
  } catch {
    return null;
  }
}
