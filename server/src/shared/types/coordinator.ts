/**
 * Type definitions for the supply-chain coordinator.
 * The coordinator assigns roles to fleet agents and delivers orders via fleet_orders.
 */

export type CoordinatorRole = "miner" | "crafter" | "trader" | "scout" | "combat";

export interface CoordinatorAssignment {
  /** Agent name this assignment is for */
  agent: string;
  /** Role assigned to the agent */
  role: CoordinatorRole;
  /** Routine name to execute */
  routine: string;
  /** Routine parameters */
  params: Record<string, unknown>;
  /** Priority level */
  priority: "normal" | "urgent";
  /** Human-readable explanation for the assignment */
  reason: string;
  /** Optional quota tracking */
  quota?: {
    item_id: string;
    target_quantity: number;
    current_quantity: number;
  };
  /** ISO timestamp when this assignment expires (null = next coordinator tick) */
  expires_at?: string;
  /** Agent's operating zone at time of assignment */
  zone?: string;
}

export interface CoordinatorQuota {
  id: number;
  item_id: string;
  target_quantity: number;
  current_quantity: number;
  assigned_to: string | null;
  station_id: string;
  created_at: string;
  completed_at: string | null;
  status: "active" | "completed" | "cancelled";
}

export interface CoordinatorConfig {
  /** Whether the coordinator is active */
  enabled: boolean;
  /** Tick interval in minutes */
  intervalMinutes: number;
  /** Target fleet role distribution */
  defaultDistribution: {
    miners: number;
    crafters: number;
    traders: number;
    flex: number;
  };
  /** Quota system defaults */
  quotaDefaults: {
    batchSize: number;
    maxActiveQuotas: number;
  };
}

export interface CoordinatorTickResult {
  /** Monotonically increasing tick number */
  tick_number: number;
  /** ISO timestamp when tick ran */
  tick_at: string;
  /** Assignments generated during this tick */
  assignments: CoordinatorAssignment[];
  /** Number of quotas updated */
  quotas_updated: number;
  /** Per-agent state snapshot at tick time */
  fleet_snapshot: Record<string, unknown>;
  /** Top arbitrage opportunities at tick time */
  market_snapshot: unknown[];
  /** Whether the coordinator was enabled when this tick ran */
  enabled: boolean;
}

/** Default coordinator config when none is specified */
export const DEFAULT_COORDINATOR_CONFIG: CoordinatorConfig = {
  enabled: false,
  intervalMinutes: 10,
  defaultDistribution: {
    miners: 2,
    crafters: 1,
    traders: 1,
    flex: 1,
  },
  quotaDefaults: {
    batchSize: 50,
    maxActiveQuotas: 10,
  },
};
