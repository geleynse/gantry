/**
 * coordinator-state.ts — Shared fleet state gathering for coordinator and overseer.
 *
 * Extracts the snapshot logic from FleetCoordinator so the OverseerAgent can
 * consume the same rich view of fleet state without coupling to the coordinator.
 */

import { queryAll } from "./database.js";
import { getConfig } from "../config/fleet.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("coordinator-state");
import type { ArbitrageAnalyzer } from "../proxy/arbitrage-analyzer.js";
import type { MarketCache } from "../proxy/market-cache.js";
import type { BattleState } from "../shared/types.js";
import type { OverseerEventLog } from "./overseer-event-log.js";
import type { CoordinatorRole } from "../shared/types/coordinator.js";

// Re-export so consumers can import AgentSnapshot from one place.
export type { AgentSnapshot } from "./coordinator-demand.js";
import type { AgentSnapshot } from "./coordinator-demand.js";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

interface StatusCacheEntry {
  data: Record<string, unknown>;
  fetchedAt: number;
}

/** Subset of agent config that StateGatherer needs. */
export interface AgentSnapshotConfig {
  name: string;
  faction?: string;
  role?: string;
  operatingZone?: string;
}

export interface StateGathererDeps {
  statusCache: Map<string, StatusCacheEntry>;
  battleCache: Map<string, BattleState | null>;
  arbitrageAnalyzer: ArbitrageAnalyzer;
  marketCache: MarketCache;
  agentConfigs: AgentSnapshotConfig[];
  /** Last coordinator assignments (keyed by agent name → role). Optional. */
  lastAssignments?: Map<string, CoordinatorRole>;
  /** Event log for recent overseer events. Optional. */
  overseerEventLog?: OverseerEventLog | null;
}

/** A compact market opportunity summary for the fleet snapshot. */
export interface MarketOpportunitySummary {
  item_id: string;
  item_name: string;
  buy_empire: string;
  sell_empire: string;
  profit_per_unit: number;
  estimated_volume: number;
}

/** An undelivered fleet order from the DB. */
export interface ActiveFleetOrder {
  id: number;
  target_agent: string | null;
  message: string;
  priority: string;
  expires_at: string | null;
  created_at: string;
}

/** A recently delivered fleet order (last 15 min). */
export interface RecentDelivery {
  target_agent: string;
  message: string;
  delivered_at: string;
}

/** A recent overseer event entry. */
export interface RecentEvent {
  agent: string;
  type: string;
  timestamp: number;
}

/** Fleet-wide aggregated totals. */
export interface FleetTotals {
  totalCredits: number;
  totalCargoUsed: number;
  totalCargoMax: number;
  onlineCount: number;
  offlineCount: number;
}

/** Rich fleet snapshot consumed by both coordinator and overseer. */
export interface FleetSnapshot {
  agents: AgentSnapshot[];
  marketSummary: MarketOpportunitySummary[];
  activeOrders: ActiveFleetOrder[];
  recentDeliveries: RecentDelivery[];
  recentEvents: RecentEvent[];
  fleetTotals: FleetTotals;
}

// ---------------------------------------------------------------------------
// Online threshold
// ---------------------------------------------------------------------------

const ONLINE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Gather a rich fleet snapshot from the provided deps.
 * All DB queries are wrapped in try/catch — failures are non-fatal.
 */
export function gatherFleetSnapshot(deps: StateGathererDeps): FleetSnapshot {
  const {
    statusCache,
    battleCache,
    arbitrageAnalyzer,
    marketCache,
    agentConfigs,
    lastAssignments,
    overseerEventLog,
  } = deps;

  // 1. Build raw status snapshot (same format as old gatherFleetSnapshot)
  const rawSnapshot: Record<string, Record<string, unknown>> = {};
  for (const [agentName, entry] of statusCache) {
    rawSnapshot[agentName] = {
      ...entry.data,
      fetchedAt: entry.fetchedAt,
      ageMs: Date.now() - entry.fetchedAt,
    };
  }

  // 2. Batch-fetch last tool call timestamps for all agents
  let lastToolCallByAgent = new Map<string, string>();
  try {
    const rows = queryAll<{ agent: string; last_created: string }>(
      `SELECT agent, MAX(created_at) as last_created
       FROM proxy_tool_calls
       GROUP BY agent`,
    );
    lastToolCallByAgent = new Map(rows.map((r) => [r.agent, r.last_created]));
  } catch {
    // non-fatal
  }

  // 3. Build AgentSnapshot[] — exclude the overseer (it's the observer, not a player)
  const now = Date.now();
  const gameAgents = agentConfigs.filter((a) => a.name !== "overseer");
  const agents: AgentSnapshot[] = gameAgents.map((agent) => {
    const state = rawSnapshot[agent.name];
    const isOnline = !!state && (now - (state.fetchedAt as number || 0)) < ONLINE_THRESHOLD_MS;

    let lastToolCallAge: number | undefined;
    const lastToolCallTs = lastToolCallByAgent.get(agent.name);
    if (lastToolCallTs) {
      lastToolCallAge = (now - new Date(lastToolCallTs).getTime()) / 1000;
    }

    const currentRole = lastAssignments?.get(agent.name);
    const battle = battleCache?.get(agent.name);

    // statusCache stores the raw game response: { player: { current_system, credits, ... }, ship: { fuel, hull, cargo_used, ... } }
    // Extract from the correct nesting level. Fallback to flat format for backward compat.
    const player = (state?.player ?? state) as Record<string, unknown> | undefined;
    const ship = (state?.ship ?? (player as Record<string, unknown> | undefined)?.ship ?? state) as Record<string, unknown> | undefined;

    // Data shape validation — log once per agent if shape is unexpected
    if (state && !state.player && state.credits !== undefined) {
      log.warn("statusCache has flat data shape (missing player wrapper)", { agent: agent.name, topKeys: Object.keys(state).slice(0, 6) });
    }

    return {
      name: agent.name,
      faction: agent.faction,
      operatingZone: agent.operatingZone,
      role: agent.role,
      credits: player?.credits as number | undefined,
      system: player?.current_system as string | undefined,
      poi: player?.current_poi as string | undefined,
      docked: player?.docked_at_base as boolean | undefined,
      cargoUsed: ship?.cargo_used as number | undefined,
      cargoMax: ship?.cargo_capacity as number | undefined,
      fuel: ship?.fuel as number | undefined,
      fuelMax: ship?.max_fuel as number | undefined,
      isOnline,
      isInCombat: !!battle?.battle_id && battle?.status !== "resolved",
      lastToolCallAge,
      currentRole,
    };
  });

  // 4. Market summary — top 5 arbitrage opportunities
  let marketSummary: MarketOpportunitySummary[] = [];
  try {
    const opps = arbitrageAnalyzer.getOpportunities(marketCache);
    marketSummary = opps.slice(0, 5).map((o) => ({
      item_id: o.item_id,
      item_name: o.item_name,
      buy_empire: o.buy_empire,
      sell_empire: o.sell_empire,
      profit_per_unit: o.profit_per_unit,
      estimated_volume: o.estimated_volume,
    }));
  } catch {
    // non-fatal
  }

  // 5. Active (undelivered) fleet orders from DB
  let activeOrders: ActiveFleetOrder[] = [];
  try {
    activeOrders = queryAll<ActiveFleetOrder>(
      `SELECT o.id, o.target_agent, o.message, o.priority, o.expires_at, o.created_at
       FROM fleet_orders o
       LEFT JOIN fleet_order_deliveries d ON d.order_id = o.id
       WHERE d.id IS NULL
       ORDER BY o.created_at DESC`,
    );
  } catch {
    // non-fatal — DB may not be available in tests
  }

  // 6. Recently delivered orders (last 15 minutes)
  let recentDeliveries: RecentDelivery[] = [];
  try {
    recentDeliveries = queryAll<RecentDelivery>(
      `SELECT o.target_agent, o.message, d.delivered_at
       FROM fleet_orders o
       JOIN fleet_order_deliveries d ON d.order_id = o.id
       WHERE d.delivered_at > datetime('now', '-15 minutes')
       ORDER BY d.delivered_at DESC
       LIMIT 10`,
    );
  } catch {
    // non-fatal
  }

  // 7. Recent events from overseerEventLog (last 10 minutes)
  let recentEvents: RecentEvent[] = [];
  if (overseerEventLog) {
    try {
      const cutoff = now - 10 * 60 * 1000;
      recentEvents = overseerEventLog.since(cutoff).map((e) => ({
        agent: e.agent,
        type: e.event.type,
        timestamp: e.timestamp,
      }));
    } catch {
      // non-fatal
    }
  }

  // 8. Fleet totals
  const fleetTotals: FleetTotals = {
    totalCredits: 0,
    totalCargoUsed: 0,
    totalCargoMax: 0,
    onlineCount: 0,
    offlineCount: 0,
  };
  for (const agent of agents) {
    if (agent.isOnline) {
      fleetTotals.onlineCount++;
      fleetTotals.totalCredits += agent.credits ?? 0;
      fleetTotals.totalCargoUsed += agent.cargoUsed ?? 0;
      fleetTotals.totalCargoMax += agent.cargoMax ?? 0;
    } else {
      fleetTotals.offlineCount++;
    }
  }

  return { agents, marketSummary, activeOrders, recentDeliveries, recentEvents, fleetTotals };
}

/**
 * Build agent configs from fleet-config.json (for use in coordinator/overseer).
 * Falls back to empty array if config is unavailable.
 */
export function buildAgentConfigs(): AgentSnapshotConfig[] {
  try {
    const config = getConfig();
    return config.agents.map((a) => ({
      name: a.name,
      faction: a.faction,
      role: a.role,
      operatingZone: (a as unknown as Record<string, unknown>).operatingZone as string | undefined,
    }));
  } catch {
    return [];
  }
}

/**
 * Convert agents array back to the legacy Record<string, unknown> format
 * that coordinatorTickResult.fleet_snapshot expects.
 */
export function agentsToRawSnapshot(
  statusCache: Map<string, StatusCacheEntry>,
): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const [agentName, entry] of statusCache) {
    snapshot[agentName] = {
      ...entry.data,
      fetchedAt: entry.fetchedAt,
      ageMs: Date.now() - entry.fetchedAt,
    };
  }
  return snapshot;
}
