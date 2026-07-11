/**
 * Shared utilities for routines — extracted to avoid circular deps between
 * routine-runner.ts and individual routine implementations.
 */

import type { RoutineContext, RoutinePhase, RoutineResult } from "./types.js";
import {
  parseGetStatusText,
  parseTextTable,
  itemNameToId,
  parseCargoText,
  parseCargoUtilizationText,
  parseMarketDemandText,
  parseMarketAliasesText,
  type CargoItem,
} from "../proxy/game-text-parser.js";

// Re-exported from game-text-parser so existing importers/tests that pull these
// from routine-utils keep working. All TEXT-parsing implementation now lives in
// ../proxy/game-text-parser.ts (the single home for game-response text parsing).
export { parseTextTable, itemNameToId, type CargoItem };

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
  if (!result || typeof result !== "object") return false;
  const top = result as Record<string, unknown>;
  // Call sites pass either the full { result, error } envelope from execute()
  // or an already-unwrapped result object (e.g. jump results unwrapped inside
  // a withRetry closure) — inspect combat signals at both depths.
  const candidates = [top, top.result as Record<string, unknown> | undefined];
  for (const res of candidates) {
    if (!res || typeof res !== "object") continue;
    if (res.battle_started || (res.event as Record<string, unknown> | undefined)?.type === "battle_started") return true;
  }
  if (top.error && (top.error as Record<string, unknown>)?.code === "combat_detected") return true;
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

// ---------------------------------------------------------------------------
// Formatted-text table parsing (v0.417.3)
//
// v0.417.3 switched get_cargo, analyze_market, get_base, facility list and
// salvage_wreck from JSON to human-readable tab-separated TEXT tables. The proxy
// passes that text straight through (http-game-client-v2 parseToolCallResponse
// JSON.parse fails → returns the raw string), so routines that previously read
// structured fields now receive a string. The pure TEXT parsers live in
// ../proxy/game-text-parser.ts; the helpers below dispatch string→text-parser vs
// object→JSON shapes. See docs/proxy-todos.md (2026-06-23 sweep) in the fleet repo.
// ---------------------------------------------------------------------------

/**
 * Extract items with market demand from analyze_market results.
 * Handles multiple response shapes (demand/buyers/buy_orders, market/items),
 * plus the v0.417.3 formatted-text table.
 *
 * Returns a Map keyed by item_id AND (for the text format) the display-name slug,
 * each mapped to the CANONICAL item_id. Callers filter with `.has(c.item_id)` and
 * should resolve the cargo item to the canonical id with `.get(c.item_id)` before
 * selling — the cargo id may be a name-slug that isn't the real game id.
 */
export function extractDemandItems(marketData: unknown): Map<string, string> {
  const demandItems = new Map<string, string>();
  if (typeof marketData === "string") return parseMarketDemandText(marketData);
  if (!marketData || typeof marketData !== "object") return demandItems;

  const data = marketData as Record<string, unknown>;

  const demand = data.demand ?? data.buyers ?? data.buy_orders;
  if (Array.isArray(demand)) {
    for (const d of demand) {
      const itemId = (d as Record<string, unknown>).item_id ?? (d as Record<string, unknown>).id;
      if (typeof itemId === "string") demandItems.set(itemId, itemId);
    }
  }

  const market = data.market ?? data.items;
  if (Array.isArray(market)) {
    for (const m of market) {
      const entry = m as Record<string, unknown>;
      const hasDemand = entry.demand_quantity ?? entry.demand ?? entry.buyers;
      if (hasDemand && typeof (entry.item_id ?? entry.id) === "string") {
        const id = String(entry.item_id ?? entry.id);
        demandItems.set(id, id);
      }
    }
  }

  return demandItems;
}

/**
 * Build a slug/id → CANONICAL item_id alias map from EVERY row of an
 * analyze_market text table, regardless of insight category. Unlike
 * extractDemandItems (which only includes rows the station buys), this covers
 * all items the market knows about, so callers that need canonical ids for
 * NON-demand items (e.g. create_sell_order on leftovers) can resolve
 * name-slug cargo ids like mining_laser_i to real ids like mining_laser_1.
 * Items absent from the market table stay unresolved — callers should fall
 * back to the raw id (correct for the common slug==id case, e.g. ores).
 */
export function extractItemIdAliases(marketData: unknown): Map<string, string> {
  if (typeof marketData !== "string") return new Map<string, string>();
  return parseMarketAliasesText(marketData);
}

/**
 * Resolve cargo items (whose ids may be display-name slugs from the text cargo
 * table) against a demand map: keep only items the station buys, and rewrite each
 * to the CANONICAL item_id from the market so the sell/order command uses the real
 * game id rather than a slug alias. See extractDemandItems.
 */
export function resolveSellable<T extends { item_id: string }>(
  items: T[],
  demand: Map<string, string>,
): T[] {
  return items
    .filter((c) => demand.has(c.item_id))
    .map((c) => ({ ...c, item_id: demand.get(c.item_id) ?? c.item_id }));
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

/**
 * Parse cargo items from a get_cargo response.
 * Handles 4 response shapes: the v0.417.3 formatted-text table, raw array,
 * { items: [...] }, { cargo: [...] }. Returns normalized { item_id, quantity }[]
 * with qty > 0.
 */
export function parseCargoItems(cargoResult: unknown): CargoItem[] {
  // v0.417.3: get_cargo now returns a formatted text table instead of JSON.
  if (typeof cargoResult === "string") return parseCargoText(cargoResult);
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
 * Normalize a `get_status` result into the `{ player, ship }` shape the routines
 * consume — regardless of whether the game returned the OLD JSON object or the
 * v2 formatted TEXT dashboard string.
 *
 * v2 `get_status` returns a text dashboard, NOT `{ player, ship }`. Routines that
 * cast `resp.result as { player, ship }` therefore read `undefined` for every
 * field (arrival checks always fail, fuel/hull always unknown). Route the result
 * through this helper instead.
 *
 * Mapping when the result is a text dashboard (via parseGetStatusText):
 *   - `player.current_poi` + `player.docked_at_base` ← the "Docked at:" line. The
 *     text has no POI/system id; the dock line is the only location signal, so we
 *     expose it under both names the routines `.includes(station)`-check. It is
 *     undefined in space (correct: "not there yet" / "not docked").
 *   - `player.username/empire/credits` ← header line.
 *   - `ship.{hull,shield,fuel,cargo_used,...}` with BOTH `max_*` and `*_max`
 *     aliases so getStatPct/getCargoUtilization read either name, plus `modules`
 *     and named `cargo` rows.
 * When the result is already an object carrying `player`/`ship` (test/legacy/
 * future JSON), it is returned as-is. Anything else (undefined/unparseable/an
 * object without player|ship) yields `{}` so callers degrade exactly as before.
 *
 * NOTE: the text dashboard carries no system id, so `player.current_system` is
 * left undefined here (same as the raw string cast did). Routines that need it
 * (fleet_jump arrival, patrol) already fall back to the status cache.
 */
export function getStatusState(result: unknown): {
  player?: Record<string, unknown>;
  ship?: Record<string, unknown>;
} {
  // Already-object shape (test mocks, legacy JSON, future-proofing).
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const obj = result as Record<string, unknown>;
    if ("player" in obj || "ship" in obj) {
      return {
        player: obj.player as Record<string, unknown> | undefined,
        ship: obj.ship as Record<string, unknown> | undefined,
      };
    }
    return {};
  }

  // v2 formatted TEXT dashboard.
  if (typeof result === "string") {
    const p = parseGetStatusText(result);
    const player: Record<string, unknown> = {
      username: p.username,
      empire: p.empire,
      credits: p.credits,
      // Only location signal in the text is the "Docked at:" line — expose it as
      // both the poi and the dock field the routines check.
      current_poi: p.dockedAt,
      docked_at_base: p.dockedAt,
    };
    const ship: Record<string, unknown> = {
      hull: p.hull,
      max_hull: p.maxHull,
      hull_max: p.maxHull,
      shield: p.shield,
      max_shield: p.maxShield,
      shield_max: p.maxShield,
      armor: p.armor,
      speed: p.speed,
      fuel: p.fuel,
      max_fuel: p.maxFuel,
      fuel_max: p.maxFuel,
      cargo_used: p.cargoUsed,
      cargo_capacity: p.cargoCapacity,
      cpu_used: p.cpuUsed,
      cpu_capacity: p.cpuCapacity,
      power_used: p.powerUsed,
      power_capacity: p.powerCapacity,
      modules: p.modules,
      cargo: p.cargo.map((c) => ({ name: c.name, quantity: c.quantity })),
    };
    return { player, ship };
  }

  return {};
}

/**
 * Read hull or fuel percentage from a ship status object.
 * Handles both field name variants (max_hull / hull_max, max_fuel / fuel_max).
 * Returns null if data is missing.
 */
export function getStatPct(
  ship: Record<string, unknown> | undefined,
  stat: "hull" | "fuel",
): number | null {
  if (!ship) return null;
  const current = typeof ship[stat] === "number" ? (ship[stat] as number) : undefined;
  const maxKey = `max_${stat}` as const;
  const maxKeyAlt = `${stat}_max` as const;
  const max = typeof ship[maxKey] === "number" ? (ship[maxKey] as number)
            : typeof ship[maxKeyAlt] === "number" ? (ship[maxKeyAlt] as number)
            : undefined;
  if (current === undefined || max === undefined || max <= 0) return null;
  return (current / max) * 100;
}

/**
 * Utility to parse cargo data from game tool results and calculate utilization.
 * Handles the nested result shape from ctx.client.execute().
 *
 * v0.417.3: get_status / get_cargo can be formatted TEXT. Callers should pass a
 * get_status result here — its "Cargo: U/C" line carries the true used/capacity.
 * (get_cargo's own header reports an unreliable "0/0", so it can't drive
 * utilization — this returns null for it, which callers already treat as
 * "unknown" and degrade to the game's own cargo_full error.)
 */
export function getCargoUtilization(cargoResult: unknown): {
  used: number;
  capacity: number;
  freeSpace: number;
  pctFull: number;
} | null {
  // Unwrap { result: ... } from ctx.client.execute(); keep a string result as-is.
  let data: unknown = cargoResult;
  if (cargoResult && typeof cargoResult === "object" && "result" in (cargoResult as Record<string, unknown>)) {
    data = (cargoResult as Record<string, unknown>).result;
  }

  // Formatted text dashboard: read the "Cargo: <used>/<capacity>" line.
  if (typeof data === "string") {
    return parseCargoUtilizationText(data);
  }

  if (!data || typeof data !== "object") return null;
  const data2 = data as Record<string, unknown>;

  // SpaceMolt 'get_cargo' returns { used, capacity, cargo: [...] }
  // Some mining tools return { cargo_after: { used, max } } or similar.
  // The canonical parsed get_status shape nests it under ship.cargo_used/_capacity.
  const cargoAfter = typeof data2.cargo_after === "object" && data2.cargo_after !== null ? data2.cargo_after as Record<string, unknown> : undefined;
  const ship = typeof data2.ship === "object" && data2.ship !== null ? data2.ship as Record<string, unknown> : undefined;
  const used = typeof data2.used === "number" ? data2.used
    : typeof cargoAfter?.used === "number" ? cargoAfter.used
    : typeof ship?.cargo_used === "number" ? ship.cargo_used as number
    : null;
  const capacity = typeof data2.capacity === "number" ? data2.capacity
    : typeof data2.max === "number" ? data2.max
    : typeof cargoAfter?.max === "number" ? cargoAfter.max
    : typeof ship?.cargo_capacity === "number" ? ship.cargo_capacity as number
    : null;

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
