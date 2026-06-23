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

// ---------------------------------------------------------------------------
// Formatted-text table parsing (v0.417.3)
//
// v0.417.3 switched get_cargo, analyze_market, get_base, facility list and
// salvage_wreck from JSON to human-readable tab-separated TEXT tables. The proxy
// passes that text straight through (http-game-client-v2 parseToolCallResponse
// JSON.parse fails → returns the raw string), so routines that previously read
// structured fields now receive a string. These helpers parse the table back
// into structure. See docs/proxy-todos.md (2026-06-23 sweep) in the fleet repo.
// ---------------------------------------------------------------------------

/**
 * Parse the first tab-separated table out of a text dashboard.
 * Skips any preamble lines (e.g. "Cargo: 0/0 used…" / "Trading insights at …:")
 * before the header row, then collects rows until the table ends (first
 * non-tab line, e.g. a blank line or a trailing "Credits: …cr").
 * Returns lowercased header columns + the data rows (trimmed cells).
 */
export function parseTextTable(text: string): { headers: string[]; rows: string[][] } {
  let headers: string[] | null = null;
  const rows: string[][] = [];
  for (const line of text.split("\n")) {
    if (!line.includes("\t")) {
      if (headers) break;   // table started and now ended
      continue;             // still in preamble
    }
    const cols = line.split("\t").map((c) => c.trim());
    if (!headers) headers = cols.map((c) => c.toLowerCase());
    else rows.push(cols);
  }
  return { headers: headers ?? [], rows };
}

/**
 * Convert a display name to its item_id slug — the inverse of the generic
 * id→name transform in lib/utils.ts getItemDisplayName ("Power Cell" →
 * "power_cell", "Shield Booster II" → "shield_booster_ii"). Used when the
 * formatted table gives only a name column (get_cargo) and a caller needs an id.
 */
export function itemNameToId(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Parse get_cargo's formatted text table (header "item\tqty\tsize") into cargo items. */
function parseCargoItemsFromText(text: string): CargoItem[] {
  const { headers, rows } = parseTextTable(text);
  if (headers.length === 0) return [];
  const nameIdx = headers.findIndex((h) => h === "item" || h === "name");
  const qtyIdx = headers.findIndex((h) => h === "qty" || h === "quantity");
  const idIdx = headers.findIndex((h) => h === "item_id" || h === "id");
  if (nameIdx === -1 && idIdx === -1) return [];
  const out: CargoItem[] = [];
  for (const cols of rows) {
    const name = nameIdx >= 0 ? (cols[nameIdx] ?? "") : "";
    // Prefer an explicit id column if the game ever adds one; else slug the name.
    const item_id = (idIdx >= 0 && cols[idIdx]) ? cols[idIdx] : itemNameToId(name);
    const quantity = qtyIdx >= 0 ? parseInt(cols[qtyIdx], 10) : NaN;
    if (item_id && !isNaN(quantity) && quantity > 0) out.push({ item_id, quantity });
  }
  return out;
}

// analyze_market insight categories (observed live, v0.427.x) that mean the
// station BUYS the item from us — i.e. a valid sell target:
//   demand          — station has buy demand for the item
//   sell_here       — explicitly flagged as a good place to sell
//   supply_imbalance — captured live: "<item> has N units of unfilled buy orders
//                      here at <price> with nothing for sale — potential
//                      opportunity." i.e. a supply SHORTAGE = strong buy demand,
//                      often the highest-value sell target. (Excluding it made
//                      agents skip premium shortage stations / leave cargo.)
// Excluded (not direct buy-demand): opportunity/arbitrage (cross-station hints),
// depth_warning, manager_activity.
const SELL_TARGET_CATEGORIES = new Set(["demand", "sell_here", "supply_imbalance"]);

/** Parse analyze_market's formatted text table for items the station demands. */
function extractDemandItemsFromText(text: string): Set<string> {
  const demandItems = new Set<string>();
  const { headers, rows } = parseTextTable(text);
  const idIdx = headers.findIndex((h) => h === "item_id" || h === "id");
  const catIdx = headers.findIndex((h) => h === "category");
  const nameIdx = headers.findIndex((h) => h === "item" || h === "name");
  if (idIdx === -1) return demandItems;
  for (const cols of rows) {
    const id = cols[idIdx];
    if (!id) continue;
    const cat = catIdx >= 0 ? (cols[catIdx] ?? "").toLowerCase() : "";
    // No category column → can't tell direction; include (better to attempt
    // the sell, which no-ops at the game, than to skip a real buyer).
    if (catIdx === -1 || SELL_TARGET_CATEGORIES.has(cat) || cat.includes("demand")) {
      demandItems.add(id);
      // Also add the name→id slug as an alias. parseCargoItems derives a cargo
      // item's id by slugging its display NAME (the cargo table has no id column),
      // so for items whose real id isn't the literal slug (e.g. mining_laser_1 vs
      // "Mining Laser I" → mining_laser_i) the cargo↔demand join would miss. The
      // alias makes the join name-space-robust regardless of id convention.
      if (nameIdx >= 0 && cols[nameIdx]) demandItems.add(itemNameToId(cols[nameIdx]));
    }
  }
  return demandItems;
}

/**
 * Extract items with market demand from analyze_market results.
 * Handles multiple response shapes (demand/buyers/buy_orders, market/items),
 * plus the v0.417.3 formatted-text table.
 */
export function extractDemandItems(marketData: unknown): Set<string> {
  const demandItems = new Set<string>();
  if (typeof marketData === "string") return extractDemandItemsFromText(marketData);
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
 * Handles 4 response shapes: the v0.417.3 formatted-text table, raw array,
 * { items: [...] }, { cargo: [...] }. Returns normalized { item_id, quantity }[]
 * with qty > 0.
 */
export function parseCargoItems(cargoResult: unknown): CargoItem[] {
  // v0.417.3: get_cargo now returns a formatted text table instead of JSON.
  if (typeof cargoResult === "string") return parseCargoItemsFromText(cargoResult);
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
    const m = data.match(/Cargo:\s*(\d+)\s*\/\s*(\d+)/);
    if (m) {
      const used = parseInt(m[1], 10);
      const capacity = parseInt(m[2], 10);
      if (!isNaN(used) && !isNaN(capacity) && capacity > 0) {
        return { used, capacity, freeSpace: Math.max(0, capacity - used), pctFull: (used / capacity) * 100 };
      }
    }
    return null;
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
