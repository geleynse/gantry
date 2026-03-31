/**
 * FleetCoordinator — Supply-chain coordinator for fleet agents.
 *
 * Runs periodic "ticks" that:
 * 1. Gather agent state from statusCache
 * 2. Analyze market conditions from arbitrageAnalyzer
 * 3. Generate per-agent role assignments
 * 4. Deliver assignments via fleet_orders (comms-db)
 * 5. Update quota tracking in coordinator_quotas
 *
 * The coordinator is stateless per tick — it reads current state and writes orders.
 * If it fails, agents continue independently with their existing routines.
 */

import { queryAll, queryOne, queryRun, queryInsert } from "./database.js";
import { createOrder } from "./comms-db.js";
import { createLogger } from "../lib/logger.js";
import { getConfig } from "../config/fleet.js";
import type { MarketCache } from "../proxy/market-cache.js";
import type { ArbitrageAnalyzer } from "../proxy/arbitrage-analyzer.js";
import type { BattleState } from "../shared/types.js";
import type {
  CoordinatorConfig,
  CoordinatorAssignment,
  CoordinatorQuota,
  CoordinatorTickResult,
  CoordinatorRole,
} from "../shared/types/coordinator.js";
import { DEFAULT_COORDINATOR_CONFIG } from "../shared/types/coordinator.js";
import {
  analyzeFleetDemand,
  suggestRole,
  formatAssignmentMessage,
} from "./coordinator-demand.js";
import {
  gatherFleetSnapshot,
  buildAgentConfigs,
  agentsToRawSnapshot,
} from "./coordinator-state.js";
import type { OverseerEventLog } from "./overseer-event-log.js";

const log = createLogger("coordinator");

interface StatusCacheEntry {
  data: Record<string, unknown>;
  fetchedAt: number;
}

export class FleetCoordinator {
  /** Optional OverseerEventLog for enriching fleet snapshots. Set by the overseer after construction. */
  overseerEventLog: OverseerEventLog | null = null;
  private statusCache: Map<string, StatusCacheEntry>;
  private marketCache: MarketCache;
  private arbitrageAnalyzer: ArbitrageAnalyzer;
  private battleCache: Map<string, BattleState | null>;
  private lastTick: CoordinatorTickResult | null = null;
  private tickNumber = 0;
  private enabledOverride: boolean | null = null; // API toggle

  constructor(
    statusCache: Map<string, StatusCacheEntry>,
    marketCache: MarketCache,
    arbitrageAnalyzer: ArbitrageAnalyzer,
    battleCache: Map<string, BattleState | null>,
  ) {
    this.statusCache = statusCache;
    this.marketCache = marketCache;
    this.arbitrageAnalyzer = arbitrageAnalyzer;
    this.battleCache = battleCache;
  }

  /** Check if the coordinator is enabled (config hot-reload aware). */
  isEnabled(): boolean {
    if (this.enabledOverride !== null) return this.enabledOverride;
    return this.getCoordinatorConfig().enabled;
  }

  /** Toggle coordinator on/off via API (overrides config). */
  setEnabled(enabled: boolean): void {
    this.enabledOverride = enabled;
    log.info(`Coordinator ${enabled ? "enabled" : "disabled"} via API`);
  }

  /** Get the coordinator config, with hot-reload support. */
  private getCoordinatorConfig(): CoordinatorConfig {
    try {
      const config = getConfig();
      return config.coordinator ?? DEFAULT_COORDINATOR_CONFIG;
    } catch {
      return DEFAULT_COORDINATOR_CONFIG;
    }
  }

  /**
   * Run a coordinator tick. Gathers state, generates assignments, delivers orders.
   * Returns the tick result for API consumption.
   */
  async tick(): Promise<CoordinatorTickResult> {
    const config = this.getCoordinatorConfig();
    this.tickNumber++;
    const tickAt = new Date().toISOString();

    log.info(`Coordinator tick #${this.tickNumber} starting`);

    // 1. GATHER STATE
    const agentConfigs = buildAgentConfigs();
    const lastAssignments = this.lastTick
      ? new Map(this.lastTick.assignments.map((a) => [a.agent, a.role]))
      : undefined;

    const snapshot = gatherFleetSnapshot({
      statusCache: this.statusCache,
      battleCache: this.battleCache,
      arbitrageAnalyzer: this.arbitrageAnalyzer,
      marketCache: this.marketCache,
      agentConfigs,
      lastAssignments,
      overseerEventLog: this.overseerEventLog,
    });

    const agents = snapshot.agents;
    const onlineAgents = agents.filter((a) => a.isOnline);
    // Backward-compatible raw snapshot for persistTickState
    const fleetSnapshot = agentsToRawSnapshot(this.statusCache);

    // 2. ASSESS FLEET NEEDS
    const arbitrageData = this.arbitrageAnalyzer.getOpportunities(this.marketCache);
    const activeQuotas = this.getActiveQuotas();
    const demand = analyzeFleetDemand(arbitrageData, activeQuotas, config, onlineAgents.length);

    // 3. GENERATE ASSIGNMENTS
    const assignments: CoordinatorAssignment[] = [];
    const currentAssignments = new Map<string, CoordinatorRole>();

    for (const agent of onlineAgents) {
      // Skip agents in combat
      if (agent.isInCombat) {
        log.debug(`Skipping ${agent.name} (in combat)`);
        continue;
      }

      const suggestion = suggestRole(agent, demand, currentAssignments, config);

      const assignment: CoordinatorAssignment = {
        agent: agent.name,
        role: suggestion.role,
        routine: suggestion.routine,
        params: suggestion.params,
        priority: "normal",
        reason: suggestion.reason,
        quota: suggestion.quota,
        expires_at: new Date(Date.now() + config.intervalMinutes * 60 * 1000).toISOString(),
        zone: agent.operatingZone,
      };

      assignments.push(assignment);
      currentAssignments.set(agent.name, suggestion.role);
    }

    // 4. DELIVER ASSIGNMENTS
    if (this.isEnabled()) {
      this.expirePreviousOrders();
      for (const assignment of assignments) {
        this.deliverAssignment(assignment);
      }
      log.info(`Delivered ${assignments.length} assignments`);
    } else {
      log.info(`Coordinator disabled — generated ${assignments.length} assignments (not delivered)`);
    }

    // 5. UPDATE QUOTAS
    const quotasUpdated = this.updateQuotas(activeQuotas);

    // Save tick state
    const tickResult: CoordinatorTickResult = {
      tick_number: this.tickNumber,
      tick_at: tickAt,
      assignments,
      quotas_updated: quotasUpdated,
      fleet_snapshot: fleetSnapshot,
      market_snapshot: arbitrageData.slice(0, 5), // top 5 opportunities
      enabled: this.isEnabled(),
    };

    this.lastTick = tickResult;
    this.persistTickState(tickResult);

    log.info(`Coordinator tick #${this.tickNumber} complete`, {
      assignments: assignments.length,
      quotas_updated: quotasUpdated,
      enabled: this.isEnabled(),
    });

    return tickResult;
  }

  /** Deserialize a coordinator_state DB row into a CoordinatorTickResult. */
  private deserializeTickRow(
    row: { tick_number: number; tick_at: string; fleet_snapshot: string; assignments: string; market_snapshot: string | null; metrics: string | null },
  ): CoordinatorTickResult {
    return {
      tick_number: row.tick_number,
      tick_at: row.tick_at,
      assignments: JSON.parse(row.assignments),
      quotas_updated: 0,
      fleet_snapshot: JSON.parse(row.fleet_snapshot),
      market_snapshot: row.market_snapshot ? JSON.parse(row.market_snapshot) : [],
      enabled: this.isEnabled(),
    };
  }

  /** Get the last tick result. */
  getLastTick(): CoordinatorTickResult | null {
    if (this.lastTick) return this.lastTick;

    // Try loading from DB
    try {
      const row = queryOne<{
        tick_number: number;
        tick_at: string;
        fleet_snapshot: string;
        assignments: string;
        market_snapshot: string | null;
        metrics: string | null;
      }>("SELECT * FROM coordinator_state ORDER BY tick_number DESC LIMIT 1");

      if (!row) return null;
      return this.deserializeTickRow(row);
    } catch {
      return null;
    }
  }

  /** Get tick history (last N ticks). */
  getHistory(limit = 10): CoordinatorTickResult[] {
    try {
      const rows = queryAll<{
        tick_number: number;
        tick_at: string;
        fleet_snapshot: string;
        assignments: string;
        market_snapshot: string | null;
        metrics: string | null;
      }>("SELECT * FROM coordinator_state ORDER BY tick_number DESC LIMIT ?", limit);

      return rows.map((row) => this.deserializeTickRow(row));
    } catch {
      return [];
    }
  }

  /** Get all active quotas. */
  getActiveQuotas(): CoordinatorQuota[] {
    try {
      return queryAll<CoordinatorQuota>(
        "SELECT * FROM coordinator_quotas WHERE status = 'active' ORDER BY created_at ASC",
      );
    } catch {
      return [];
    }
  }

  /** Get the current assignment for a specific agent. */
  getAgentAssignment(agentName: string): CoordinatorAssignment | null {
    if (!this.lastTick) return null;
    return this.lastTick.assignments.find((a) => a.agent === agentName) ?? null;
  }

  /** Get zone coverage summary: which zones have assigned agents, which are uncovered. */
  getZoneCoverage(): { covered: Record<string, string[]>; uncovered: string[] } {
    let allZones: string[];
    let agentZones: Map<string, string | undefined>;

    try {
      const config = getConfig();
      const zonesSet = new Set<string>();
      agentZones = new Map();
      for (const a of config.agents) {
        const zone = (a as unknown as Record<string, unknown>).operatingZone as string | undefined;
        agentZones.set(a.name, zone);
        if (zone) zonesSet.add(zone);
      }
      allZones = [...zonesSet];
    } catch {
      return { covered: {}, uncovered: [] };
    }

    const assignments = this.lastTick?.assignments ?? [];
    const covered: Record<string, string[]> = {};

    for (const assignment of assignments) {
      const zone = assignment.zone ?? agentZones.get(assignment.agent);
      if (zone) {
        (covered[zone] ||= []).push(assignment.agent);
      }
    }

    const uncovered = allZones.filter((z) => !covered[z]);
    return { covered, uncovered };
  }

  /** Create a new quota. */
  createQuota(
    itemId: string,
    targetQuantity: number,
    stationId: string,
    assignedTo?: string,
  ): CoordinatorQuota {
    const id = queryInsert(
      `INSERT INTO coordinator_quotas (item_id, target_quantity, station_id, assigned_to)
       VALUES (?, ?, ?, ?)`,
      itemId, targetQuantity, stationId, assignedTo ?? null
    );

    log.info(`Created quota #${id}: ${itemId} x${targetQuantity} at ${stationId}`);

    return {
      id,
      item_id: itemId,
      target_quantity: targetQuantity,
      current_quantity: 0,
      assigned_to: assignedTo ?? null,
      station_id: stationId,
      created_at: new Date().toISOString(),
      completed_at: null,
      status: "active",
    };
  }

  /** Cancel a quota by ID. */
  cancelQuota(quotaId: number): boolean {
    try {
      const changes = queryRun(
        "UPDATE coordinator_quotas SET status = 'cancelled' WHERE id = ? AND status = 'active'",
        quotaId
      );
      const changed = changes > 0;
      if (changed) {
        log.info(`Cancelled quota #${quotaId}`);
      }
      return changed;
    } catch {
      return false;
    }
  }

  // --- Private helpers ---

  /** Expire previous coordinator orders so they don't stack. */
  private expirePreviousOrders(): void {
    try {
      // Delete coordinator orders that haven't been delivered yet
      queryRun(
        `DELETE FROM fleet_orders WHERE message LIKE '[COORDINATOR]%'
         AND (expires_at IS NULL OR expires_at > datetime('now'))`,
      );
    } catch (err) {
      log.warn("Failed to expire previous coordinator orders", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Deliver a single assignment as a fleet_order. */
  private deliverAssignment(assignment: CoordinatorAssignment): void {
    try {
      const message = formatAssignmentMessage(
        assignment.role,
        assignment.routine,
        assignment.params,
        assignment.reason,
        assignment.quota,
      );

      createOrder({
        message,
        target_agent: assignment.agent,
        priority: assignment.priority,
        expires_at: assignment.expires_at,
      });
    } catch (err) {
      log.warn(`Failed to deliver assignment for ${assignment.agent}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Update quota progress and mark completed ones. */
  private updateQuotas(quotas: CoordinatorQuota[]): number {
    let updated = 0;
    for (const quota of quotas) {
      if (quota.current_quantity >= quota.target_quantity) {
        try {
          queryRun(
            "UPDATE coordinator_quotas SET status = 'completed', completed_at = datetime('now') WHERE id = ?",
            quota.id
          );
          updated++;
          log.info(`Quota #${quota.id} completed: ${quota.item_id}`);
        } catch {
          // non-fatal
        }
      }
    }
    return updated;
  }

  /** Persist tick state to coordinator_state table. */
  private persistTickState(result: CoordinatorTickResult): void {
    try {
      queryRun(
        `INSERT INTO coordinator_state (tick_number, tick_at, fleet_snapshot, assignments, market_snapshot, metrics)
         VALUES (?, ?, ?, ?, ?, ?)`,
        result.tick_number,
        result.tick_at,
        JSON.stringify(result.fleet_snapshot),
        JSON.stringify(result.assignments),
        JSON.stringify(result.market_snapshot),
        JSON.stringify({ quotas_updated: result.quotas_updated }),
      );
    } catch (err) {
      log.warn("Failed to persist tick state", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
