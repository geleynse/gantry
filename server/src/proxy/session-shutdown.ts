import { createLogger } from "../lib/logger.js";
import * as shutdownDb from "../services/agent-shutdown-db.js";
import type { AgentShutdownState } from "../shared/types.js";
import { logToolCallStart, logToolCallComplete } from "./tool-call-logger.js";

const log = createLogger("session_shutdown");

/**
 * Allowed tools during shutdown - agent can only perform cleanup operations
 */
const ALLOWED_SHUTDOWN_TOOLS = new Set([
  "write_diary",
  "read_diary",
  "write_doc",
  "read_doc",
  "captains_log_add",
  "captains_log_list",
  "write_report",
  "read_report",
  "search_memory",
  "search_captain_logs",
  "logout",
]);

const SHUTDOWN_MESSAGE = `Shutdown requested. You are only allowed access to these cleanup tools: ${[...ALLOWED_SHUTDOWN_TOOLS].join(", ")}. Write your final logs and call logout. Do not make any game actions.`;

/**
 * SessionShutdownManager orchestrates graceful agent shutdown.
 * Manages state transitions and enforces tool restrictions during shutdown.
 */
export class SessionShutdownManager {
  /**
   * Check if a tool is allowed during shutdown.
   */
  isAllowedToolDuringShutdown(toolName: string): boolean {
    return ALLOWED_SHUTDOWN_TOOLS.has(toolName);
  }

  /**
   * Get the list of tools allowed during shutdown.
   */
  getAllowedToolsDuringShutdown(): string[] {
    return [...ALLOWED_SHUTDOWN_TOOLS];
  }

  /**
   * Get the instruction message to inject into shutdown context.
   * This tells the agent what it can and cannot do.
   */
  getShutdownMessage(): string {
    return SHUTDOWN_MESSAGE;
  }

  /**
   * Get the current shutdown state for an agent.
   * Wrapper around agent-shutdown-db service.
   */
  getShutdownState(agentName: string): AgentShutdownState {
    return shutdownDb.getShutdownState(agentName);
  }

  /**
   * Check if an agent is currently shutting down.
   * Returns true if state is anything other than 'none'.
   */
  isShuttingDown(agentName: string): boolean {
    return this.getShutdownState(agentName) !== "none";
  }

  /**
   * Request shutdown for an agent.
   * If in battle: transitions to 'shutdown_waiting' (waits for battle to end)
   * If not in battle: transitions to 'draining' (cleanup phase)
   *
   * @returns The target shutdown state that was set
   */
  requestShutdown(
    agentName: string,
    inBattle: boolean,
    reason?: string
  ): AgentShutdownState {
    const targetState: AgentShutdownState = inBattle ? "shutdown_waiting" : "draining";

    shutdownDb.setShutdownState(agentName, targetState, reason);

    log.info(`Shutdown requested`, {
      agent: agentName,
      targetState,
      inBattle: String(inBattle),
      reason: reason ?? "none",
    });

    this._emitShutdownEvent(agentName, targetState, reason);

    return targetState;
  }

  /**
   * Request stop-after-turn for an agent.
   * The agent finishes its current turn normally (no tool restrictions),
   * then does NOT start a new turn. Sets state to 'stop_after_turn'.
   *
   * @returns The target shutdown state ('stop_after_turn')
   */
  requestStopAfterTurn(agentName: string, reason?: string): AgentShutdownState {
    const targetState: AgentShutdownState = "stop_after_turn";

    shutdownDb.setShutdownState(agentName, targetState, reason);

    log.info(`Stop-after-turn requested`, {
      agent: agentName,
      reason: reason ?? "none",
    });

    this._emitShutdownEvent(agentName, targetState, reason);

    return targetState;
  }

  /**
   * Emit a system event to the activity feed to make shutdown requests visible.
   */
  private _emitShutdownEvent(
    agentName: string,
    targetState: AgentShutdownState,
    reason?: string
  ): void {
    try {
      const pendingId = logToolCallStart(agentName, "__system_event", {
        event: "shutdown_requested",
        state: targetState,
        reason: reason ?? null,
      });
      logToolCallComplete(pendingId, agentName, "__system_event", "shutdown signal sent", 0, {
        success: true,
      });
    } catch {
      // Non-fatal: logging failure must not block shutdown
    }
  }

  /**
   * Transition an agent from 'shutdown_waiting' to 'draining'.
   * This is called when the agent is no longer in battle and ready to drain.
   *
   * @returns true if transition succeeded, false if agent was not in waiting state
   */
  transitionToDraining(agentName: string): boolean {
    const currentState = this.getShutdownState(agentName);

    if (currentState !== "shutdown_waiting") {
      log.warn(`Cannot transition to draining - not in waiting state`, {
        agent: agentName,
        currentState,
      });
      return false;
    }

    shutdownDb.setShutdownState(agentName, "draining", "Transitioned from battle wait");

    log.info(`Transitioned to draining`, {
      agent: agentName,
    });

    return true;
  }

  /**
   * Mark an agent as completely shutdown.
   * Called when the agent has completed cleanup and logged out.
   * Clears the shutdown state so the agent no longer shows as shutting down in the UI.
   */
  completeShutdown(agentName: string): void {
    shutdownDb.clearShutdownState(agentName);

    log.info(`Shutdown complete`, {
      agent: agentName,
    });
  }

  /**
   * Clear the shutdown state for an agent (delete the record).
   * Typically called when restarting an agent.
   */
  clearShutdownState(agentName: string): void {
    shutdownDb.clearShutdownState(agentName);
  }

  /**
   * Get all agents currently in shutdown (any state other than 'none').
   * Wrapper around agent-shutdown-db service, returns array of agent names.
   */
  getAgentsInShutdown(): string[] {
    const records = shutdownDb.getAgentsInShutdown();
    return records.map((r) => r.agent_name);
  }

  /**
   * Get all agents currently waiting for battle to end before draining.
   * Wrapper around agent-shutdown-db service.
   */
  getAgentsWaitingForBattle(): string[] {
    return shutdownDb.getAgentsWaitingForBattle();
  }
}

/**
 * Singleton instance of SessionShutdownManager
 */
let instance: SessionShutdownManager | null = null;

/**
 * Get or create the singleton SessionShutdownManager instance.
 */
export function getSessionShutdownManager(): SessionShutdownManager {
  if (!instance) {
    instance = new SessionShutdownManager();
  }
  return instance;
}

/**
 * Reset the singleton instance (for testing).
 */
export function resetSessionShutdownManager(): void {
  instance = null;
}
