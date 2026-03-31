/**
 * Fleet Health Monitor
 *
 * Tracks per-agent connection health metrics and enforces auto-shutdown
 * triggers when agents misbehave. Exposes aggregated data for the /health
 * endpoint under a `fleet_health` key.
 *
 * Design: polling-based. The monitor calls `getAgentHealth(name)` on each tick
 * to read current metrics from the game clients (via `getConnectionHealth()`).
 * This avoids threading the monitor through every callback path in session-manager.
 *
 * Auto-shutdown triggers:
 *   - Error rate >30% sustained for 5+ minutes → stop entire fleet
 *   - Any agent >10 reconnects/minute → stop that agent
 *   - Avg connection duration <30s across last N sessions → stop that agent
 */

import { createLogger } from "../lib/logger.js";
import type { Logger } from "../lib/logger.js";

const log = createLogger("fleet-health-monitor");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-agent health data pulled from GameClient.getConnectionHealth() */
export interface AgentConnectionHealth {
  rapidDisconnects: number;
  reconnectsPerMinute: number;
  totalReconnects: number;
  lastConnectedAt: number;
  connectionDurationMs: number | null;
}

export interface FleetHealthSnapshot {
  reconnects_per_minute: Record<string, number>;
  avg_connection_duration_ms: Record<string, number | null>;
  rapid_disconnects: Record<string, number>;
  session_leak: boolean;
  auto_shutdown_reason: string | null;
}

export interface FleetHealthMonitorDeps {
  /**
   * Get current connection health for an agent.
   * Returns null if the agent has no active game client.
   * Maps to GameClient.getConnectionHealth().
   */
  getAgentHealth: (agentName: string) => AgentConnectionHealth | null;

  /** Get the names of currently active agents (running game sessions). */
  getActiveAgents: () => string[];

  /** Get the current fleet-wide error rate (0..1) from instability metrics. */
  getErrorRate: () => number;

  /** Get the current number of active MCP transport sessions. */
  getTransportCount: () => number;

  /** Stop a single agent. Returns whether the stop succeeded. */
  stopAgent: (name: string) => Promise<{ ok: boolean; message: string }>;

  /** Stop all agents in the fleet. */
  stopAllAgents: () => Promise<void>;

  /** Logger override (for testing). */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** Error rate (0..1) sustained for HIGH_ERROR_SUSTAIN_MS → stop fleet. */
const HIGH_ERROR_RATE_THRESHOLD = 0.30;
const HIGH_ERROR_SUSTAIN_MS = 5 * 60 * 1000; // 5 minutes

/** Reconnects/min → stop that agent. */
const MAX_RECONNECTS_PER_MINUTE = 10;

/**
 * Avg connection duration below this (for agents with duration data) → stop agent.
 * Uses the connectionDurationMs field from getConnectionHealth() which is the
 * current ongoing connection duration when connected, or null when disconnected.
 * We apply this check only when the agent is connected (non-null) and it's very short.
 */
const MIN_CONNECTION_DURATION_MS = 30_000; // 30 seconds

/**
 * Rapid disconnect threshold — if rapidDisconnects exceeds this on a tick,
 * additional scrutiny is logged (not a hard stop, just a warning).
 */
const RAPID_DISCONNECT_WARN_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// FleetHealthMonitor interface
// ---------------------------------------------------------------------------

export interface FleetHealthMonitor {
  /**
   * Run one evaluation tick. Polls agent health, checks thresholds, and
   * triggers auto-shutdown if needed. Register this with the LifecycleManager.
   */
  tick(): Promise<void>;

  /** Get a snapshot suitable for the /health endpoint fleet_health field. */
  getSnapshot(): FleetHealthSnapshot;

  /** Return the reason for the last auto-shutdown, or null if none. */
  getAutoShutdownReason(): string | null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createFleetHealthMonitor(deps: FleetHealthMonitorDeps): FleetHealthMonitor {
  const logger = deps.logger ?? log;

  /** Timestamp when fleet-wide error rate first exceeded the threshold. */
  let highErrorSince: number | null = null;

  /** Reason for the most recent auto-shutdown action. */
  let autoShutdownReason: string | null = null;

  // ---------------------------------------------------------------------------
  // tick
  // ---------------------------------------------------------------------------

  async function tick(): Promise<void> {
    const now = Date.now();

    // --- Fleet-wide error rate check ---
    const errorRate = deps.getErrorRate();
    if (errorRate > HIGH_ERROR_RATE_THRESHOLD) {
      if (highErrorSince === null) {
        highErrorSince = now;
        logger.warn("fleet-health: high error rate detected — starting sustain timer", {
          rate: `${(errorRate * 100).toFixed(1)}%`,
          threshold: `${(HIGH_ERROR_RATE_THRESHOLD * 100).toFixed(0)}%`,
          will_stop_after_ms: HIGH_ERROR_SUSTAIN_MS,
        });
      } else {
        const sustainedMs = now - highErrorSince;
        if (sustainedMs >= HIGH_ERROR_SUSTAIN_MS) {
          const reason = `Error rate ${(errorRate * 100).toFixed(1)}% sustained for ${Math.round(sustainedMs / 60_000)}min (threshold: ${(HIGH_ERROR_RATE_THRESHOLD * 100).toFixed(0)}%)`;
          await triggerFleetStop(reason);
          return; // Skip per-agent checks after fleet stop
        } else {
          logger.debug("fleet-health: high error rate ongoing", {
            rate: `${(errorRate * 100).toFixed(1)}%`,
            sustained_ms: sustainedMs,
            remaining_ms: HIGH_ERROR_SUSTAIN_MS - sustainedMs,
          });
        }
      }
    } else {
      // Error rate is back below threshold — reset sustain timer
      if (highErrorSince !== null) {
        logger.info("fleet-health: error rate recovered", {
          rate: `${(errorRate * 100).toFixed(1)}%`,
        });
        highErrorSince = null;
      }
    }

    // --- Per-agent checks ---
    const activeAgents = deps.getActiveAgents();
    for (const agentName of activeAgents) {
      const health = deps.getAgentHealth(agentName);
      if (!health) continue;

      // Check reconnects/minute
      if (health.reconnectsPerMinute > MAX_RECONNECTS_PER_MINUTE) {
        const reason = `${agentName}: ${health.reconnectsPerMinute.toFixed(1)} reconnects/min (threshold: ${MAX_RECONNECTS_PER_MINUTE})`;
        await triggerAgentStop(agentName, reason);
        continue;
      }

      // Check rapid disconnects (warn only — game client already handles storm cooldown)
      if (health.rapidDisconnects >= RAPID_DISCONNECT_WARN_THRESHOLD) {
        logger.warn("fleet-health: agent has rapid disconnects", {
          agent: agentName,
          rapidDisconnects: health.rapidDisconnects,
        });
      }

      // Check current connection duration: if agent is actively connected
      // and the connection has been very short (<30s), it's likely in a loop.
      // Only trigger if reconnectsPerMinute also indicates instability (>3)
      // to avoid false positives on agents that just connected.
      if (
        health.connectionDurationMs !== null &&
        health.connectionDurationMs < MIN_CONNECTION_DURATION_MS &&
        health.reconnectsPerMinute > 3
      ) {
        const reason = `${agentName}: connection duration ${Math.round(health.connectionDurationMs)}ms with ${health.reconnectsPerMinute.toFixed(1)} reconnects/min — likely in a reconnect loop`;
        await triggerAgentStop(agentName, reason);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // getSnapshot
  // ---------------------------------------------------------------------------

  function getSnapshot(): FleetHealthSnapshot {
    const activeAgents = deps.getActiveAgents();
    const transportCount = deps.getTransportCount();

    const reconnects_per_minute: Record<string, number> = {};
    const avg_connection_duration_ms: Record<string, number | null> = {};
    const rapid_disconnects: Record<string, number> = {};

    for (const name of activeAgents) {
      const health = deps.getAgentHealth(name);
      if (health) {
        reconnects_per_minute[name] = health.reconnectsPerMinute;
        avg_connection_duration_ms[name] = health.connectionDurationMs;
        rapid_disconnects[name] = health.rapidDisconnects;
      } else {
        reconnects_per_minute[name] = 0;
        avg_connection_duration_ms[name] = null;
        rapid_disconnects[name] = 0;
      }
    }

    // Session leak: more than 3x active agents worth of transports (min 10)
    const session_leak = transportCount > Math.max(activeAgents.length * 3, 10);

    return {
      reconnects_per_minute,
      avg_connection_duration_ms,
      rapid_disconnects,
      session_leak,
      auto_shutdown_reason: autoShutdownReason,
    };
  }

  // ---------------------------------------------------------------------------
  // getAutoShutdownReason
  // ---------------------------------------------------------------------------

  function getAutoShutdownReason(): string | null {
    return autoShutdownReason;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  async function triggerAgentStop(agentName: string, reason: string): Promise<void> {
    logger.warn("fleet-health: auto-stopping agent", { agent: agentName, reason });
    autoShutdownReason = reason;
    try {
      const result = await deps.stopAgent(agentName);
      if (result.ok) {
        logger.info("fleet-health: agent stopped successfully", { agent: agentName });
      } else {
        logger.error("fleet-health: agent stop returned failure", { agent: agentName, message: result.message });
      }
    } catch (err) {
      logger.error("fleet-health: exception stopping agent", {
        agent: agentName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function triggerFleetStop(reason: string): Promise<void> {
    logger.warn("fleet-health: auto-stopping entire fleet", { reason });
    autoShutdownReason = reason;
    try {
      await deps.stopAllAgents();
      logger.info("fleet-health: fleet stopped successfully");
    } catch (err) {
      logger.error("fleet-health: exception stopping fleet", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { tick, getSnapshot, getAutoShutdownReason };
}
