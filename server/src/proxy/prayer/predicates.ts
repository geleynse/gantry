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
      return numberAt(data, ["player", "fuel"]);
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
  }
}

function resolveArgForMetric(arg: AnalyzedArg | undefined, deps: ExecutorDeps): ResolvedArg {
  if (!arg) throw new PrayerRuntimeError("predicate_arg_missing", "Predicate is missing a required argument");
  return resolveArg(arg, deps);
}
