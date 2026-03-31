/**
 * nudge-handler.ts
 * Core nudge escalation logic
 */

import type { Logger } from "../lib/logger.js";
import { NudgeStateManager, AgentNudgeState } from './nudge-state.js';

export interface NudgeHandlerConfig {
  stateManager: NudgeStateManager;
  retryFn: (agent_id: string) => Promise<any>;
  sessionResetFn: (agent_id: string) => Promise<void>;
  configReloadFn: (agent_id: string) => Promise<void>;
  healthCheckFn: (agent_id: string) => Promise<boolean>;
  alertOperatorFn: (agent_id: string, level: number, error: string, errorChain: any[]) => Promise<void>;
  logger: Logger;
}

export class NudgeHandler {
  private config: NudgeHandlerConfig;

  constructor(config: NudgeHandlerConfig) {
    this.config = config;
  }

  async handleNudgeEscalation(agent_id: string, error: Error, error_reason: string): Promise<AgentNudgeState> {
    const state = this.config.stateManager.recordError(agent_id, error_reason);

    switch (state.nudge_context.level) {
      case 1: return this.executeNudgeLevel1(agent_id);
      case 2: return this.executeNudgeLevel2(agent_id);
      case 3: return this.executeNudgeLevel3(agent_id);
      default: return state;
    }
  }

  /** Try a simple retry; on failure, advance to L2 or idle. */
  private async executeNudgeLevel1(agent_id: string): Promise<AgentNudgeState> {
    try {
      await this.config.retryFn(agent_id);
      return this.config.stateManager.nudgeSuccess(agent_id, 1);
    } catch {
      return this.advanceOrIdle(agent_id, () => this.executeNudgeLevel2(agent_id));
    }
  }

  /** Backoff + session reset + retry; on failure, advance to L3 or idle. */
  private async executeNudgeLevel2(agent_id: string): Promise<AgentNudgeState> {
    try {
      const backoff = this.config.stateManager.getBackoffDuration(agent_id);
      if (backoff > 0) await new Promise(r => setTimeout(r, backoff));
      await this.config.sessionResetFn(agent_id);
      await this.config.configReloadFn(agent_id);
      await this.config.retryFn(agent_id);
      return this.config.stateManager.nudgeSuccess(agent_id, 2);
    } catch {
      return this.advanceOrIdle(agent_id, () => this.executeNudgeLevel3(agent_id));
    }
  }

  /** Alert operator + full reset + retry; on failure, idle. */
  private async executeNudgeLevel3(agent_id: string): Promise<AgentNudgeState> {
    const state = this.config.stateManager.getState(agent_id);
    try {
      await this.config.alertOperatorFn(agent_id, 3, state.last_error || 'unknown', state.nudge_context.error_chain);
      await this.config.sessionResetFn(agent_id);
      await this.config.configReloadFn(agent_id);
      await this.config.retryFn(agent_id);
      return this.config.stateManager.nudgeSuccess(agent_id, 3);
    } catch {
      return this.transitionToIdleWithAlert(agent_id);
    }
  }

  /** Advance nudge level if allowed; otherwise transition to idle. */
  private async advanceOrIdle(agent_id: string, nextLevel: () => Promise<AgentNudgeState>): Promise<AgentNudgeState> {
    const canAdvance = this.config.stateManager.advanceLevel(agent_id);
    return canAdvance ? nextLevel() : this.transitionToIdleWithAlert(agent_id);
  }

  private transitionToIdleWithAlert(agent_id: string): AgentNudgeState {
    const state = this.config.stateManager.getState(agent_id);
    const idleState = this.config.stateManager.transitionToIdle(agent_id, 'nudge_failed');

    this.config.alertOperatorFn(agent_id, 0, state.last_error || 'unknown', state.nudge_context.error_chain).catch(() => {});

    return idleState;
  }

  async handleIdleAgent(agent_id: string): Promise<AgentNudgeState> {
    const state = this.config.stateManager.getState(agent_id);
    if (state.state !== 'IDLE') return state;

    if (!this.config.stateManager.isIdleGracePeriodExpired(agent_id)) {
      return state;
    }

    try {
      const isHealthy = await this.config.healthCheckFn(agent_id);
      if (isHealthy) {
        return this.config.stateManager.resumeFromIdle(agent_id, 'auto');
      } else {
        return this.config.stateManager.extendIdleGracePeriod(agent_id);
      }
    } catch {
      return this.config.stateManager.extendIdleGracePeriod(agent_id);
    }
  }

  async resumeIdleAgent(agent_id: string, operatorId?: string): Promise<AgentNudgeState> {
    const state = this.config.stateManager.getState(agent_id);
    if (state.state !== 'IDLE') throw new Error(`Agent ${agent_id} is not in IDLE state`);
    return this.config.stateManager.resumeFromIdle(agent_id, 'manual', operatorId);
  }

  getAgentState(agent_id: string): AgentNudgeState {
    return this.config.stateManager.getState(agent_id);
  }

  getAllAgentStates(): AgentNudgeState[] {
    return this.config.stateManager.getAllStates();
  }
}
