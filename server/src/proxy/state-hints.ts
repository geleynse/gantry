/**
 * State Hints: proactive hint system that suggests actions based on current
 * game state, not just errors. Injected periodically (every 3rd tool call)
 * at low priority (65) to avoid overwhelming agents.
 */

import type { PipelineContext } from "./pipeline.js";
import type { Injection } from "./injection-registry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HintCategory = "economy" | "combat" | "navigation" | "maintenance";

export interface StateHint {
  id: string;
  category: HintCategory;
  condition: (statusCache: Map<string, { data: Record<string, unknown>; fetchedAt: number }>, agent: string) => boolean;
  hint: string;
}

// ---------------------------------------------------------------------------
// Helpers — extract agent data from statusCache
// ---------------------------------------------------------------------------

function getAgentData(statusCache: Map<string, { data: Record<string, unknown>; fetchedAt: number }>, agent: string): {
  player: Record<string, unknown>;
  ship: Record<string, unknown>;
} | null {
  const cached = statusCache.get(agent);
  if (!cached) return null;
  const data = cached.data;
  const player = (data.player ?? data) as Record<string, unknown>;
  const ship = (data.ship ?? player.ship ?? {}) as Record<string, unknown>;
  return { player, ship };
}

// ---------------------------------------------------------------------------
// Built-in hints
// ---------------------------------------------------------------------------

export const BUILT_IN_HINTS: StateHint[] = [
  {
    id: "near-market-with-cargo",
    category: "economy",
    condition: (cache, agent) => {
      const d = getAgentData(cache, agent);
      if (!d) return false;
      const cargoUsed = d.ship.cargo_used as number | undefined;
      const docked = d.player.docked_at_base;
      // Has cargo and is docked at a station
      return (cargoUsed !== undefined && cargoUsed > 0 && docked === true);
    },
    hint: "You're docked with cargo. Consider selling items or checking analyze_market for good prices.",
  },
  {
    id: "low-fuel-near-station",
    category: "maintenance",
    condition: (cache, agent) => {
      const d = getAgentData(cache, agent);
      if (!d) return false;
      const fuel = d.ship.fuel as number | undefined;
      const maxFuel = d.ship.max_fuel as number | undefined;
      const docked = d.player.docked_at_base;
      if (fuel === undefined || maxFuel === undefined || maxFuel === 0) return false;
      return (fuel / maxFuel) < 0.4 && docked === true;
    },
    hint: "Fuel below 40% and you're docked. Refuel before departing.",
  },
  {
    id: "damaged-near-repair",
    category: "maintenance",
    condition: (cache, agent) => {
      const d = getAgentData(cache, agent);
      if (!d) return false;
      const hull = d.ship.hull as number | undefined;
      const maxHull = d.ship.max_hull as number | undefined;
      const docked = d.player.docked_at_base;
      if (hull === undefined || maxHull === undefined || maxHull === 0) return false;
      return (hull / maxHull) < 0.6 && docked === true;
    },
    hint: "Hull below 60% and you're docked. Repair is available at this station.",
  },
  {
    id: "empty-cargo-near-asteroids",
    category: "economy",
    condition: (cache, agent) => {
      const d = getAgentData(cache, agent);
      if (!d) return false;
      const cargoUsed = d.ship.cargo_used as number | undefined;
      const cargoCapacity = d.ship.cargo_capacity as number | undefined;
      const poi = d.player.current_poi as string | undefined;
      if (cargoUsed === undefined || cargoCapacity === undefined || !poi) return false;
      const poiLower = poi.toLowerCase();
      // Empty or mostly empty cargo, and at a belt or mining-related POI
      return (cargoUsed / cargoCapacity) < 0.2 && (poiLower.includes("belt") || poiLower.includes("field") || poiLower.includes("asteroid"));
    },
    hint: "Cargo is mostly empty and you're at a mining site. Good opportunity to mine.",
  },
  {
    id: "mission-deadline-approaching",
    category: "navigation",
    condition: (cache, agent) => {
      // Mission deadline is not directly in statusCache — this checks if
      // the agent has active missions marker (set by passthrough when
      // get_active_missions is called). We use a proxy signal: if the
      // statusCache has _active_missions_count > 0, hint to check them.
      const cached = cache.get(agent);
      if (!cached) return false;
      const missionCount = (cached.data as Record<string, unknown>)._active_missions_count;
      return typeof missionCount === "number" && missionCount > 0;
    },
    hint: "You have active missions. Check get_active_missions to verify deadlines.",
  },
];

// ---------------------------------------------------------------------------
// StateHintEngine
// ---------------------------------------------------------------------------

const MAX_HINTS_PER_INJECTION = 2;
const HINT_FREQUENCY = 3; // inject every Nth tool call

export class StateHintEngine {
  private hints: StateHint[];
  /** Per-agent call counter for frequency limiting. */
  private callCounters = new Map<string, number>();

  constructor(hints?: StateHint[]) {
    this.hints = hints ?? [...BUILT_IN_HINTS];
  }

  addHint(hint: StateHint): void {
    this.hints.push(hint);
  }

  removeHint(id: string): void {
    this.hints = this.hints.filter((h) => h.id !== id);
  }

  getHintIds(): string[] {
    return this.hints.map((h) => h.id);
  }

  /**
   * Evaluate all hints for the given agent. Returns up to MAX_HINTS_PER_INJECTION
   * matching hints. Respects the call-frequency counter (only evaluates every Nth call).
   */
  evaluate(statusCache: Map<string, { data: Record<string, unknown>; fetchedAt: number }>, agent: string): string[] | null {
    // Frequency limiting
    const count = (this.callCounters.get(agent) ?? 0) + 1;
    this.callCounters.set(agent, count);
    if (count % HINT_FREQUENCY !== 0) return null;

    const matched: string[] = [];
    for (const hint of this.hints) {
      try {
        if (hint.condition(statusCache, agent)) {
          matched.push(hint.hint);
          if (matched.length >= MAX_HINTS_PER_INJECTION) break;
        }
      } catch {
        // Non-fatal — skip broken hints
      }
    }
    return matched.length > 0 ? matched : null;
  }

  /** Reset the call counter for an agent (e.g., on logout). */
  resetCounter(agent: string): void {
    this.callCounters.delete(agent);
  }
}

// ---------------------------------------------------------------------------
// Injection integration
// ---------------------------------------------------------------------------

/**
 * Create an Injection that wires the StateHintEngine into the injection pipeline.
 * Priority 65 — low priority, after critical injections.
 */
export function createStateHintInjection(engine: StateHintEngine): Injection {
  return {
    name: "state-hints",
    key: "_hints",
    priority: 65,
    enabled: () => true,
    gather: (ctx: PipelineContext, agent: string) => {
      const statusCache = ctx.statusCache ?? new Map();
      return engine.evaluate(statusCache, agent);
    },
  };
}
