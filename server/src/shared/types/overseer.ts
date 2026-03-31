/**
 * Type definitions for the overseer agent.
 * The overseer monitors fleet health and issues corrective actions autonomously.
 */

export interface OverseerConfig {
  enabled: boolean;
  model: string;
  intervalMinutes: number;
  cooldownSeconds: number;
  maxActionsPerTick: number;
  eventTriggers: string[];
  creditThreshold: number;
  historyWindow: number;
}

export const DEFAULT_OVERSEER_CONFIG: OverseerConfig = {
  enabled: false,
  model: "haiku",
  intervalMinutes: 10,
  cooldownSeconds: 60,
  maxActionsPerTick: 5,
  eventTriggers: ["agent_stranded", "agent_died", "agent_stopped", "credits_critical", "combat_alert"],
  creditThreshold: 1000,
  historyWindow: 3,
};

export type OverseerActionType =
  | "issue_order"
  | "trigger_routine"
  | "start_agent"
  | "stop_agent"
  | "reassign_role"
  | "no_action";

export interface OverseerAction {
  type: OverseerActionType;
  params: Record<string, unknown>;
}

export interface ActionResult {
  action: OverseerAction;
  success: boolean;
  message: string;
}

export type OverseerState = "idle" | "thinking" | "executing" | "stopped";
export type OverseerDecisionStatus = "success" | "error" | "no_action";

export interface OverseerDecision {
  id: number;
  tick_number: number;
  triggered_by: string;
  snapshot_json: string;
  prompt_text: string | null;
  response_json: string;
  actions_json: string;
  results_json: string;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_estimate: number | null;
  status: OverseerDecisionStatus;
  duration_ms: number | null;
  created_at: string;
}

export interface OverseerStatus {
  state: OverseerState;
  enabled: boolean;
  tickNumber: number;
  lastTickAt: string | null;
  lastTriggeredBy: string | null;
  nextTickAt: string | null;
  model: string;
  costToday: number;
  decisionsToday: number;
  config: OverseerConfig;
}
