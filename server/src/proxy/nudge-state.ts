/**
 * nudge-state.ts
 * State machine and tracking for escalating nudge system
 */

import type { Logger } from "../lib/logger.js";

export type AgentState = 'RUNNING' | 'NUDGE_LEVEL_1' | 'NUDGE_LEVEL_2' | 'NUDGE_LEVEL_3' | 'IDLE';

export interface ErrorChainEntry {
  level: number;
  reason: string;
  timestamp: number;
  duration_ms?: number;
}

export interface NudgeContext {
  level: number;
  attempt_count: number;
  first_failure_at: number | null;
  last_attempt_at: number | null;
  error_chain: ErrorChainEntry[];
}

export interface IdleContext {
  transitioned_at: number | null;
  grace_period_ends_at: number | null;
  reason: string | null;
}

export interface AgentNudgeState {
  agent_id: string;
  state: AgentState;
  nudge_context: NudgeContext;
  idle_context: IdleContext;
  last_error?: string;
  last_turn?: number;
  pending_orders?: string[];
}

function createBlankNudgeContext(): NudgeContext {
  return { level: 0, attempt_count: 0, first_failure_at: null, last_attempt_at: null, error_chain: [] };
}

const NUDGE_L1_TIMEOUT = 60_000;      // 60 seconds to reach L2
const NUDGE_L2_TIMEOUT = 120_000;     // 120 seconds to reach L3
const NUDGE_L2_BACKOFF = 30_000;      // 30 seconds backoff before retry
const IDLE_GRACE_PERIOD = 5 * 60_000; // 5 minutes grace period

/**
 * NudgeStateManager: Handles all state transitions and tracking
 */
export class NudgeStateManager {
  private states: Map<string, AgentNudgeState> = new Map();
  private logger: Logger;

  constructor(logger?: Logger) {
    this.logger = logger || { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  }

  /**
   * Initialize or retrieve nudge state for an agent
   */
  getState(agent_id: string): AgentNudgeState {
    let state = this.states.get(agent_id);
    if (!state) {
      state = this.createInitialState(agent_id);
      this.states.set(agent_id, state);
    }
    return state;
  }

  /**
   * Create initial state for a new agent
   */
  private createInitialState(agent_id: string): AgentNudgeState {
    return {
      agent_id,
      state: 'RUNNING',
      nudge_context: createBlankNudgeContext(),
      idle_context: {
        transitioned_at: null,
        grace_period_ends_at: null,
        reason: null,
      },
    };
  }

  /**
   * Record an error and determine next nudge level
   */
  recordError(agent_id: string, error_reason: string): AgentNudgeState {
    const state = this.getState(agent_id);
    const now = Date.now();
    const ctx = state.nudge_context;

    // Initialize on first failure
    if (ctx.level === 0) {
      ctx.first_failure_at = now;
      ctx.level = 1;
      state.state = 'NUDGE_LEVEL_1';
      this.logger.warn(`NUDGE_L1 ${agent_id} ${error_reason}`);
    }

    // Track error
    ctx.error_chain.push({
      level: ctx.level,
      reason: error_reason,
      timestamp: now,
    });

    ctx.last_attempt_at = now;
    ctx.attempt_count++;

    return state;
  }

  /**
   * Advance to next nudge level
   */
  advanceLevel(agent_id: string): boolean {
    const state = this.getState(agent_id);
    const ctx = state.nudge_context;
    const now = Date.now();
    const time_since_first = ctx.first_failure_at ? now - ctx.first_failure_at : 0;

    switch (ctx.level) {
      case 1:
        // L1 -> L2
        if (time_since_first < NUDGE_L1_TIMEOUT) {
          ctx.level = 2;
          state.state = 'NUDGE_LEVEL_2';
          this.logger.warn(`NUDGE_L2 ${agent_id} advancing from L1`);
          return true;
        } else {
          this.logger.error(`NUDGE_TIMEOUT_L1 ${agent_id}`);
          return false;
        }

      case 2:
        // L2 -> L3
        if (time_since_first < NUDGE_L2_TIMEOUT) {
          ctx.level = 3;
          state.state = 'NUDGE_LEVEL_3';
          this.logger.warn(`NUDGE_L3 ${agent_id} advancing from L2`);
          return true;
        } else {
          this.logger.error(`NUDGE_TIMEOUT_L2 ${agent_id}`);
          return false;
        }

      case 3:
        return false;

      default:
        return false;
    }
  }

  /**
   * Mark a nudge as successful
   */
  nudgeSuccess(agent_id: string, level: number): AgentNudgeState {
    const state = this.getState(agent_id);
    state.state = 'RUNNING';
    state.nudge_context = createBlankNudgeContext();
    this.logger.info(`NUDGE_RECOVERED ${agent_id} from_level=${level}`);
    return state;
  }

  /**
   * Transition agent to IDLE state
   */
  transitionToIdle(agent_id: string, reason: string): AgentNudgeState {
    const state = this.getState(agent_id);
    const now = Date.now();

    state.state = 'IDLE';
    state.idle_context.transitioned_at = now;
    state.idle_context.grace_period_ends_at = now + IDLE_GRACE_PERIOD;
    state.idle_context.reason = reason;

    this.logger.error(`IDLE_TRANSITION ${agent_id} reason=${reason}`);

    return state;
  }

  /**
   * Check if agent is in IDLE and grace period has expired
   */
  isIdleGracePeriodExpired(agent_id: string): boolean {
    const state = this.getState(agent_id);
    if (state.state !== 'IDLE' || !state.idle_context.grace_period_ends_at) {
      return false;
    }
    return Date.now() >= state.idle_context.grace_period_ends_at;
  }

  /**
   * Extend IDLE grace period by another cycle
   */
  extendIdleGracePeriod(agent_id: string): AgentNudgeState {
    const state = this.getState(agent_id);
    const now = Date.now();
    state.idle_context.grace_period_ends_at = now + IDLE_GRACE_PERIOD;
    this.logger.info(`IDLE_GRACE_EXTENDED ${agent_id}`);
    return state;
  }

  /**
   * Resume agent from IDLE state
   */
  resumeFromIdle(agent_id: string, resumeType: 'auto' | 'manual' = 'manual', operatorId?: string): AgentNudgeState {
    const state = this.getState(agent_id);
    
    if (state.state !== 'IDLE') {
      throw new Error(`Agent ${agent_id} is not in IDLE state`);
    }

    state.state = 'RUNNING';
    state.nudge_context = createBlankNudgeContext();

    // Clear idle context
    state.idle_context = {
      transitioned_at: null,
      grace_period_ends_at: null,
      reason: null,
    };

    this.logger.info(`IDLE_RECOVERY ${agent_id} type=${resumeType} operator=${operatorId || 'none'}`);

    return state;
  }

  /**
   * Get backoff duration for current nudge level
   */
  getBackoffDuration(agent_id: string): number {
    return this.getState(agent_id).nudge_context.level === 2 ? NUDGE_L2_BACKOFF : 0;
  }

  /**
   * Get time remaining in grace period
   */
  getIdleGraceTimeRemaining(agent_id: string): number {
    const state = this.getState(agent_id);
    if (state.state !== 'IDLE' || !state.idle_context.grace_period_ends_at) {
      return 0;
    }
    const remaining = state.idle_context.grace_period_ends_at - Date.now();
    return Math.max(0, remaining);
  }

  /**
   * Get summary of all agent states
   */
  getAllStates(): AgentNudgeState[] {
    return Array.from(this.states.values());
  }

  /**
   * Get agents in specific state
   */
  getAgentsByState(targetState: AgentState): AgentNudgeState[] {
    return Array.from(this.states.values()).filter(s => s.state === targetState);
  }

  /**
   * Clear state for an agent
   */
  clearState(agent_id: string): void {
    this.states.delete(agent_id);
    this.logger.info(`STATE_CLEARED ${agent_id}`);
  }
}
