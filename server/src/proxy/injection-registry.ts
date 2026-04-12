/**
 * InjectionRegistry: manages the pipeline injections that wrap tool responses
 * with critical events, orders, battle status, instability hints, and more.
 *
 * Each Injection defines:
 *  - priority: execution order (lower = first)
 *  - enabled(): whether to run for this agent/context
 *  - gather(): collects and returns the data to inject (null = skip)
 *
 * The registry executes all enabled injections in priority order and returns
 * a Map<key, value> that withInjections() merges into the tool response.
 */

import type { PipelineContext } from "./pipeline.js";
import type { BattleState } from "../shared/types.js";
import { checkCloakAdvisory } from "./auto-cloak.js";
import { generateInstabilityHint } from "./instability-hints.js";
import { checkStorageLimits } from "../services/faction-monitor.js";
import { getNoteUpdatedAt } from "../services/notes-db.js";
import { extractShipsFromResult, summarizeShipThreats } from "./threat-assessment.js";
import { buildLoreHint } from "../services/poi-lore.js";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface Injection {
  name: string;
  key: string;
  priority: number;
  enabled: (ctx: PipelineContext, agent: string) => boolean;
  gather: (ctx: PipelineContext, agent: string) => unknown;
}

// ---------------------------------------------------------------------------
// InjectionRegistry
// ---------------------------------------------------------------------------

export class InjectionRegistry {
  private injections: Injection[] = [];

  register(injection: Injection): void {
    this.injections.push(injection);
    this.injections.sort((a, b) => a.priority - b.priority);
  }

  unregister(name: string): void {
    this.injections = this.injections.filter((i) => i.name !== name);
  }

  getRegistered(): string[] {
    return this.injections.map((i) => i.name);
  }

  run(ctx: PipelineContext, agent: string): Map<string, unknown> {
    const results = new Map<string, unknown>();
    for (const injection of this.injections) {
      if (!injection.enabled(ctx, agent)) continue;
      const value = injection.gather(ctx, agent);
      if (value !== null && value !== undefined) {
        results.set(injection.key, value);
      }
    }
    return results;
  }
}

// ---------------------------------------------------------------------------
// extractBattleStatus helper
// ---------------------------------------------------------------------------

export function extractBattleStatus(
  battleCache: Map<string, BattleState | null>,
  agentName: string,
): Record<string, unknown> | null {
  const cached = battleCache.get(agentName);
  if (!cached) return null;

  if (
    cached.status &&
    cached.status !== "ended" &&
    cached.status !== "victory" &&
    cached.status !== "defeat" &&
    cached.status !== "fled"
  ) {
    return {
      in_battle: true,
      status: cached.status,
      zone: cached.zone,
      hull: cached.hull,
      shields: cached.shields,
      stance: cached.stance,
      battle_id: cached.battle_id,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Default injections (all 7, in priority order)
// ---------------------------------------------------------------------------

export function createDefaultInjections(): Injection[] {
  return [
    {
      name: "critical-events",
      key: "events",
      priority: 10,
      enabled: () => true,
      gather: (ctx, agent) => {
        const events = ctx.eventBuffers.get(agent)?.drainCritical() ?? [];
        if (events.length === 0) return null;
        return events.map((e) => ({ type: e.type, data: e.payload }));
      },
    },

    {
      // Inject the agent's current system so the turn-ingestor can attribute combat
      // events to the correct location even when no explicit get_status / get_location
      // call was made in the same turn.
      name: "location-context",
      key: "_current_system",
      priority: 11,
      enabled: () => true,
      gather: (ctx, agent) => {
        const rawStatus = ctx.statusCache?.get(agent)?.data as Record<string, unknown> | undefined;
        const playerData = (rawStatus?.player as Record<string, unknown> | undefined) ?? rawStatus;
        const system = playerData?.current_system;
        return typeof system === "string" && system.trim() !== "" ? system : null;
      },
    },

    {
      name: "fleet-orders",
      key: "fleet_orders",
      priority: 20,
      enabled: () => true,
      gather: (ctx, agent) => {
        const orders = ctx.getFleetPendingOrders(agent);
        if (orders.length === 0) return null;
        // Side effect: mark all orders as delivered
        for (const order of orders) {
          ctx.markOrderDelivered(order.id, agent);
        }
        return orders.map((o) => ({ id: o.id, message: o.message, priority: o.priority }));
      },
    },

    {
      name: "battle-status",
      key: "_battle_status",
      priority: 30,
      enabled: () => true,
      gather: (ctx, agent) => extractBattleStatus(ctx.battleCache, agent),
    },

    {
      name: "instability-hint",
      key: "server_notice",
      priority: 40,
      enabled: () => true,
      gather: (ctx) => generateInstabilityHint(ctx.serverMetrics.getMetrics()) || null,
    },

    {
      name: "threat-assessment",
      key: "_threat_summary",
      priority: 45,
      enabled: () => true,
      gather: (ctx, agent) => {
        const cachedStatus = ctx.statusCache?.get(agent);
        if (!cachedStatus) return null;
        const ships = extractShipsFromResult(cachedStatus.data);
        if (!ships || ships.length === 0) return null;
        return summarizeShipThreats(ships) ?? null;
      },
    },

    {
      name: "storage-warning",
      key: "_storage_warning",
      priority: 50,
      enabled: () => true,
      gather: (ctx, agent) => {
        const cachedStatus = ctx.statusCache?.get(agent);
        if (!cachedStatus) return null;
        const data = cachedStatus.data as Record<string, unknown>;
        const p = (data.player as Record<string, unknown> | undefined) ?? data;
        if (p.faction_storage_used === undefined || p.faction_storage_max === undefined) return null;
        const alert = checkStorageLimits(
          p.faction_storage_used as number,
          p.faction_storage_max as number,
        );
        return alert?.message ?? null;
      },
    },

    {
      name: "cloak-advisory",
      key: "_cloak_advisory",
      priority: 60,
      enabled: (ctx) => Boolean(ctx.config.survivability?.autoCloakEnabled),
      gather: (ctx, agent) => {
        const cachedAgentStatus = ctx.statusCache?.get(agent);
        const rawStatus = cachedAgentStatus?.data as Record<string, unknown> | undefined;
        const playerData =
          (rawStatus?.player as Record<string, unknown> | undefined) ?? rawStatus;
        const currentSystem = playerData?.current_system as string | undefined;
        if (!currentSystem) return null;

        const isDocked = Boolean(playerData?.docked_at_base);
        let hullPct: number | undefined;
        const shipData = rawStatus?.ship as Record<string, unknown> | undefined;
        if (shipData) {
          const hull = Number(shipData.hull);
          const maxHull = Number(shipData.max_hull);
          if (!isNaN(hull) && !isNaN(maxHull) && maxHull > 0) {
            hullPct = (hull / maxHull) * 100;
          }
        }

        return checkCloakAdvisory(agent, currentSystem, isDocked, hullPct, ctx.config) ?? null;
      },
    },

    {
      name: "poi-lore",
      key: "_poi_lore",
      priority: 62,
      enabled: () => true,
      gather: (ctx, agent) => {
        const cachedStatus = ctx.statusCache?.get(agent);
        const rawStatus = cachedStatus?.data as Record<string, unknown> | undefined;
        const playerData = (rawStatus?.player as Record<string, unknown> | undefined) ?? rawStatus;
        const currentSystem = playerData?.current_system as string | undefined;
        const currentPoi = playerData?.current_poi as string | undefined;
        if (!currentSystem || !currentPoi) return null;
        try {
          return buildLoreHint(currentSystem, currentPoi) ?? null;
        } catch {
          return null;
        }
      },
    },

    {
      name: "directives",
      key: "standing_orders",
      priority: 70,
      enabled: (ctx) => Boolean(ctx.getActiveDirectives),
      gather: (ctx, agent) => {
        const allDirectives = ctx.getActiveDirectives!(agent);
        if (allDirectives.length === 0) return null;

        const critical = allDirectives.filter((d) => d.priority === "critical");
        const regular = allDirectives.filter((d) => d.priority !== "critical");

        const toInject = [...critical];
        if (regular.length > 0) {
          if (ctx.directivesCallCounters) {
            const count = (ctx.directivesCallCounters.get(agent) ?? 0) + 1;
            ctx.directivesCallCounters.set(agent, count);
            if (count % 5 === 1) toInject.push(...regular);
          } else {
            toInject.push(...regular);
          }
        }

        if (toInject.length === 0) return null;
        return "STANDING ORDERS:\n" + toInject.map((d) => `- [${d.priority}] ${d.directive}`).join("\n");
      },
    },

    {
      name: "stale-strategy",
      key: "_strategy_reminder",
      priority: 75,
      // Only inject every 5th call to avoid spamming
      enabled: (ctx, agent) => {
        if (!ctx.directivesCallCounters) return true;
        const count = ctx.directivesCallCounters.get(`stale-strat:${agent}`) ?? 0;
        ctx.directivesCallCounters.set(`stale-strat:${agent}`, count + 1);
        return count % 5 === 0;
      },
      gather: (_ctx, agent) => {
        try {
          const updatedAt = getNoteUpdatedAt(agent, "strategy");
          if (!updatedAt) {
            return "You have NO strategy doc. Write one NOW with write_doc(title='strategy') — include your location, credits, cargo, and plan.";
          }
          const ageMs = Date.now() - new Date(updatedAt).getTime();
          const ageHours = ageMs / (1000 * 60 * 60);
          if (ageHours > 2) {
            return `Your strategy doc is ${Math.round(ageHours)}h old and likely stale. Rewrite it with your CURRENT state before logout.`;
          }
        } catch { /* DB not ready */ }
        return null;
      },
    },

    {
      name: "shutdown-warning",
      key: "_shutdown_warning",
      priority: 80,
      enabled: (ctx) => Boolean(ctx.sessionStore),
      gather: (ctx, agent) => {
        if (!ctx.shutdownWarningFired) return null;
        // Only fire once per turn per agent
        if (ctx.shutdownWarningFired.has(agent)) return null;

        // Reverse-lookup: find the session ID for this agent
        let sessionId: string | undefined;
        for (const [sid, agentName] of ctx.sessionAgentMap.entries()) {
          if (agentName === agent) { sessionId = sid; break; }
        }
        if (!sessionId) return null;

        const turnStartedAt = ctx.sessionStore!.getTurnStartedAt(sessionId);
        if (!turnStartedAt) return null;

        const elapsedMs = Date.now() - new Date(turnStartedAt).getTime();
        const thresholdMs = ctx.config.shutdownWarningMs ?? 1100 * 1000; // 1100s default
        if (elapsedMs < thresholdMs) return null;

        ctx.shutdownWarningFired.add(agent);
        return "SHUTDOWN_SIGNAL: You have ~100 seconds remaining. Write captains_log_add and logout NOW.";
      },
    },
  ];
}
