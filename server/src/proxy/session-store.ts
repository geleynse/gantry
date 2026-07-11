/**
 * Persistent MCP session store using SQLite.
 * Tracks active MCP sessions across server restarts.
 * Sessions are keyed by UUID and include metadata like agent name and creation time.
 */

import { randomUUID } from "node:crypto";
import { queryOne, queryAll, queryRun, queryInsert, getDbIfInitialized } from "../services/database.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("session-store");

const SESSION_TTL_MS = 25 * 60 * 1000; // 25 minutes — must exceed 1200s turn hard cap + reaper interval. Was 15min which caused mid-turn session expiry.

// Rolling-TTL write throttle (gantry issue #117).
//
// getSession() is called multiple times per MCP tool call (pipeline.ts calls it
// once in getAgentForSession() to "touch" the session, and again in
// checkTurnTimeoutAndIdle()), and again on every subsequent tool call. Each call
// previously issued an UPDATE to slide last_seen_at/expires_at forward, even
// though nothing meaningful changed since the last touch a few hundred ms (or
// less) earlier. With 8 agents calling tools frequently, that's heavy write
// amplification on the hottest path in the system.
//
// Fix: only actually perform the UPDATE if more than TOUCH_THROTTLE_MS has
// elapsed since the last write for that session. The SELECT (read) still runs
// every call — only the redundant write is skipped. This is safe as long as
// TOUCH_THROTTLE_MS is well under SESSION_TTL_MS: the DB's expires_at can lag
// "now" by at most TOUCH_THROTTLE_MS while a session is actively in use, and
// that slack must never be able to add up to the full TTL while calls keep
// coming in.
//
// TOUCH_THROTTLE_MS = SESSION_TTL_MS / 5 (5 minutes) — inside the recommended
// TTL/6..TTL/3 band. At 5x headroom under the 25 min TTL, even several missed
// throttle windows in a row (e.g. a GC pause or a slow tick) leave a wide
// margin before a live session could be mistaken for expired by the 15s
// cleanup reaper (see mcp-factory.ts).
const TOUCH_THROTTLE_MS = SESSION_TTL_MS / 5;

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
  // Per-session last-write timestamp (ms epoch) for the rolling-TTL write
  // throttle in getSession(). Keyed by session id. Entries are evicted
  // wherever a session is torn down (cleanup(), expireAgentSessions(),
  // clearAll()) so this can never grow past the live session count.
  private lastTouchWriteMs = new Map<string, number>();

  /**
   * @param touchThrottleMs Override for the rolling-TTL write-throttle window
   *   (defaults to TOUCH_THROTTLE_MS). Only ever overridden in tests, so a
   *   short interval can be exercised without waiting out the real TTL.
   */
  constructor(private touchThrottleMs: number = TOUCH_THROTTLE_MS) {}

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
   * Slides the rolling TTL forward (last_seen_at / expires_at), but throttles
   * the actual UPDATE write to at most once per touchThrottleMs per session —
   * see the TOUCH_THROTTLE_MS comment above for why this is safe. The read
   * (SELECT) always runs; only the redundant write is skipped.
   * Returns null if session not found or expired.
   */
  getSession(id: string): McpSessionRecord | null {
    const now = new Date().toISOString();
    const nowMs = Date.now();

    const session = queryOne<McpSessionRow>(
      "SELECT * FROM mcp_sessions WHERE id = ? AND expires_at > ?",
      id, now
    );

    if (!session) {
      // Session is gone (expired/deleted) — drop any throttle bookkeeping for it.
      this.lastTouchWriteMs.delete(id);
      return null;
    }

    const newExpiry = new Date(nowMs + SESSION_TTL_MS).toISOString();
    const lastWrite = this.lastTouchWriteMs.get(id);
    if (lastWrite === undefined || nowMs - lastWrite >= this.touchThrottleMs) {
      // Update last_seen_at and slide expiry forward (rolling TTL)
      queryRun(
        "UPDATE mcp_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?",
        now, newExpiry, id
      );
      this.lastTouchWriteMs.set(id, nowMs);
    }

    return {
      id: session.id,
      agent: session.agent ?? undefined,
      createdAt: session.created_at,
      lastSeenAt: now, // Return the updated value, not the stale DB row
      expiresAt: newExpiry,
    };
  }

  /**
   * Check if a session is valid (exists and not expired).
   */
  isValidSession(id: string): boolean {
    if (!getDbIfInitialized()) return false;
    const now = new Date().toISOString();
    try {
      return !!queryOne("SELECT 1 FROM mcp_sessions WHERE id = ? AND expires_at > ?", id, now);
    } catch {
      return false;
    }
  }


  /**
   * Update session's agent name (after login). Also expires any *other*
   * sessions currently tagged to this agent so only one live session per
   * agent accumulates. Prevents session leak when an agent process churns
   * (restart, crash recovery) without calling logout.
   */
  setSessionAgent(id: string, agent: string): void {
    queryRun("UPDATE mcp_sessions SET agent = ? WHERE id = ?", agent, id);
    const now = new Date().toISOString();
    const pruned = queryRun(
      "UPDATE mcp_sessions SET expires_at = ? WHERE agent = ? AND id != ? AND expires_at > ?",
      now, agent, id, now
    );
    if (pruned > 0) {
      log.debug("pruned stale agent sessions on new-session claim", { agent, pruned, keep: id.slice(0, 8) });
    } else {
      log.debug("session agent updated", { id: id.slice(0, 8), agent });
    }
  }

  /**
   * Expire all sessions for an agent.
   */
  expireAgentSessions(agent: string): void {
    const now = new Date().toISOString();
    // Grab ids first so we can evict their write-throttle bookkeeping below —
    // otherwise lastTouchWriteMs would leak an entry per expired session.
    const ids = queryAll<{ id: string }>(
      "SELECT id FROM mcp_sessions WHERE agent = ? AND expires_at > ?",
      agent, now
    );
    const changes = queryRun(
      "UPDATE mcp_sessions SET expires_at = ? WHERE agent = ?",
      now, agent
    );
    for (const { id } of ids) this.lastTouchWriteMs.delete(id);

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
    this.lastTouchWriteMs.clear();
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
    if (!getDbIfInitialized()) return 0;
    const now = new Date().toISOString();
    try {
      // Fetch ids before deleting so the write-throttle map can be pruned —
      // without this, lastTouchWriteMs would grow by one stale entry per
      // reaped session for the lifetime of the process.
      const expired = queryAll<{ id: string }>(
        "SELECT id FROM mcp_sessions WHERE expires_at <= ?", now
      );
      const deleted = queryRun("DELETE FROM mcp_sessions WHERE expires_at <= ?", now);
      for (const { id } of expired) this.lastTouchWriteMs.delete(id);
      if (deleted > 0) {
        log.debug("cleaned up expired sessions", { count: deleted });
      }
      return deleted;
    } catch {
      return 0;
    }
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
    const result = queryOne<{ iteration_count: number }>(
      "UPDATE mcp_sessions SET iteration_count = iteration_count + 1 WHERE id = ? RETURNING iteration_count", id
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
