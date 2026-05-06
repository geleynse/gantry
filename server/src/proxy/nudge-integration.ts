/**
 * nudge-integration.ts
 * Integration point for nudge system into Gantry server
 */

import type { Logger } from "../lib/logger.js";
import { NudgeStateManager, type AgentNudgeState } from './nudge-state.js';
import { NudgeHandler } from './nudge-handler.js';
import type express from 'express';

export interface NudgeIntegrationConfig {
  retryFn: (agent_id: string) => Promise<any>;
  sessionResetFn: (agent_id: string) => Promise<void>;
  configReloadFn: (agent_id: string) => Promise<void>;
  healthCheckFn: (agent_id: string) => Promise<boolean>;
  alertOperatorFn: (agent_id: string, level: number | string, error: string, errorChain: any[]) => Promise<void>;
  logger: Logger;
}

let nudgeHandler: NudgeHandler | null = null;

export function initializeNudgeSystem(config: NudgeIntegrationConfig) {
  nudgeHandler = new NudgeHandler({
    stateManager: new NudgeStateManager(config.logger),
    ...config,
  });
  config.logger.info('[NUDGE] System initialized');
}

export async function handleToolExecutionError(agent_id: string, error: Error, error_reason: string = 'TOOL_EXECUTION_ERROR'): Promise<AgentNudgeState> {
  if (!nudgeHandler) throw new Error('Nudge system not initialized');
  return nudgeHandler.handleNudgeEscalation(agent_id, error, error_reason);
}

export function canAgentExecute(agent_id: string): boolean {
  if (!nudgeHandler) return true;
  return nudgeHandler.getAgentState(agent_id).state === 'RUNNING';
}

export function getAgentNudgeState(agent_id: string): AgentNudgeState | null {
  if (!nudgeHandler) return null;
  return nudgeHandler.getAgentState(agent_id);
}

export async function resumeAgent(agent_id: string, operatorId?: string): Promise<AgentNudgeState> {
  if (!nudgeHandler) throw new Error('Nudge system not initialized');
  return nudgeHandler.resumeIdleAgent(agent_id, operatorId);
}

export function getAllAgentStates(): AgentNudgeState[] {
  if (!nudgeHandler) return [];
  return nudgeHandler.getAllAgentStates();
}

export function registerNudgeRoutes(router: express.Router): void {
  router.get('/agent/:agent_id/nudge-state', (req, res) => {
    const state = getAgentNudgeState(req.params.agent_id);
    if (!state) return res.status(404).json({ error: 'Agent not found' });
    res.json(state);
  });

  router.get('/nudge/agents', (req, res) => {
    res.json(getAllAgentStates());
  });

  router.post('/agent/:agent_id/resume', async (req, res) => {
    try {
      const operatorId = req.body?.operator_id || req.query?.operator_id as string;
      const state = await resumeAgent(req.params.agent_id, operatorId);
      res.json({ status: 'resumed', agent_id: req.params.agent_id, state });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message, agent_id: req.params.agent_id });
    }
  });
}
