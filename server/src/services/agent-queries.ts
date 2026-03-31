import { getDb } from './database.js';

export function hasActiveProxySession(agentName: string): boolean {
  try {
    const db = getDb();
    const result = db.prepare(`
      SELECT 1 FROM proxy_sessions
      WHERE agent = ? AND (expires_at IS NULL OR expires_at > datetime('now'))
      LIMIT 1
    `).get(agentName);
    return result !== undefined;
  } catch {
    return false;
  }
}

export function getLastActivityAt(agentName: string): string | null {
  try {
    const db = getDb();
    const result = db.prepare(`
      SELECT last_seen_at FROM proxy_sessions
      WHERE agent = ?
      ORDER BY last_seen_at DESC
      LIMIT 1
    `).get(agentName) as { last_seen_at: string } | undefined;
    return result?.last_seen_at ?? null;
  } catch {
    return null;
  }
}
