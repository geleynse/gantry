/**
 * Agent backoff hints — inject guidance into tool responses during degradation.
 *
 * When the game server is degraded/unstable/down, agents receive contextual
 * hints telling them to slow down or pause operations.
 */

import { createLogger } from "../lib/logger.js";
import type { HealthMetrics, ServerStatus } from "./instability-metrics.js";

const log = createLogger("instability-hints");

// Safe tools always allowed — read-only game queries + local writes that don't hit game server
const SAFE_TOOLS = new Set([
  "get_status", "get_credits", "get_location", "get_cargo", "get_cargo_summary",
  "get_fuel", "get_health", "get_system", "get_ship", "get_skills",
  "v2_get_player", "v2_get_ship", "v2_get_cargo",
  "login", "logout",
  "captains_log_add", "captains_log_get", "captains_log_list",
  "read_doc", "read_diary", "search_memory", "search_captain_logs",
  "write_doc", "write_diary", "write_report",
  "get_state", "view",
]);

/**
 * Generate a hint string for the current server status.
 * Returns empty string when healthy (no hint needed).
 */
export function generateInstabilityHint(metrics: HealthMetrics): string {
  if (metrics.status === "healthy") return "";

  const errorPct = metrics.requests.total > 0
    ? ((metrics.errors.total / metrics.requests.total) * 100).toFixed(1)
    : 0;

  if (metrics.status === "degraded") {
    return [
      `ℹ️ Note: Elevated error rate (${errorPct}%) in last 10 minutes.`,
      "  Some commands may need a retry. Continue your session normally.",
    ].join("\n");
  }

  if (metrics.status === "unstable") {
    return [
      `⚠️ Elevated error rate (${errorPct}% in last 10 min). Some commands may need a retry.`,
      "  Continue your session but expect occasional failures. Use safe tools if stuck.",
    ].join("\n");
  }

  if (metrics.status === "recovering") {
    return [
      "🟡 Server is recovering:",
      `  ${metrics.reason}`,
      "  Operations resuming. Some commands may still timeout — try again.",
    ].join("\n");
  }

  if (metrics.status === "down") {
    return [
      "🔴 SERVER DOWN:",
      `  The game server is unreachable. All operations paused.`,
      `  Reason: ${metrics.reason}`,
      "  Waiting for recovery...",
    ].join("\n");
  }

  return "";
}

/**
 * Generate a hint for action_pending errors.
 */
export function generatePendingHint(retryCount: number, waitSeconds: number): string {
  return [
    "ℹ️ Action Pending:",
    `  The game server is processing your previous action (retry ${retryCount}).`,
    `  Waiting ${waitSeconds}s before next attempt. This is normal during high load.`,
  ].join("\n");
}

/**
 * Check if a tool call should be blocked during instability.
 * Returns a hint string if blocked, empty string if allowed.
 */
export function checkToolBlocked(toolName: string, status: ServerStatus): string {
  if (status === "healthy" || status === "degraded" || status === "recovering") return "";

  if (SAFE_TOOLS.has(toolName)) return "";

  // Only hard-block on "down" (no connectivity at all)
  if (status === "down") {
    const msg = `Server is down. Cannot execute '${toolName}'. Only status/info checks are available until recovery.`;
    log.warn(`Tool blocked (server down): ${toolName}`);
    return msg;
  }

  // "unstable" (high error rate) — warn but don't block; let agent decide

  return "";
}
