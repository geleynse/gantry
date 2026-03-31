/**
 * Fleet Watchdog — in-process alerting for fleet health issues.
 *
 * Runs on a configurable interval (default 2min), checks the FleetHealthMonitor
 * snapshot, and sends webhook alerts when conditions are detected.
 *
 * Replaces the bash-based fleet-watchdog.sh with a cross-platform TS solution
 * that has direct access to health data (no HTTP polling).
 *
 * Conditions checked:
 *   - Error rate >20% (warning before the 30% auto-stop threshold)
 *   - Any agent reconnect storm (>5 reconnects/min)
 *   - Session leak detected
 *   - Fleet auto-stopped
 *
 * Cooldown: max 1 alert per condition per 30 minutes.
 */

import { createLogger } from "../lib/logger.js";

const log = createLogger("fleet-watchdog");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FleetWatchdogDeps {
  /** Get the current fleet health snapshot. */
  getFleetHealth: () => {
    reconnects_per_minute: Record<string, number>;
    session_leak: boolean;
    auto_shutdown_reason: string | null;
  };

  /** Get the current error rate (0..1). */
  getErrorRate: () => number;

  /** Webhook URL to send alerts to. Null disables alerting. */
  webhookUrl: string | null;
}

export interface FleetWatchdog {
  /** Run one check cycle. */
  check(): Promise<void>;
  /** Stop the watchdog interval. */
  stop(): void;
}

type AlertCondition = "high_error_rate" | "reconnect_storm" | "session_leak" | "fleet_auto_stopped";

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

const ERROR_RATE_WARN_THRESHOLD = 0.20;
const RECONNECT_STORM_THRESHOLD = 5;
const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const CHECK_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createFleetWatchdog(deps: FleetWatchdogDeps): FleetWatchdog {
  const cooldowns = new Map<string, number>();

  function canAlert(condition: string): boolean {
    const lastAlert = cooldowns.get(condition);
    if (lastAlert && Date.now() - lastAlert < COOLDOWN_MS) return false;
    cooldowns.set(condition, Date.now());
    return true;
  }

  async function sendAlert(condition: AlertCondition, title: string, message: string): Promise<void> {
    if (!deps.webhookUrl) {
      log.warn("watchdog alert (no webhook configured)", { condition, title, message });
      return;
    }

    try {
      const resp = await fetch(deps.webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // ntfy.sh compatible headers
          "Title": title,
          "Priority": condition === "fleet_auto_stopped" ? "urgent" : "high",
          "Tags": "warning,robot",
        },
        body: JSON.stringify({ condition, title, message }),
      });

      if (resp.ok) {
        log.info("watchdog alert sent", { condition, title });
      } else {
        log.error("watchdog alert failed", { condition, status: resp.status });
      }
    } catch (err) {
      log.error("watchdog alert exception", {
        condition,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function check(): Promise<void> {
    const snapshot = deps.getFleetHealth();
    const errorRate = deps.getErrorRate();

    // Check error rate >20%
    if (errorRate > ERROR_RATE_WARN_THRESHOLD) {
      if (canAlert("high_error_rate")) {
        await sendAlert(
          "high_error_rate",
          "Fleet Error Rate Warning",
          `Error rate at ${(errorRate * 100).toFixed(1)}% (threshold: ${(ERROR_RATE_WARN_THRESHOLD * 100).toFixed(0)}%). Auto-stop triggers at 30%.`,
        );
      }
    }

    // Check reconnect storms
    for (const [agent, rpm] of Object.entries(snapshot.reconnects_per_minute)) {
      if (rpm > RECONNECT_STORM_THRESHOLD) {
        const key = `reconnect_storm:${agent}`;
        if (canAlert(key)) {
          await sendAlert(
            "reconnect_storm",
            `Reconnect Storm: ${agent}`,
            `${agent} at ${rpm.toFixed(1)} reconnects/min (threshold: ${RECONNECT_STORM_THRESHOLD}).`,
          );
        }
      }
    }

    // Check session leak
    if (snapshot.session_leak) {
      if (canAlert("session_leak")) {
        await sendAlert(
          "session_leak",
          "Session Leak Detected",
          "Transport count exceeds 3x active agents. Possible MCP session leak.",
        );
      }
    }

    // Check fleet auto-stopped
    if (snapshot.auto_shutdown_reason) {
      if (canAlert("fleet_auto_stopped")) {
        await sendAlert(
          "fleet_auto_stopped",
          "Fleet Auto-Stopped",
          snapshot.auto_shutdown_reason,
        );
      }
    }
  }

  const interval = setInterval(async () => {
    try {
      await check();
    } catch (err) {
      log.error("watchdog check failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, CHECK_INTERVAL_MS);
  interval.unref();

  log.info("fleet watchdog started", {
    intervalMs: CHECK_INTERVAL_MS,
    webhookConfigured: !!deps.webhookUrl,
  });

  return {
    check,
    stop() {
      clearInterval(interval);
      log.info("fleet watchdog stopped");
    },
  };
}
