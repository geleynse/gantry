/**
 * Override System: condition-triggered interrupt system that injects urgent
 * directives when critical game state conditions are met.
 *
 * Runs as a high-priority injection (priority 5) — before all other injections.
 * Each rule has a per-agent cooldown to avoid spamming the same override every call.
 */

import type { PipelineContext } from "./pipeline.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("override-system");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OverrideContext {
  statusCache: Map<string, { data: Record<string, unknown>; fetchedAt: number }>;
  battleCache: Map<string, import("../shared/types.js").BattleState | null>;
}

export interface OverrideRule {
  name: string;
  priority: number;
  /** Cooldown in ms — same rule won't fire again for this agent within this window. */
  cooldownMs: number;
  condition: (ctx: OverrideContext, agent: string) => boolean;
  directive: string | ((ctx: OverrideContext, agent: string) => string);
}

export interface OverrideHistoryEntry {
  rule: string;
  directive: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Helpers to extract agent state from statusCache
// ---------------------------------------------------------------------------

export function extractAgentState(statusCache: Map<string, { data: Record<string, unknown>; fetchedAt: number }>, agent: string): {
  fuel?: number;
  maxFuel?: number;
  hull?: number;
  maxHull?: number;
  cargoUsed?: number;
  cargoCapacity?: number;
  credits?: number;
  currentSystem?: string;
  dockedAtBase?: boolean;
} {
  const cached = statusCache.get(agent);
  if (!cached) return {};

  const data = cached.data;
  const player = (data.player ?? data) as Record<string, unknown>;
  const ship = (data.ship ?? player.ship ?? {}) as Record<string, unknown>;

  return {
    fuel: typeof ship.fuel === "number" ? ship.fuel : undefined,
    maxFuel: typeof ship.max_fuel === "number" ? ship.max_fuel : undefined,
    hull: typeof ship.hull === "number" ? ship.hull : undefined,
    maxHull: typeof ship.max_hull === "number" ? ship.max_hull : undefined,
    cargoUsed: typeof ship.cargo_used === "number" ? ship.cargo_used : undefined,
    cargoCapacity: typeof ship.cargo_capacity === "number" ? ship.cargo_capacity : undefined,
    credits: typeof player.credits === "number" ? player.credits : undefined,
    currentSystem: typeof player.current_system === "string" ? player.current_system : undefined,
    dockedAtBase: typeof player.docked_at_base === "boolean" ? player.docked_at_base : undefined,
  };
}

// ---------------------------------------------------------------------------
// Built-in rules
// ---------------------------------------------------------------------------

export const BUILT_IN_RULES: OverrideRule[] = [
  {
    name: "low-fuel",
    priority: 10,
    cooldownMs: 120_000, // 2 min
    condition: (ctx, agent) => {
      const state = extractAgentState(ctx.statusCache, agent);
      if (state.fuel === undefined || state.maxFuel === undefined || state.maxFuel === 0) return false;
      return (state.fuel / state.maxFuel) < 0.2;
    },
    directive: (ctx, agent) => {
      const state = extractAgentState(ctx.statusCache, agent);
      return `URGENT: Fuel critically low (${state.fuel}/${state.maxFuel}). Dock and refuel immediately before you get stranded.`;
    },
  },
  {
    name: "in-combat",
    priority: 5,
    cooldownMs: 30_000, // 30s — combat is urgent, re-fire frequently
    condition: (ctx, agent) => {
      const battle = ctx.battleCache.get(agent);
      if (!battle) return false;
      return battle.status !== "ended" && battle.status !== "victory" &&
             battle.status !== "defeat" && battle.status !== "fled";
    },
    directive: "URGENT: You are in active combat. Focus on battle actions (attack, flee, stance) — do NOT attempt navigation or trading.",
  },
  {
    name: "low-hull",
    priority: 15,
    cooldownMs: 120_000, // 2 min
    condition: (ctx, agent) => {
      const state = extractAgentState(ctx.statusCache, agent);
      if (state.hull === undefined || state.maxHull === undefined || state.maxHull === 0) return false;
      return (state.hull / state.maxHull) < 0.3;
    },
    directive: (ctx, agent) => {
      const state = extractAgentState(ctx.statusCache, agent);
      return `URGENT: Hull critically low (${state.hull}/${state.maxHull}). Dock at nearest station and repair. Avoid combat.`;
    },
  },
  {
    name: "cargo-full",
    priority: 20,
    cooldownMs: 180_000, // 3 min
    condition: (ctx, agent) => {
      const state = extractAgentState(ctx.statusCache, agent);
      if (state.cargoUsed === undefined || state.cargoCapacity === undefined || state.cargoCapacity === 0) return false;
      return state.cargoUsed >= state.cargoCapacity;
    },
    directive: "NOTICE: Cargo hold is full. Sell, deposit, or jettison items before attempting to mine or buy more.",
  },
  {
    name: "low-credits",
    priority: 25,
    cooldownMs: 600_000, // 10 min
    condition: (ctx, agent) => {
      const state = extractAgentState(ctx.statusCache, agent);
      if (state.credits === undefined) return false;
      return state.credits < 500;
    },
    directive: (ctx, agent) => {
      const state = extractAgentState(ctx.statusCache, agent);
      return `NOTICE: Credits critically low (${state.credits} cr). Prioritize selling cargo or completing missions to replenish funds.`;
    },
  },
  {
    name: "stuck-in-transit",
    priority: 8,
    cooldownMs: 60_000, // 1 min
    condition: (ctx, agent) => {
      // Agent has no current_system — likely stuck in hyperspace.
      // Only fire if we actually have a cache entry (no entry = agent not logged in, not stuck).
      if (!ctx.statusCache.has(agent)) return false;
      const state = extractAgentState(ctx.statusCache, agent);
      return state.currentSystem === undefined || state.currentSystem === "";
    },
    directive: "WARNING: You appear to be in hyperspace transit with no current system. Wait for arrival — do not attempt actions that require a location.",
  },
];

// ---------------------------------------------------------------------------
// OverrideRegistry
// ---------------------------------------------------------------------------

const MAX_HISTORY = 10;

export class OverrideRegistry {
  private rules: OverrideRule[] = [];
  /** Per-agent, per-rule last-fired timestamp for cooldown tracking. */
  private cooldowns = new Map<string, Map<string, number>>();
  /** Per-agent history of last N overrides. */
  private history = new Map<string, OverrideHistoryEntry[]>();

  constructor(rules?: OverrideRule[]) {
    if (rules) {
      this.rules = [...rules].sort((a, b) => a.priority - b.priority);
    }
  }

  addRule(rule: OverrideRule): void {
    this.rules.push(rule);
    this.rules.sort((a, b) => a.priority - b.priority);
  }

  removeRule(name: string): void {
    this.rules = this.rules.filter((r) => r.name !== name);
  }

  getRuleNames(): string[] {
    return this.rules.map((r) => r.name);
  }

  /**
   * Evaluate all rules for the given agent. Returns directives for all
   * matching rules that are not on cooldown (sorted by priority).
   */
  evaluate(ctx: OverrideContext, agent: string, now = Date.now()): string[] {
    const directives: string[] = [];

    for (const rule of this.rules) {
      // Check cooldown
      const agentCooldowns = this.cooldowns.get(agent);
      const lastFired = agentCooldowns?.get(rule.name);
      if (lastFired !== undefined && (now - lastFired) < rule.cooldownMs) {
        continue;
      }

      // Evaluate condition
      let matches = false;
      try {
        matches = rule.condition(ctx, agent);
      } catch (err) {
        log.warn("override rule condition error", { rule: rule.name, agent, error: err instanceof Error ? err.message : String(err) });
        continue;
      }

      if (!matches) continue;

      // Resolve directive text
      const text = typeof rule.directive === "function" ? rule.directive(ctx, agent) : rule.directive;
      directives.push(text);

      // Update cooldown
      if (!this.cooldowns.has(agent)) this.cooldowns.set(agent, new Map());
      this.cooldowns.get(agent)!.set(rule.name, now);

      // Update history
      if (!this.history.has(agent)) this.history.set(agent, []);
      const agentHistory = this.history.get(agent)!;
      agentHistory.push({ rule: rule.name, directive: text, timestamp: now });
      if (agentHistory.length > MAX_HISTORY) {
        agentHistory.splice(0, agentHistory.length - MAX_HISTORY);
      }
    }

    return directives;
  }

  /** Get the last N override history entries for an agent. */
  getHistory(agent: string): OverrideHistoryEntry[] {
    return this.history.get(agent) ?? [];
  }

  /** Get all override history for all agents. */
  getAllHistory(): Record<string, OverrideHistoryEntry[]> {
    const result: Record<string, OverrideHistoryEntry[]> = {};
    for (const [agent, entries] of this.history) {
      result[agent] = [...entries];
    }
    return result;
  }

  /** Clear cooldowns and history for an agent (e.g., on logout). */
  clearAgent(agent: string): void {
    this.cooldowns.delete(agent);
    this.history.delete(agent);
  }
}

// ---------------------------------------------------------------------------
// InjectionRegistry integration — create an Injection for the override system
// ---------------------------------------------------------------------------

import type { Injection } from "./injection-registry.js";

/**
 * Create an Injection that wires the OverrideRegistry into the injection pipeline.
 * Priority 5 — runs before all other injections.
 */
export function createOverrideInjection(registry: OverrideRegistry): Injection {
  return {
    name: "overrides",
    key: "_overrides",
    priority: 5,
    enabled: () => true,
    gather: (ctx: PipelineContext, agent: string) => {
      const overrideCtx: OverrideContext = {
        statusCache: ctx.statusCache ?? new Map(),
        battleCache: ctx.battleCache,
      };
      const directives = registry.evaluate(overrideCtx, agent);
      if (directives.length === 0) return null;
      return directives;
    },
  };
}
