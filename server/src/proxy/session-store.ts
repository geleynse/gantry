/**
 * Persistent MCP session store using SQLite.
 * Tracks active MCP sessions across server restarts.
 * Sessions are keyed by UUID and include metadata like agent name and creation time.
 */

import { randomUUID } from "node:crypto";
import { queryOne, queryAll, queryRun, queryInsert } from "../services/database.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("session-store");

const SESSION_TTL_MS = 25 * 60 * 1000; // 25 minutes — must exceed 1200s turn hard cap + reaper interval. Was 15min which caused mid-turn session expiry.

export interface McpSessionRecord {
  id: string;
  agent?: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

interface McpSessionRow {
  id: string;
  agent: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  iteration_count: number;
  turn_started_at: string | null;
}

export class SessionStore {
  /**
   * Create a new MCP session.
   * If id is provided, uses that; otherwise generates a new UUID.
   * Returns the session ID.
   */
  createSession(agent?: string, id?: string): string {
    const sessionId = id ?? randomUUID();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

    queryInsert(
      `INSERT INTO mcp_sessions (id, agent, created_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      sessionId, agent ?? null, now, now, expiresAt
    );

    log.debug("session created", { id: sessionId.slice(0, 8), agent });
    return sessionId;
  }

  /**
   * Get a session record by ID.
   * Updates last_seen_at timestamp.
   * Returns null if session not found or expired.
   */
  getSession(id: string): McpSessionRecord | null {
    const now = new Date().toISOString();

    const session = queryOne<McpSessionRow>(
      "SELECT * FROM mcp_sessions WHERE id = ? AND expires_at > ?",
      id, now
    );

    if (!session) {
      return null;
    }

    // Update last_seen_at and slide expiry forward (rolling TTL)
    const newExpiry = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    queryRun(
      "UPDATE mcp_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?",
      now, newExpiry, id
    );

    return {
      id: session.id,
      agent: session.agent ?? undefined,
      createdAt: session.created_at,
      lastSeenAt: now, // Return the updated value, not the stale DB row
      expiresAt: newExpiry,
    };
  }

  /**
   * Check if a session exists and is valid.
   */
  isValidSession(id: string): boolean {
    const now = new Date().toISOString();
    return !!queryOne("SELECT 1 FROM mcp_sessions WHERE id = ? AND expires_at > ?", id, now);
  }

  /**
   * Update session's agent name (after login).
   */
  setSessionAgent(id: string, agent: string): void {
    queryRun("UPDATE mcp_sessions SET agent = ? WHERE id = ?", agent, id);
    log.debug("session agent updated", { id: id.slice(0, 8), agent });
  }

  /**
   * Expire all sessions for an agent.
   */
  expireAgentSessions(agent: string): void {
    const now = new Date().toISOString();
    const changes = queryRun(
      "UPDATE mcp_sessions SET expires_at = ? WHERE agent = ?",
      now, agent
    );

    if (changes > 0) {
      log.debug("expired agent sessions", { agent, count: changes });
    }
  }

  /**
   * Remove ALL sessions (call on server startup to clear stale sessions
   * from a previous run whose in-memory transports no longer exist).
   */
  clearAll(): number {
    const deleted = queryRun("DELETE FROM mcp_sessions");
    if (deleted > 0) {
      log.debug("cleared all sessions on startup", { count: deleted });
    }
    return deleted;
  }

  /**
   * Clean up expired sessions.
   * Runs periodically to keep database clean.
   */
  cleanup(): number {
    const now = new Date().toISOString();
    const deleted = queryRun("DELETE FROM mcp_sessions WHERE expires_at <= ?", now);
    if (deleted > 0) {
      log.debug("cleaned up expired sessions", { count: deleted });
    }
    return deleted;
  }

  /**
   * Get all active sessions (for debugging/monitoring).
   */
  getActiveSessions(): McpSessionRecord[] {
    const now = new Date().toISOString();
    const sessions = queryAll<McpSessionRow>(
      `SELECT id, agent, created_at, last_seen_at, expires_at
       FROM mcp_sessions
       WHERE expires_at > ?
       ORDER BY created_at DESC`,
      now
    );

    return sessions.map((s) => ({
      id: s.id,
      agent: s.agent ?? undefined,
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at,
      expiresAt: s.expires_at,
    }));
  }

  /**
   * Increment the iteration count for a session (call tracking).
   * Returns the new count.
   */
  incrementIterationCount(id: string): number {
    queryRun("UPDATE mcp_sessions SET iteration_count = iteration_count + 1 WHERE id = ?", id);
    const result = queryOne<{ iteration_count: number }>(
      "SELECT iteration_count FROM mcp_sessions WHERE id = ?", id
    );
    return result?.iteration_count ?? 0;
  }

  /**
   * Get the iteration count for a session.
   */
  getIterationCount(id: string): number {
    const result = queryOne<{ iteration_count: number }>(
      "SELECT iteration_count FROM mcp_sessions WHERE id = ?", id
    );

    return result?.iteration_count ?? 0;
  }

  /**
   * Reset iteration count on login.
   */
  resetIterationCount(id: string): void {
    const now = new Date().toISOString();
    queryRun("UPDATE mcp_sessions SET iteration_count = 0, turn_started_at = ? WHERE id = ?", now, id);
  }

  /**
   * Get turn start time for a session.
   */
  getTurnStartedAt(id: string): string | null {
    const result = queryOne<{ turn_started_at: string | null }>(
      "SELECT turn_started_at FROM mcp_sessions WHERE id = ?", id
    );

    return result?.turn_started_at ?? null;
  }
}
