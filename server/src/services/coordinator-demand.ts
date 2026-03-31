/**
 * Demand analysis for the supply-chain coordinator.
 *
 * Pure functions that analyze market data and agent state to determine
 * what the fleet needs and which role each agent should play.
 * No side effects — easy to test independently.
 */

import type { ArbitrageOpportunity } from "../proxy/arbitrage-analyzer.js";
import type { CoordinatorRole, CoordinatorConfig, CoordinatorQuota } from "../shared/types/coordinator.js";

/** Simplified agent state for role suggestion */
export interface AgentSnapshot {
  name: string;
  faction?: string;
  operatingZone?: string;
  role?: string; // from fleet-config (e.g., "Trader/Mining")
  credits?: number;
  creditsTrend?: number; // positive = earning, negative = losing
  system?: string;
  poi?: string;
  docked?: boolean;
  cargoUsed?: number;
  cargoMax?: number;
  fuel?: number;
  fuelMax?: number;
  isOnline: boolean;
  isInCombat?: boolean;
  lastToolCallAge?: number; // seconds since last tool call
  currentRole?: CoordinatorRole; // from previous coordinator assignment
}

/** Fleet-wide demand analysis result */
export interface FleetDemand {
  /** Items with profitable arbitrage opportunities */
  arbitrageItems: ArbitrageOpportunity[];
  /** Active quotas that need work */
  activeQuotas: CoordinatorQuota[];
  /** Target role distribution for the fleet */
  roleBalance: {
    target: Record<CoordinatorRole, number>;
  };
}

/** Role suggestion for a single agent */
export interface RoleSuggestion {
  role: CoordinatorRole;
  routine: string;
  params: Record<string, unknown>;
  reason: string;
  quota?: {
    item_id: string;
    target_quantity: number;
    current_quantity: number;
  };
}

/** Map of roles to their primary routines */
const ROLE_ROUTINES: Record<CoordinatorRole, string> = {
  miner: "navigate_and_mine",
  crafter: "craft_and_sell",
  trader: "supply_run",
  scout: "explore_system",
  combat: "patrol_and_attack",
};

/**
 * Analyze fleet-wide demand from market data and active quotas.
 * Returns a summary of what the fleet needs.
 */
export function analyzeFleetDemand(
  arbitrageData: ArbitrageOpportunity[],
  currentQuotas: CoordinatorQuota[],
  config: CoordinatorConfig,
  onlineAgentCount: number,
): FleetDemand {
  const highMarginItems = arbitrageData.filter((a) => a.profit_margin_pct >= 15);
  const activeQuotas = currentQuotas.filter((q) => q.status === "active");

  // Calculate target distribution scaled to online agents
  const dist = config.defaultDistribution;
  const totalSlots = dist.miners + dist.crafters + dist.traders + dist.flex;
  const scale = onlineAgentCount / totalSlots;

  const target: Record<CoordinatorRole, number> = {
    miner: Math.round(dist.miners * scale),
    crafter: Math.round(dist.crafters * scale),
    trader: Math.round(dist.traders * scale),
    scout: 0,
    combat: 0,
  };

  // Flex slots default to trader
  const flexSlots = Math.max(0, onlineAgentCount - target.miner - target.crafter - target.trader);
  target.trader += flexSlots;

  // Ensure at least 1 miner if any agents are online
  if (onlineAgentCount > 0 && target.miner === 0) {
    target.miner = 1;
    target.trader = Math.max(0, target.trader - 1);
  }

  return {
    arbitrageItems: highMarginItems,
    activeQuotas,
    roleBalance: {
      target,
    },
  };
}

/**
 * Suggest the best role for an agent given fleet needs and the agent's current state.
 * Pure function — does not modify any state.
 */
export function suggestRole(
  agent: AgentSnapshot,
  demand: FleetDemand,
  currentAssignments: Map<string, CoordinatorRole>,
  _config: CoordinatorConfig,
): RoleSuggestion {
  // Rule: Don't reassign mid-routine (active within last 2 minutes)
  if (agent.lastToolCallAge !== undefined && agent.lastToolCallAge < 120) {
    if (agent.currentRole) {
      return {
        role: agent.currentRole,
        routine: ROLE_ROUTINES[agent.currentRole],
        params: {},
        reason: "Continuing current routine (active within last 2 minutes).",
      };
    }
  }

  // Rule: Agent in combat → keep as combat
  if (agent.isInCombat) {
    return {
      role: "combat",
      routine: "patrol_and_attack",
      params: {},
      reason: "Agent is currently in combat.",
    };
  }

  // Rule: Prefer continuity with positive credits trend
  if (agent.currentRole && agent.creditsTrend !== undefined && agent.creditsTrend > 0) {
    return {
      role: agent.currentRole,
      routine: ROLE_ROUTINES[agent.currentRole],
      params: {},
      reason: `Continuing ${agent.currentRole} role (positive credits trend: +${agent.creditsTrend}).`,
    };
  }

  // Count current role assignments (from other agents already assigned this tick)
  const roleCounts: Record<CoordinatorRole, number> = {
    miner: 0, crafter: 0, trader: 0, scout: 0, combat: 0,
  };
  for (const [, role] of currentAssignments) {
    roleCounts[role]++;
  }

  // Rule: Balance the fleet — find the most-needed role
  const target = demand.roleBalance.target;
  let bestRole: CoordinatorRole = "trader"; // default fallback
  let biggestGap = -Infinity;

  for (const role of ["miner", "crafter", "trader", "scout", "combat"] as CoordinatorRole[]) {
    const gap = target[role] - roleCounts[role];
    if (gap > biggestGap) {
      biggestGap = gap;
      bestRole = role;
    }
  }

  // Build params based on role
  const params: Record<string, unknown> = {};
  let reason = `Fleet needs more ${bestRole}s (${roleCounts[bestRole]}/${target[bestRole]}).`;

  // If there are active quotas, prefer assigning to fulfil them
  // Prefer quotas whose zone matches the agent's operating zone
  if (bestRole === "miner" && demand.activeQuotas.length > 0) {
    const eligibleQuotas = demand.activeQuotas.filter(
      (q) => !q.assigned_to || q.assigned_to === agent.name,
    );
    // Sort by zone proximity (best match first)
    const quota = eligibleQuotas.sort((a, b) => {
      const zoneA = (a as unknown as Record<string, unknown>).zone as string | undefined;
      const zoneB = (b as unknown as Record<string, unknown>).zone as string | undefined;
      return zoneProximityScore(agent, zoneB) - zoneProximityScore(agent, zoneA);
    })[0];
    if (quota) {
      params.station = quota.station_id;
      const quotaZone = (quota as unknown as Record<string, unknown>).zone as string | undefined;
      if (quotaZone) params.zone = quotaZone;
      return {
        role: "miner",
        routine: "navigate_and_mine",
        params,
        reason: `Mining quota: ${quota.item_id} ${quota.current_quantity}/${quota.target_quantity} at ${quota.station_id}${quotaZone ? ` [zone: ${quotaZone}]` : ""}.`,
        quota: {
          item_id: quota.item_id,
          target_quantity: quota.target_quantity,
          current_quantity: quota.current_quantity,
        },
      };
    }
  }

  // If trader and there are arbitrage opportunities, prefer ones matching the agent's zone
  if (bestRole === "trader" && demand.arbitrageItems.length > 0) {
    // Score each opportunity by how well buy_empire matches agent zone
    const scoredOpps = demand.arbitrageItems.map((opp) => ({
      opp,
      score: zoneProximityScore(agent, opp.buy_empire),
    }));
    // Pick best match (stable sort: first opp wins on tie)
    const best = scoredOpps.reduce((a, b) => b.score > a.score ? b : a);
    const opp = best.opp;
    params.buy_empire = opp.buy_empire;
    params.sell_empire = opp.sell_empire;
    params.item_id = opp.item_id;
    if (agent.operatingZone) params.zone = agent.operatingZone;
    reason = `Trade ${opp.item_name}: buy at ${opp.buy_empire} (${opp.buy_price}), sell at ${opp.sell_empire} (${opp.sell_price}). Margin: ${opp.profit_margin_pct}%.`;
  }

  return {
    role: bestRole,
    routine: ROLE_ROUTINES[bestRole],
    params,
    reason,
  };
}

/**
 * Check if an agent's operating zone is compatible with an order's target zone.
 * Returns true if the assignment is valid for the agent's zone.
 *
 * An agent with no operatingZone is eligible for all zones.
 * An order with no targetZone is eligible for all agents.
 * If both are set, they must match (case-insensitive).
 */
export function isZoneCompatible(
  agentZone: string | undefined,
  _role: CoordinatorRole,
  params: Record<string, unknown>,
): boolean {
  // If agent has no zone restriction, they can go anywhere
  if (!agentZone) return true;

  // If the params specify a zone, check compatibility
  const targetZone = params.zone as string | undefined;
  if (!targetZone) return true;

  return agentZone.toLowerCase() === targetZone.toLowerCase();
}

/**
 * Score how well an agent's current location matches the target zone.
 * Higher score = better match. Used to prefer agents already in/near the zone.
 */
export function zoneProximityScore(
  agent: AgentSnapshot,
  targetZone: string | undefined,
): number {
  if (!targetZone) return 0; // no preference
  if (!agent.operatingZone) return 0; // agent is zoneless, neutral

  // Exact zone match: high score
  if (agent.operatingZone.toLowerCase() === targetZone.toLowerCase()) return 2;

  // Partial match (e.g., same prefix like "sol-belt" vs "sol-station"): medium score
  const agentPrefix = agent.operatingZone.split("-")[0].toLowerCase();
  const targetPrefix = targetZone.split("-")[0].toLowerCase();
  if (agentPrefix === targetPrefix) return 1;

  return 0;
}

/**
 * Format a coordinator assignment as a fleet_order message string.
 */
export function formatAssignmentMessage(
  role: CoordinatorRole,
  routine: string,
  params: Record<string, unknown>,
  reason: string,
  quota?: { item_id: string; target_quantity: number; current_quantity: number },
): string {
  let msg = `[COORDINATOR] Role: ${role} | Routine: ${routine}`;
  msg += `\nParams: ${JSON.stringify(params)}`;
  if (quota) {
    msg += `\nQuota: ${quota.item_id} ${quota.current_quantity}/${quota.target_quantity}`;
  }
  msg += `\nReason: ${reason}`;
  return msg;
}
