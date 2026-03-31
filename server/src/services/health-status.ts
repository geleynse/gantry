/**
 * Game server health status service.
 *
 * Computes a high-level UP / DEGRADED / DOWN status from the proxy's
 * circuit breaker state, game health poller data, and error tracking.
 * All data is read from in-memory caches — no game server calls.
 */

import type { BreakerRegistry } from "../proxy/circuit-breaker.js";
import type { MetricsWindow } from "../proxy/instability-metrics.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("health-status");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ServerStatus = "up" | "degraded" | "down";

export interface GameHealthRef {
  current: { tick: number; version: string; fetchedAt: number } | null;
}

export interface ServerStatusResponse {
  status: ServerStatus;
  version: string | null;
  timestamp: string;
  latency_ms: number | null;

  circuit_breaker: {
    state: "closed" | "open" | "half-open";
    consecutive_failures: number;
    cooldown_remaining_ms?: number;
  };

  last_health_check: string | null;
  check_interval_seconds: number;
  notes: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Health poll interval used by the proxy (matches server.ts HEALTH_INTERVAL_MS). */
const HEALTH_INTERVAL_S = 10;

/** If we haven't heard from the game server in this many seconds, it's DOWN. */
const DOWN_THRESHOLD_S = 120;

/** If the last health check is older than this, consider it DEGRADED. */
const DEGRADED_AGE_THRESHOLD_S = 60;

// ---------------------------------------------------------------------------
// Status computation
// ---------------------------------------------------------------------------

export function computeServerStatus(healthRef: GameHealthRef, breakerRegistry: BreakerRegistry, serverMetrics: MetricsWindow): ServerStatusResponse {
  try {
    const now = Date.now();
    const breaker = breakerRegistry.getAggregateStatus();
    const gh = healthRef.current;
    const healthAgeS = gh ? Math.round((now - gh.fetchedAt) / 1000) : null;

    // Determine high-level status
    let status: ServerStatus;
    let notes: string;

    if (!gh) {
      // Never received a health check
      status = "down";
      notes = "No health data received from game server";
    } else if (healthAgeS! > DOWN_THRESHOLD_S) {
      status = "down";
      notes = `Last health check was ${healthAgeS}s ago (threshold: ${DOWN_THRESHOLD_S}s)`;
    } else if (breaker.state === "open") {
      status = "down";
      notes = `Circuit breaker OPEN after ${breaker.failures} consecutive failures`;
    } else if (breaker.state === "half-open") {
      status = "degraded";
      notes = "Circuit breaker probing — recovering from failure";
    } else if (healthAgeS! > DEGRADED_AGE_THRESHOLD_S) {
      status = "degraded";
      notes = `Health check stale (${healthAgeS}s old)`;
    } else if (breaker.failures > 0) {
      status = "degraded";
      notes = `${breaker.failures} recent failure(s) but circuit still closed`;
    } else {
      // Cross-check with instability metrics (finer-grained: healthy/degraded/unstable/down)
      const metrics = serverMetrics.getMetrics();
      if (metrics.status === "unstable" || metrics.status === "down") {
        status = "down";
        notes = `Instability metrics: ${metrics.reason}`;
      } else if (metrics.status === "degraded") {
        status = "degraded";
        notes = `Instability metrics: ${metrics.reason}`;
      } else {
        status = "up";
        notes = "All systems nominal";
      }
    }

    return {
      status,
      version: gh?.version ?? null,
      timestamp: new Date(now).toISOString(),
      latency_ms: null,

      circuit_breaker: {
        state: breaker.state,
        consecutive_failures: breaker.failures,
        ...(breaker.cooldown_remaining_ms != null
          ? { cooldown_remaining_ms: breaker.cooldown_remaining_ms }
          : {}),
      },

      last_health_check: gh ? new Date(gh.fetchedAt).toISOString() : null,
      check_interval_seconds: HEALTH_INTERVAL_S,
      notes,
    };
  } catch (error) {
    log.error("Error computing server status", { error: String(error) });
    return {
      status: "down",
      version: null,
      timestamp: new Date().toISOString(),
      latency_ms: null,
      circuit_breaker: {
        state: "open",
        consecutive_failures: 0,
      },
      last_health_check: null,
      check_interval_seconds: HEALTH_INTERVAL_S,
      notes: `Error during status computation: ${error}`,
    };
  }
}
