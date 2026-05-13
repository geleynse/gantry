/**
 * overseer-stop-cooldown.ts — Per-agent restart cooldown and escalation alerting
 * for overseer-initiated force-stops.
 *
 * Problem: The overseer calls stop_agent on stuck agents, the health monitor
 * auto-restarts them, the same loop resumes, repeat. Without throttling,
 * this churn can cycle every few minutes indefinitely.
 *
 * Responsibilities:
 *   1. Per-agent restart cooldown: after an overseer stop, block auto-restart
 *      for OVERSEER_STOP_COOLDOWN_MS (1 hour). Operator manual starts override
 *      the cooldown with a log line.
 *   2. Escalation alert: after ≥3 overseer stops in any rolling 24h window for
 *      the same agent, raise a critical alert (debounced — once per threshold
 *      crossing, not on every subsequent stop until the count drops back below
 *      the threshold).
 *
 * Persistence: two tables in the main fleet.db, declared in SCHEMA_SQL in
 * database.ts (so they exist on first boot and survive server restarts):
 *   - overseer_stop_cooldowns  (one row per agent, upserted on each stop)
 *   - overseer_stop_history    (append-only log — queried by rolling window)
 */

import { queryOne, queryAll, queryRun, queryInsert } from "./database.js";
import { createAlert } from "./alerts-db.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("overseer-stop-cooldown");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How long after an overseer stop to suppress auto-restarts. */
export const OVERSEER_STOP_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

/** Rolling window for escalation threshold. */
const ESCALATION_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Number of overseer stops in ESCALATION_WINDOW_MS that triggers an alert. */
export const ESCALATION_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// DB row shapes
// ---------------------------------------------------------------------------

export interface CooldownRow {
  agent: string;
  stopped_until: string; // ISO timestamp
  stop_reason: string;
  alert_fired_at: string | null; // ISO timestamp or null
  hold_offline: number; // 0 = normal cooldown, 1 = blocked until operator review
  updated_at: string;
}

interface StopHistoryRow {
  id: number;
  agent: string;
  reason: string;
  stopped_at: string; // ISO timestamp
}

// ---------------------------------------------------------------------------
// Cooldown queries
// ---------------------------------------------------------------------------

/** Return the raw cooldown row for an agent, or null if none exists. */
function getCooldownRow(agent: string): CooldownRow | null {
  return queryOne<CooldownRow>(
    `SELECT agent, stopped_until, stop_reason, alert_fired_at, hold_offline, updated_at
     FROM overseer_stop_cooldowns WHERE agent = ?`,
    agent,
  );
}

/**
 * Check whether auto-restart is suppressed for this agent right now.
 *
 * Suppression sources, in priority order:
 *   1. hold_offline = 1 — agent crossed the 24h escalation threshold and is
 *      held until an operator manually starts it. Indefinite; ignores stopped_until.
 *   2. stopped_until > now — normal 1h post-stop cooldown.
 *
 * Returns `{ suppressed: false }` if neither applies, or no row exists.
 *
 * On DB error, returns `{ suppressed: false }` (fail-open — allow restart
 * rather than permanently locking an agent).
 *
 * @param nowMs - Injectable current timestamp (ms since epoch). Defaults to
 *   Date.now(). Exposed for deterministic testing.
 */
export function isRestartSuppressed(agent: string, nowMs = Date.now()): {
  suppressed: boolean;
  stoppedUntil?: Date;
  reason?: string;
  holdOffline?: boolean;
} {
  try {
    const row = getCooldownRow(agent);
    if (!row) return { suppressed: false };
    if (row.hold_offline === 1) {
      return {
        suppressed: true,
        stoppedUntil: new Date(row.stopped_until),
        reason: row.stop_reason,
        holdOffline: true,
      };
    }
    const stoppedUntil = new Date(row.stopped_until);
    if (nowMs < stoppedUntil.getTime()) {
      return { suppressed: true, stoppedUntil, reason: row.stop_reason };
    }
    return { suppressed: false };
  } catch (err) {
    log.warn("isRestartSuppressed DB error — allowing restart", {
      agent,
      error: err instanceof Error ? err.message : String(err),
    });
    return { suppressed: false };
  }
}

// ---------------------------------------------------------------------------
// Stop recording (called from overseer-actions when stop_agent succeeds)
// ---------------------------------------------------------------------------

/**
 * Record an overseer-initiated stop for an agent.
 *
 * Side effects (all non-fatal — exceptions are caught and logged):
 *   1. Upserts a cooldown row: stopped_until = now + OVERSEER_STOP_COOLDOWN_MS.
 *   2. Appends a row to overseer_stop_history.
 *   3. Queries the rolling 24h window and fires a critical alert if the count
 *      crosses ESCALATION_THRESHOLD for the first time (debounced).
 *
 * @param nowMs - Injectable current timestamp (ms since epoch). Defaults to
 *   Date.now(). Exposed for deterministic testing without real-clock dependency.
 */
export function recordOverseerStop(agent: string, reason: string, nowMs = Date.now()): void {
  const now = new Date(nowMs);
  const stoppedUntil = new Date(nowMs + OVERSEER_STOP_COOLDOWN_MS).toISOString();

  try {
    // 1. Upsert cooldown row.
    //    alert_fired_at is intentionally NOT updated here so it survives across
    //    multiple stops in the same threshold crossing.
    queryRun(
      `INSERT INTO overseer_stop_cooldowns (agent, stopped_until, stop_reason, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(agent) DO UPDATE SET
         stopped_until = excluded.stopped_until,
         stop_reason   = excluded.stop_reason,
         updated_at    = excluded.updated_at`,
      agent, stoppedUntil, reason, now.toISOString(),
    );
    log.info("Overseer stop cooldown set", { agent, stoppedUntil, reason });
  } catch (err) {
    log.warn("Failed to set overseer stop cooldown", {
      agent,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    // 2. Append stop history.
    queryInsert(
      `INSERT INTO overseer_stop_history (agent, reason, stopped_at) VALUES (?, ?, ?)`,
      agent, reason, now.toISOString(),
    );
  } catch (err) {
    log.warn("Failed to append overseer stop history", {
      agent,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 3. Escalation check (wrapped separately so a history-insert failure
  //    doesn't silently skip the alert).
  try {
    checkEscalation(agent, now);
  } catch (err) {
    log.warn("Escalation check failed", {
      agent,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Check the rolling 24h stop count and fire an escalation alert if needed.
 *
 * Debounce logic:
 *   - If count >= threshold AND alert_fired_at IS NULL → fire the alert, set
 *     alert_fired_at = now.
 *   - If count >= threshold AND alert_fired_at IS NOT NULL → already alerted
 *     for this crossing, skip.
 *   - If count < threshold AND alert_fired_at IS NOT NULL → count has dropped
 *     back below threshold (old stops aged out); clear alert_fired_at so the
 *     next crossing fires again.
 */
function checkEscalation(agent: string, now: Date): void {
  const windowStart = new Date(now.getTime() - ESCALATION_WINDOW_MS).toISOString();

  const recentStops = queryAll<StopHistoryRow>(
    `SELECT id, agent, reason, stopped_at FROM overseer_stop_history
     WHERE agent = ? AND stopped_at >= ?
     ORDER BY stopped_at DESC`,
    agent, windowStart,
  );

  const count = recentStops.length;

  if (count < ESCALATION_THRESHOLD) {
    // Below threshold — reset the debounce flag so the next crossing fires.
    queryRun(
      `UPDATE overseer_stop_cooldowns
       SET alert_fired_at = NULL
       WHERE agent = ? AND alert_fired_at IS NOT NULL`,
      agent,
    );
    return;
  }

  // Count >= threshold. Check if we already fired for this crossing.
  const row = getCooldownRow(agent);
  if (row?.alert_fired_at) {
    log.debug("Escalation alert already fired for current crossing, skipping", {
      agent,
      count,
      alertFiredAt: row.alert_fired_at,
    });
    return;
  }

  // Build operator-readable message with the most recent stop reasons.
  const recentReasons = recentStops
    .slice(0, ESCALATION_THRESHOLD)
    .map(r => `[${r.stopped_at.slice(0, 16)}] ${r.reason}`)
    .join("; ");

  const message =
    `${agent} force-stopped by overseer ${count}x in the last 24h — likely behavior loop. ` +
    `Most recent reasons: ${recentReasons}`;

  const alertId = createAlert(agent, "critical", "overseer-loop", message);

  // Mark the debounce flag AND raise hold_offline — the agent has crossed the
  // 24h threshold; auto-restart stays blocked until an operator clears it via
  // clearCooldownForOperatorStart (i.e. a manual start).
  queryRun(
    `UPDATE overseer_stop_cooldowns
     SET alert_fired_at = ?, hold_offline = 1
     WHERE agent = ?`,
    now.toISOString(), agent,
  );

  log.warn("Overseer escalation alert fired — hold_offline raised", { agent, count, alertId });
}

// ---------------------------------------------------------------------------
// Operator override
// ---------------------------------------------------------------------------

/**
 * Clear an active cooldown when an operator manually starts the agent.
 *
 * Clears both the timestamp-based cooldown AND the hold_offline flag — a
 * manual start is the operator's signal that they have reviewed the
 * escalation and the agent is cleared to run.
 *
 * Logs the override (agent name, how long was left, the overseer's stop reason,
 * whether hold_offline was set) so the operator knows what was bypassed.
 *
 * @param nowMs - Injectable current timestamp (ms since epoch). Defaults to Date.now().
 */
export function clearCooldownForOperatorStart(agent: string, nowMs = Date.now()): void {
  try {
    const row = getCooldownRow(agent);
    if (!row) return;

    const until = new Date(row.stopped_until).getTime();
    const heldOffline = row.hold_offline === 1;
    const cooldownActive = nowMs < until;
    if (!cooldownActive && !heldOffline) return;

    const remainingMin = cooldownActive ? Math.round((until - nowMs) / 60_000) : 0;
    const nowIso = new Date(nowMs).toISOString();
    queryRun(
      `UPDATE overseer_stop_cooldowns
       SET stopped_until = ?, hold_offline = 0, updated_at = ?
       WHERE agent = ?`,
      nowIso, nowIso, agent,
    );
    log.info("Operator overrode overseer stop cooldown", {
      agent,
      hadCooldownUntil: row.stopped_until,
      remainingMin,
      heldOffline,
      overseerReason: row.stop_reason,
    });
  } catch (err) {
    log.warn("clearCooldownForOperatorStart DB error", {
      agent,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Observability helpers
// ---------------------------------------------------------------------------

/** Return current cooldown rows for all agents. Useful for dashboard/API. */
export function getAllCooldowns(): CooldownRow[] {
  try {
    return queryAll<CooldownRow>(
      `SELECT agent, stopped_until, stop_reason, alert_fired_at, hold_offline, updated_at
       FROM overseer_stop_cooldowns
       ORDER BY updated_at DESC`,
    );
  } catch {
    return [];
  }
}

/** Return overseer stop history for one agent (most recent first). */
export function getStopHistory(agent: string, limit = 20): StopHistoryRow[] {
  try {
    return queryAll<StopHistoryRow>(
      `SELECT id, agent, reason, stopped_at FROM overseer_stop_history
       WHERE agent = ? ORDER BY stopped_at DESC, id DESC LIMIT ?`,
      agent, limit,
    );
  } catch {
    return [];
  }
}
