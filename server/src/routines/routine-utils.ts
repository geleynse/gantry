/**
 * Shared utilities for routines — extracted to avoid circular deps between
 * routine-runner.ts and individual routine implementations.
 */

import type { RoutineContext, RoutinePhase, RoutineResult } from "./types.js";

export function done(summary: string, data: Record<string, unknown>, phases: RoutinePhase[]): RoutineResult {
  return { status: "completed", summary, data, phases, durationMs: 0 };
}

export function handoff(reason: string, data: Record<string, unknown>, phases: RoutinePhase[]): RoutineResult {
  return { status: "handoff", summary: reason, handoffReason: reason, data, phases, durationMs: 0 };
}

export function phase(name: string): RoutinePhase {
  return { name, startedAt: Date.now() };
}

export function completePhase(p: RoutinePhase, result?: unknown): RoutinePhase {
  return { ...p, completedAt: Date.now(), result };
}

export function checkCombat(result: unknown): boolean {
  if (!result) return false;
  const res = (result as Record<string, unknown>)?.result as Record<string, unknown> | undefined;
  if (res?.battle_started || (res?.event as Record<string, unknown>)?.type === "battle_started") return true;
  if ((result as Record<string, unknown>)?.error && ((result as Record<string, unknown>).error as Record<string, unknown>)?.code === "combat_detected") return true;
  return false;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  backoffMs = 2000,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, backoffMs * attempt));
      }
    }
  }
  throw lastError;
}

/**
 * Extract items with market demand from analyze_market results.
 * Handles multiple response shapes (demand/buyers/buy_orders, market/items).
 */
export function extractDemandItems(marketData: unknown): Set<string> {
  const demandItems = new Set<string>();
  if (!marketData || typeof marketData !== "object") return demandItems;

  const data = marketData as Record<string, unknown>;

  const demand = data.demand ?? data.buyers ?? data.buy_orders;
  if (Array.isArray(demand)) {
    for (const d of demand) {
      const itemId = (d as Record<string, unknown>).item_id ?? (d as Record<string, unknown>).id;
      if (typeof itemId === "string") demandItems.add(itemId);
    }
  }

  const market = data.market ?? data.items;
  if (Array.isArray(market)) {
    for (const m of market) {
      const entry = m as Record<string, unknown>;
      const hasDemand = entry.demand_quantity ?? entry.demand ?? entry.buyers;
      if (hasDemand && typeof (entry.item_id ?? entry.id) === "string") {
        demandItems.add(String(entry.item_id ?? entry.id));
      }
    }
  }

  return demandItems;
}

/** Extract mission array from API result — handles both array and { missions: [...] } shapes */
const MISSION_KEYS = ["missions", "active_missions", "available_missions", "items"];

export function extractMissionList(data: unknown): Array<Record<string, unknown>> {
  if (!data || typeof data !== "object") return [];
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  const obj = data as Record<string, unknown>;
  for (const key of MISSION_KEYS) {
    if (Array.isArray(obj[key])) return obj[key] as Array<Record<string, unknown>>;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Travel + Dock helper — shared by sell_cycle, craft_and_sell, salvage_loop, navigate_home
// ---------------------------------------------------------------------------

export interface TravelDockResult {
  phases: RoutinePhase[];
  /** Set when travel or dock failed — use as handoff reason. */
  failed?: string;
}

/**
 * Travel to a destination and dock. Handles retries and already-docked errors.
 * Returns accumulated phases. If `failed` is set, the caller should handoff.
 */
export async function travelAndDock(
  ctx: RoutineContext,
  destination: string,
  opts?: {
    alreadyAtStation?: boolean;
    alreadyDocked?: boolean;
    label?: string;
  },
): Promise<TravelDockResult> {
  const phases: RoutinePhase[] = [];
  const label = opts?.label ?? "routine";

  if (!opts?.alreadyAtStation) {
    const travelPhase = phase("travel_station");
    try {
      const travelResult = await withRetry(async () => {
        const resp = await ctx.client.execute("travel_to", { destination });
        if (resp.error) throw new Error(`travel_to failed: ${JSON.stringify(resp.error)}`);
        return resp.result;
      }, 2);
      phases.push(completePhase(travelPhase, travelResult));
      ctx.log("info", `${label}: arrived at ${destination}`);
    } catch (err) {
      phases.push(completePhase(travelPhase, { error: String(err) }));
      return { phases, failed: `Travel to ${destination} failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  if (!opts?.alreadyDocked) {
    const dockPhase = phase("dock");
    const dockResp = await ctx.client.execute("dock");
    if (dockResp.error) {
      const errStr = JSON.stringify(dockResp.error);
      if (errStr.includes("already_docked") || errStr.includes("already docked")) {
        ctx.log("info", `${label}: already docked`);
        phases.push(completePhase(dockPhase, { already_docked: true }));
      } else {
        phases.push(completePhase(dockPhase, { error: dockResp.error }));
        return { phases, failed: `Could not dock at ${destination}` };
      }
    } else {
      await ctx.client.waitForTick();
      phases.push(completePhase(dockPhase, dockResp.result));
      ctx.log("info", `${label}: docked`);
    }
  }

  return { phases };
}

// ---------------------------------------------------------------------------
// Cargo parsing — shared by sell_cycle, craft_and_sell, salvage_loop
// ---------------------------------------------------------------------------

export interface CargoItem {
  item_id: string;
  quantity: number;
}

/**
 * Parse cargo items from a get_cargo response.
 * Handles 3 response shapes: raw array, { items: [...] }, { cargo: [...] }.
 * Returns normalized { item_id, quantity }[] with qty > 0.
 */
export function parseCargoItems(cargoResult: unknown): CargoItem[] {
  if (!cargoResult || typeof cargoResult !== "object") return [];
  const data = cargoResult as Record<string, unknown>;
  const raw = Array.isArray(data) ? data
    : Array.isArray(data.items) ? data.items as unknown[]
    : Array.isArray(data.cargo) ? data.cargo as unknown[]
    : [];

  return (raw as Array<Record<string, unknown>>)
    .map((c) => ({
      item_id: String(c.item_id ?? c.id ?? ""),
      quantity: typeof c.quantity === "number" ? c.quantity : (typeof c.qty === "number" ? c.qty : 0),
    }))
    .filter((c) => c.quantity > 0 && c.item_id);
}

// ---------------------------------------------------------------------------
// Trade mission cost estimation — shared by mission_run
// ---------------------------------------------------------------------------

/**
 * Estimate the total credit cost to fulfill a trade mission by buying all required items.
 *
 * The game API returns trade missions with varying field names. We try all known
 * shapes defensively. Returns null if cost cannot be determined (allow the mission).
 *
 * Known shapes (as of v0.241 dynamic trade missions):
 *   { quantity, buy_price }          — unit price per item
 *   { quantity, price_each }         — alternate unit price name
 *   { quantity, unit_price }         — another alternate
 *   { required_credits }             — pre-computed total
 *   { total_cost }                   — pre-computed total
 *   { items: [{ quantity, buy_price }] }  — nested items array
 */
export function getTradeMissionCost(mission: Record<string, unknown>): number | null {
  // Pre-computed totals
  if (typeof mission.required_credits === "number") return mission.required_credits;
  if (typeof mission.total_cost === "number") return mission.total_cost;
  if (typeof mission.buy_total === "number") return mission.buy_total;

  // quantity × unit price
  const qty =
    typeof mission.quantity === "number" ? mission.quantity :
    typeof mission.item_count === "number" ? mission.item_count :
    null;

  const unitPrice =
    typeof mission.buy_price === "number" ? mission.buy_price :
    typeof mission.price_each === "number" ? mission.price_each :
    typeof mission.unit_price === "number" ? mission.unit_price :
    typeof mission.item_price === "number" ? mission.item_price :
    null;

  if (qty !== null && unitPrice !== null) return qty * unitPrice;

  // Nested items array: sum up each item's cost
  if (Array.isArray(mission.items) && mission.items.length > 0) {
    let total = 0;
    for (const item of mission.items as Array<Record<string, unknown>>) {
      const iqty =
        typeof item.quantity === "number" ? item.quantity :
        typeof item.qty === "number" ? item.qty :
        null;
      const iPrice =
        typeof item.buy_price === "number" ? item.buy_price :
        typeof item.price_each === "number" ? item.price_each :
        typeof item.unit_price === "number" ? item.unit_price :
        null;
      if (iqty === null || iPrice === null) return null; // can't compute partial sums
      total += iqty * iPrice;
    }
    return total > 0 ? total : null;
  }

  return null;
}

/**
 * Utility to parse cargo data from game tool results and calculate utilization.
 * Handles the nested result shape from ctx.client.execute().
 */
export function getCargoUtilization(cargoResult: unknown): {
  used: number;
  capacity: number;
  freeSpace: number;
  pctFull: number;
} | null {
  if (!cargoResult || typeof cargoResult !== "object") return null;

  // Sometimes we get the raw tool response { result: { ... }, error: ... }
  // or just the result object itself.
  const data = (cargoResult as any).result || cargoResult;

  if (typeof data !== "object" || data === null) return null;

  // SpaceMolt 'get_cargo' returns { used, capacity, cargo: [...] }
  // Some mining tools return { cargo_after: { used, max } } or similar.
  const used = typeof data.used === "number" ? data.used : (typeof data.cargo_after?.used === "number" ? data.cargo_after.used : null);
  const capacity = typeof data.capacity === "number" ? data.capacity : (typeof data.max === "number" ? data.max : (typeof data.cargo_after?.max === "number" ? data.cargo_after.max : null));

  if (used === null || capacity === null || capacity <= 0) {
    return null;
  }

  return {
    used,
    capacity,
    freeSpace: Math.max(0, capacity - used),
    pctFull: (used / capacity) * 100,
  };
}
