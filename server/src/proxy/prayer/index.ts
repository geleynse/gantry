import { analyzePrayerProgram } from "./analyzer.js";
import { executePrayerProgram } from "./executor.js";
import { formatPrayerProgram, parsePrayerScript } from "./parser.js";
import { currentPoi, currentSystem, getCargo } from "./state.js";
import { resultFromError } from "./result.js";
import type { AnalyzerSnapshot, ExecutorDeps, PrayResult } from "./types.js";

export interface RunPrayerDeps extends ExecutorDeps {
  agentDeniedTools: Record<string, Record<string, string>>;
  fuzzyMatchThreshold?: number;
}

export async function runPrayerScript(script: string, deps: RunPrayerDeps): Promise<PrayResult> {
  const startedAt = Date.now();
  let parsed;
  try {
    parsed = parsePrayerScript(script);
    const snapshot = buildAnalyzerSnapshot(deps);
    const analyzed = analyzePrayerProgram(parsed, snapshot);
    const normalized = formatPrayerProgram(parsed);
    const result = await executePrayerProgram({ ...analyzed, source: normalized }, deps);
    return result;
  } catch (err) {
    return resultFromError(err, null, null, startedAt);
  }
}

export function buildAnalyzerSnapshot(deps: RunPrayerDeps): AnalyzerSnapshot {
  const data = deps.statusCache.get(deps.agentName)?.data ?? {};
  return {
    agentName: deps.agentName,
    currentSystem: currentSystem(data),
    currentPoi: currentPoi(data),
    items: extractItems(data),
    pois: extractPois(data),
    agentDeniedTools: deps.agentDeniedTools,
    fuzzyMatchThreshold: deps.fuzzyMatchThreshold ?? 0.62,
  };
}

function extractItems(data: Record<string, unknown>): Array<{ id: string; name?: string }> {
  const fromCargo = getCargo(data).map((item) => ({
    id: String(item.item_id ?? item.id ?? ""),
    name: typeof item.name === "string" ? item.name : undefined,
  })).filter((item) => item.id);
  const catalog = Array.isArray(data.items) ? data.items : Array.isArray(data.catalog_items) ? data.catalog_items : [];
  const fromCatalog = catalog
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item) => ({
      id: String(item.id ?? item.item_id ?? ""),
      name: typeof item.name === "string" ? item.name : undefined,
    })).filter((item) => item.id);
  return dedupeById([...fromCargo, ...fromCatalog]);
}

function extractPois(data: Record<string, unknown>): Array<{ id: string; name?: string; type?: string; system_id?: string }> {
  const pois = Array.isArray(data.pois) ? data.pois : Array.isArray(data.system_pois) ? data.system_pois : [];
  return pois
    .filter((poi): poi is Record<string, unknown> => !!poi && typeof poi === "object")
    .map((poi) => ({
      id: String(poi.id ?? poi.poi_id ?? ""),
      name: typeof poi.name === "string" ? poi.name : undefined,
      type: typeof poi.type === "string" ? poi.type : undefined,
      system_id: typeof poi.system_id === "string" ? poi.system_id : undefined,
    }))
    .filter((poi) => poi.id);
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

export { parsePrayerScript, formatPrayerProgram, analyzePrayerProgram };
export {
  serialize as serializeExecState,
  deserialize as deserializeExecState,
  saveCheckpoint,
  loadCheckpoint,
  clearCheckpoint,
  setPrayerStateDir,
  getPrayerStateDir,
} from "./checkpoint.js";
export type { PrayResult, ExecState } from "./types.js";
