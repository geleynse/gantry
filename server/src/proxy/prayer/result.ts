import { cargoByItem, dockedFlag, numberAt } from "./state.js";
import {
  PrayerAnalyzeError,
  PrayerParseError,
  PrayerRuntimeError,
  type AnalyzedProgram,
  type ExecState,
  type PrayDiff,
  type PrayResult,
} from "./types.js";

export interface DiffSnapshot {
  credits: number;
  fuel: number;
  cargo: Map<string, number>;
  docked: boolean;
}

export function snapshotDiff(data: Record<string, unknown>): DiffSnapshot {
  return {
    credits: numberAt(data, ["player", "credits"]),
    fuel: numberAt(data, ["ship", "fuel"]),
    cargo: cargoByItem(data),
    docked: dockedFlag(data),
  };
}

export function diffSnapshots(before: DiffSnapshot, after: DiffSnapshot): PrayDiff {
  const cargoItems = new Set([...before.cargo.keys(), ...after.cargo.keys()]);
  return {
    credits: { before: before.credits, after: after.credits, delta: after.credits - before.credits },
    fuel: { before: before.fuel, after: after.fuel, delta: after.fuel - before.fuel },
    cargo: [...cargoItems].sort().map((item) => {
      const b = before.cargo.get(item) ?? 0;
      const a = after.cargo.get(item) ?? 0;
      return { item, before: b, after: a, delta: a - b };
    }).filter((item) => item.delta !== 0),
    flags: { docked_before: before.docked, docked_after: after.docked },
  };
}

export function resultFromError(
  err: unknown,
  program: AnalyzedProgram | null,
  state: ExecState | null,
  startedAt: number,
  diff?: PrayDiff,
): PrayResult {
  const duration_ms = Date.now() - startedAt;
  const base = {
    steps_executed: state?.stepsExecuted ?? 0,
    normalized_script: program?.source ?? "",
    warnings: program?.warnings.map((w) => w.message),
    diff,
    subcalls: state?.log.map((entry) => ({ tool: entry.tool, ok: entry.ok, duration_ms: entry.durationMs })),
    duration_ms,
  };

  if (err instanceof PrayerParseError) {
    return { ...base, status: "error", error: { tier: "parse", message: err.message, line: err.loc.line, col: err.loc.col } };
  }
  if (err instanceof PrayerAnalyzeError) {
    return { ...base, status: "error", error: { tier: "analyze", message: err.message, line: err.loc?.line, col: err.loc?.col, suggestions: err.suggestions } };
  }
  if (err instanceof PrayerRuntimeError) {
    if (err.code === "step_limit_reached") return { ...base, status: "step_limit_reached" };
    if (err.code === "interrupted") {
      return { ...base, status: "interrupted", handoff_reason: state?.interrupt?.reason ?? err.message };
    }
    return { ...base, status: "error", error: { tier: "runtime", code: err.code, message: err.message, line: err.loc?.line, col: err.loc?.col } };
  }
  return {
    ...base,
    status: "error",
    error: { tier: "runtime", code: "unknown_error", message: err instanceof Error ? err.message : String(err) },
  };
}
