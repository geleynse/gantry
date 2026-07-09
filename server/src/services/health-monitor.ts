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
import { hasSignal, getSignalMessage, clearSignal } from "./signals-db.js";
import { startAgent } from "./agent-manager.js";
import { hasSession, getProcessUptimeMs } from "./process-manager.js";
import type { AgentConfig } from "../config.js";
import { getFleetDisabledState } from "./fleet-control.js";
import { isRestartSuppressed } from "./overseer-stop-cooldown.js";
import { createAlert, hasRecentAlert } from "./alerts-db.js";

const log = createLogger("health-monitor");

/** Desired states for agents tracked by the monitor. */
type AgentDesiredState = "running" | "stopped";

/** Per-agent restart tracking. */
export interface AgentRestartState {
  desiredState: AgentDesiredState;
  consecutiveRestarts: number;
  nextRestartAfterMs: number; // epoch ms — don't attempt before this time
  /**
   * Armed while a normal (non-hold_offline) overseer stop cooldown is active.
   * When the cooldown expires, the monitor clears the leftover stop signals
   * from the overseer's soft stop and resumes auto-restart.
   */
  resumeAfterCooldown: boolean;
}

/** Exponential backoff delays in ms: 30s, 60s, 120s, 300s, 600s (max). */
const BACKOFF_DELAYS_MS = [30_000, 60_000, 120_000, 300_000, 600_000];

/**
 * Minimum sustained uptime before the restart backoff is forgiven. Resetting
 * on every observed-alive tick would let an agent that survives longer than
 * one tick interval between crashes restart-loop forever at the minimum delay.
 */
const BACKOFF_RESET_UPTIME_MS = 10 * 60_000;

function backoffDelayMs(restartCount: number): number {
  const index = Math.min(restartCount, BACKOFF_DELAYS_MS.length - 1);
  return BACKOFF_DELAYS_MS[index];
}

export interface HealthMonitor {
  /** Run one health check tick — call this on a timer. */
  tick(): Promise<void>;

  /**
   * Mark an agent as "should be running". Called by agent-manager on explicit
   * start (via the onStarted lifecycle hook). Does NOT reset the restart
   * backoff — startAgent fires the hook on every auto-restart attempt too, so
   * resetting here would zero the backoff the monitor just applied. The
   * backoff clears in tick() once the agent shows sustained uptime.
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
  const agentsByName = new Map<string, AgentConfig>(agents.map(a => [a.name, a]));
  const states = new Map<string, AgentRestartState>();

  function getOrInitState(name: string): AgentRestartState {
    let state = states.get(name);
    if (!state) {
      state = {
        desiredState: "stopped",
        consecutiveRestarts: 0,
        nextRestartAfterMs: 0,
        resumeAfterCooldown: false,
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
    // Retired agents (enabled:false) are never (re)started by the monitor,
    // regardless of liveness, desired state, or stop signals. A manual stop
    // alone is fragile here — the stopped_gracefully signal can be cleared
    // (consumed / server restart), flipping the agent back to restartable.
    // enabled:false is the durable "keep this agent down" switch.
    if (agentsByName.get(name)?.enabled === false) {
      getOrInitState(name).desiredState = "stopped";
      return;
    }

    const alive = await hasSession(name);
    const state = getOrInitState(name);

    if (alive) {
      state.desiredState = "running";
      state.resumeAfterCooldown = false;
      // Only forgive the restart backoff after sustained uptime — resetting on
      // every observed-alive tick would let an agent that dies shortly after
      // each restart loop forever at the minimum delay. Untracked processes
      // (external PID-file spawns) have no uptime; treat them as stable.
      const uptimeMs = getProcessUptimeMs(name);
      if (uptimeMs === null || uptimeMs >= BACKOFF_RESET_UPTIME_MS) {
        state.consecutiveRestarts = 0;
        state.nextRestartAfterMs = 0;
      }
      return;
    }

    // Agent is not running. Decide whether to restart.

    // Case 0: Overseer stop cooldown — checked before the desired-state and
    // stop-signal cases because an overseer soft stop ALSO sets both (the
    // onStopped hook calls markStopped, and softStopAgent leaves a
    // stopped_gracefully signal). If those cases ran first they would latch
    // desiredState="stopped" and the documented 1h auto-resume could never fire.
    const cooldown = isRestartSuppressed(name);
    if (cooldown.suppressed && cooldown.stoppedUntil) {
      const remainingMin = Math.round((cooldown.stoppedUntil.getTime() - Date.now()) / 60_000);
      // Log once per suppression episode, not on every 30s tick.
      const alreadyLatched = cooldown.holdOffline
        ? state.desiredState === "stopped" && !state.resumeAfterCooldown
        : state.resumeAfterCooldown;
      if (!alreadyLatched) {
        log.info(
          cooldown.holdOffline
            ? "Auto-restart suppressed — overseer hold_offline set (operator must manually start)"
            : "Auto-restart suppressed — overseer stop cooldown active",
          {
            agent: name,
            stoppedUntil: cooldown.stoppedUntil.toISOString(),
            remainingMin,
            holdOffline: cooldown.holdOffline ?? false,
            reason: cooldown.reason,
          },
        );
      }
      // Preserve desiredState="running" for normal cooldowns so the monitor
      // resumes auto-restart when the timestamp expires. Only indefinite
      // hold_offline should move the agent to a manual-start state.
      if (cooldown.holdOffline) {
        state.desiredState = "stopped";
        state.resumeAfterCooldown = false;
      } else {
        state.desiredState = "running";
        state.resumeAfterCooldown = true;
      }
      return;
    }

    // Cooldown just expired with auto-resume armed: the stop signals belong to
    // the overseer's soft stop, not an operator — clear them so Case 2 doesn't
    // latch the agent into a manual-start state.
    if (state.resumeAfterCooldown) {
      state.resumeAfterCooldown = false;
      state.desiredState = "running";
      clearSignal(name, "stopped_gracefully");
      clearSignal(name, "shutdown");
      log.info("Overseer stop cooldown expired — resuming auto-restart", { agent: name });
    }

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

      // If the stop reason is a provider rate limit, file an operator alert so
      // the agent doesn't silently stay down overnight.  Guard for idempotence:
      // only insert if no unacknowledged quota_exhausted alert exists in the last 24h.
      if (stoppedGracefully) {
        const stopMessage = getSignalMessage(name, "stopped_gracefully");
        if (stopMessage === "rate_limit" && !hasRecentAlert(name, "quota_exhausted")) {
          const backend = agentsByName.get(name)?.backend ?? "unknown";
          createAlert(
            name,
            "warning",
            "quota_exhausted",
            `Agent stopped: LLM provider rate limit hit. Restart manually once the quota window reopens (typically next hour or next day depending on provider). Backend: ${backend}.`,
          );
          log.warn("Filed quota_exhausted alert for agent", { agent: name, backend });
        }
      }

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
    state.resumeAfterCooldown = false;
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
