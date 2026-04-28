import { cargoPct, cargoQuantity, numberAt } from "./state.js";
import { PrayerRuntimeError, type AnalyzedArg, type AnalyzedPredicate, type ExecState, type ExecutorDeps, type ResolvedArg } from "./types.js";

export async function evalPredicate(pred: AnalyzedPredicate, state: ExecState, deps: ExecutorDeps): Promise<boolean> {
  const lhs = await computeMetric(pred, state, deps);
  switch (pred.op) {
    case ">": return lhs > pred.rhs;
    case ">=": return lhs >= pred.rhs;
    case "<": return lhs < pred.rhs;
    case "<=": return lhs <= pred.rhs;
    case "==": return lhs === pred.rhs;
    case "!=": return lhs !== pred.rhs;
  }
}

export function resolveArg(arg: AnalyzedArg, deps: ExecutorDeps): ResolvedArg {
  if (arg.kind === "static") return arg.value;
  const data = deps.statusCache.get(deps.agentName)?.data;
  if (!data) throw new PrayerRuntimeError("status_unavailable", "No status data available for dynamic macro");
  if (arg.macro === "home") {
    const player = data.player && typeof data.player === "object" ? data.player as Record<string, unknown> : {};
    const home = player.home_poi ?? player.home_system;
    if (typeof home !== "string" || !home) throw new PrayerRuntimeError("home_not_set", "Agent has no home_poi or home_system set");
    return home;
  }
  const pois = Array.isArray(data.pois) ? data.pois : Array.isArray(data.system_pois) ? data.system_pois : [];
  const station = pois.find((poi) => poi && typeof poi === "object" && String((poi as Record<string, unknown>).type ?? "").includes("station"));
  const stationId = station && typeof station === "object" ? ((station as Record<string, unknown>).id ?? (station as Record<string, unknown>).poi_id) : null;
  if (typeof stationId === "string" && stationId) return stationId;
  throw new PrayerRuntimeError("no_station_in_system", "Could not resolve $nearest_station from cached state");
}

async function computeMetric(pred: AnalyzedPredicate, state: ExecState, deps: ExecutorDeps): Promise<number> {
  const data = deps.statusCache.get(deps.agentName)?.data;
  if (!data) throw new PrayerRuntimeError("status_unavailable", "No status data available for predicate evaluation", pred.loc);

  switch (pred.metric) {
    case "FUEL":
      return numberAt(data, ["ship", "fuel"]);
    case "CREDITS":
      return numberAt(data, ["player", "credits"]);
    case "CARGO_PCT":
      return cargoPct(data);
    case "CARGO": {
      const item = String(resolveArgForMetric(pred.args[0], deps));
      return cargoQuantity(data, item);
    }
    case "MINED": {
      const item = String(resolveArgForMetric(pred.args[0], deps));
      return Math.max(0, cargoQuantity(data, item) - (state.cargoBaseline.get(item) ?? 0));
    }
    case "STASHED": {
      const item = String(resolveArgForMetric(pred.args[0], deps));
      return totalStashed(data, item);
    }
    case "STASH": {
      const poi = String(resolveArgForMetric(pred.args[0], deps));
      const item = String(resolveArgForMetric(pred.args[1], deps));
      return stashAtPoi(data, poi, item);
    }
    case "MISSION_ACTIVE":
      return activeMissionCount(data);
  }
}

/**
 * Sum of `item` quantity across the agent's personal storage at any POI.
 *
 * Reads from cached `personal_storage` records on `data` if present. Each
 * record is an object with `item_id` (or `id`) and `quantity` (or `qty`).
 * Returns 0 if storage isn't cached — callers can pre-populate the cache via
 * `view_storage` before relying on this predicate.
 */
function totalStashed(data: Record<string, unknown>, itemId: string): number {
  const records = personalStorageRecords(data);
  let total = 0;
  for (const rec of records) {
    if (recordItemId(rec) === itemId) total += recordQuantity(rec);
  }
  return total;
}

/**
 * Quantity of `item` stashed at a specific POI. Counts both personal storage
 * at that POI and faction storage at that POI owned by the agent's faction.
 */
function stashAtPoi(data: Record<string, unknown>, poiId: string, itemId: string): number {
  let total = 0;
  for (const rec of personalStorageRecords(data)) {
    if (recordPoiId(rec) === poiId && recordItemId(rec) === itemId) {
      total += recordQuantity(rec);
    }
  }
  const ownFaction = agentFactionId(data);
  for (const rec of factionStorageRecords(data)) {
    if (recordPoiId(rec) !== poiId) continue;
    if (recordItemId(rec) !== itemId) continue;
    // If a faction_id is recorded on the entry, require it to match the
    // agent's faction. If not present, accept (the upstream API only returns
    // entries the agent can see).
    const factionId = recordFactionId(rec);
    if (factionId && ownFaction && factionId !== ownFaction) continue;
    total += recordQuantity(rec);
  }
  return total;
}

function personalStorageRecords(data: Record<string, unknown>): Array<Record<string, unknown>> {
  return collectRecords(data.personal_storage ?? data.personalStorage ?? data.storage);
}

function factionStorageRecords(data: Record<string, unknown>): Array<Record<string, unknown>> {
  return collectRecords(data.faction_storage ?? data.factionStorage);
}

function collectRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object" && !Array.isArray(entry));
}

function recordItemId(rec: Record<string, unknown>): string {
  return String(rec.item_id ?? rec.id ?? "");
}

function recordQuantity(rec: Record<string, unknown>): number {
  const n = Number(rec.quantity ?? rec.qty ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function recordPoiId(rec: Record<string, unknown>): string {
  return String(rec.poi_id ?? rec.poi ?? rec.station_id ?? rec.location ?? "");
}

function recordFactionId(rec: Record<string, unknown>): string {
  return String(rec.faction_id ?? rec.factionId ?? "");
}

function agentFactionId(data: Record<string, unknown>): string {
  const player = data.player && typeof data.player === "object" ? data.player as Record<string, unknown> : {};
  return String(player.faction_id ?? player.factionId ?? "");
}

/**
 * Count of active missions from the status cache.
 *
 * Checks (in priority order):
 * 1. `data.active_missions` — array field populated by `get_active_missions` results
 *    when merged into the cache (matches keys used by extractMissionList in routine-utils).
 * 2. `data._active_missions_count` — synthetic integer set by state enrichment paths.
 * 3. `data.missions` — fallback array key used in some API shapes.
 *
 * Returns 0 when none of the above are present — callers can populate the cache via
 * `get_active_missions` before relying on this predicate.
 */
function activeMissionCount(data: Record<string, unknown>): number {
  // Array shapes (from extractMissionList key list)
  for (const key of ["active_missions", "missions"] as const) {
    if (Array.isArray(data[key])) return (data[key] as unknown[]).length;
  }
  // Synthetic integer set by state enrichment
  const count = Number(data._active_missions_count ?? 0);
  return Number.isFinite(count) ? count : 0;
}

function resolveArgForMetric(arg: AnalyzedArg | undefined, deps: ExecutorDeps): ResolvedArg {
  if (!arg) throw new PrayerRuntimeError("predicate_arg_missing", "Predicate is missing a required argument");
  return resolveArg(arg, deps);
}
