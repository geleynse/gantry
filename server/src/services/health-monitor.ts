/**
 * Agent Health Monitor
 *
 * Watches configured agents and auto-restarts them if they crash.
 * Only restarts agents whose desired state is "running" — i.e. agents that
 * were explicitly started and have not been manually stopped.
 *
 * Manual stops are identified by the presence of a `stopped_gracefully` or
 * `shutdown` signal in the signals DB. If neither signal is present and the
 * agent process is dead, the agent is assumed to have crashed.
 *
 * Restart attempts use exponential backoff: 30s → 60s → 120s → 300s → 600s max.
 */

import { createLogger } from "../lib/logger.js";
import { hasSignal } from "./signals-db.js";
import { startAgent } from "./agent-manager.js";
import { hasSession } from "./process-manager.js";
import type { AgentConfig } from "../config.js";
import { getFleetDisabledState } from "./fleet-control.js";

const log = createLogger("health-monitor");

/** Desired states for agents tracked by the monitor. */
type AgentDesiredState = "running" | "stopped";

/** Per-agent restart tracking. */
export interface AgentRestartState {
  desiredState: AgentDesiredState;
  consecutiveRestarts: number;
  nextRestartAfterMs: number; // epoch ms — don't attempt before this time
}

/** Exponential backoff delays in ms: 30s, 60s, 120s, 300s, 600s (max). */
const BACKOFF_DELAYS_MS = [30_000, 60_000, 120_000, 300_000, 600_000];

function backoffDelayMs(restartCount: number): number {
  const index = Math.min(restartCount, BACKOFF_DELAYS_MS.length - 1);
  return BACKOFF_DELAYS_MS[index];
}

export interface HealthMonitor {
  /** Run one health check tick — call this on a timer. */
  tick(): Promise<void>;

  /**
   * Mark an agent as "should be running". Called by the health monitor
   * itself when it observes an agent is alive, or by agent-manager on explicit start.
   * Resets consecutive restart counter.
   */
  markRunning(agentName: string): void;

  /**
   * Mark an agent as intentionally stopped. The monitor will not restart it.
   * Called by agent-manager on explicit stop (force or soft).
   */
  markStopped(agentName: string): void;

  /** Return current restart state for an agent (for observability/testing). */
  getState(agentName: string): AgentRestartState | undefined;

  /** Return restart state for all tracked agents as a plain object. */
  getAllStates(): Record<string, AgentRestartState>;
}

export function createHealthMonitor(agents: AgentConfig[]): HealthMonitor {
  const agentNames = agents.map(a => a.name);
  const states = new Map<string, AgentRestartState>();

  function getOrInitState(name: string): AgentRestartState {
    let state = states.get(name);
    if (!state) {
      state = {
        desiredState: "stopped",
        consecutiveRestarts: 0,
        nextRestartAfterMs: 0,
      };
      states.set(name, state);
    }
    return state;
  }

  async function tick(): Promise<void> {
    const fleetDisabled = getFleetDisabledState();
    if (fleetDisabled.disabled) {
      for (const name of agentNames) markStopped(name);
      log.debug("Health monitor skipped because fleet is disabled", {
        reason: fleetDisabled.reason,
      });
      return;
    }

    for (const name of agentNames) {
      try {
        await checkAgent(name);
      } catch (err) {
        log.warn("Health check failed for agent", {
          agent: name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  async function checkAgent(name: string): Promise<void> {
    const alive = await hasSession(name);

    if (alive) {
      markRunning(name);
      return;
    }

    const state = getOrInitState(name);

    // Agent is not running. Decide whether to restart.

    // Case 1: Desired state is "stopped" — manual stop, don't restart.
    if (state.desiredState === "stopped") {
      return;
    }

    // Case 2: Desired state is "running" but signals indicate intentional stop.
    // stopped_gracefully = soft stop completed; shutdown = stop signal pending/received.
    const stoppedGracefully = hasSignal(name, "stopped_gracefully");
    const shutdownPending = hasSignal(name, "shutdown");
    if (stoppedGracefully || shutdownPending) {
      // Agent stopped intentionally via the stop API — don't auto-restart.
      state.desiredState = "stopped";
      return;
    }

    // Case 3: Agent was running, signals are clear, but it's now dead — it crashed.
    const now = Date.now();
    if (now < state.nextRestartAfterMs) {
      const waitSec = Math.round((state.nextRestartAfterMs - now) / 1000);
      log.debug("Skipping restart — backoff active", {
        agent: name,
        waitSec,
        attempt: state.consecutiveRestarts,
      });
      return;
    }

    const delay = backoffDelayMs(state.consecutiveRestarts);
    state.consecutiveRestarts++;
    state.nextRestartAfterMs = now + delay;

    log.warn("Agent crashed — attempting restart", {
      agent: name,
      attempt: state.consecutiveRestarts,
      nextBackoffMs: delay,
    });

    const result = await startAgent(name);
    if (result.ok) {
      log.info("Agent restarted successfully", {
        agent: name,
        attempt: state.consecutiveRestarts,
      });
    } else {
      log.error("Agent restart failed", {
        agent: name,
        attempt: state.consecutiveRestarts,
        reason: result.message,
      });
    }
  }

  function markRunning(agentName: string): void {
    const state = getOrInitState(agentName);
    state.desiredState = "running";
    state.consecutiveRestarts = 0;
    state.nextRestartAfterMs = 0;
  }

  function markStopped(agentName: string): void {
    const state = getOrInitState(agentName);
    state.desiredState = "stopped";
  }

  function getState(agentName: string): AgentRestartState | undefined {
    return states.get(agentName);
  }

  function getAllStates(): Record<string, AgentRestartState> {
    return Object.fromEntries(states);
  }

  return { tick, markRunning, markStopped, getState, getAllStates };
}
