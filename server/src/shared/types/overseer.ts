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

