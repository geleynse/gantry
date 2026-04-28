import { COMMANDS, UNSUPPORTED_COMMANDS } from "./commands.js";
import {
  PrayerAnalyzeError,
  type AnalyzedArg,
  type AnalyzedPredicate,
  type AnalyzedProgram,
  type AnalyzedStmt,
  type AnalyzerSnapshot,
  type AnalyzerWarning,
  type ArgType,
  type AstArg,
  type AstPredicate,
  type AstProgram,
  type AstStmt,
  type CommandSpec,
  type PredicateName,
} from "./types.js";

const PREDICATES = new Set(["FUEL", "CREDITS", "CARGO_PCT", "CARGO", "MINED", "STASHED", "STASH", "MISSION_ACTIVE"]);

const PREDICATE_ARG_TYPES: Record<string, ArgType[]> = {
  FUEL: [],
  CREDITS: [],
  CARGO_PCT: [],
  CARGO: ["item"],
  MINED: ["item"],
  STASHED: ["item"],
  STASH: ["destination", "item"],
  MISSION_ACTIVE: [],
};

export function analyzePrayerProgram(program: AstProgram, snapshot: AnalyzerSnapshot): AnalyzedProgram {
  const warnings: AnalyzerWarning[] = [];
  let hasUntil = false;

  const statements = program.statements.map((stmt) => analyzeStmt(stmt));

  return {
    statements,
    warnings,
    maxStepsHint: hasUntil ? 50 : null,
    source: program.source,
  };

  function analyzeStmt(stmt: AstStmt): AnalyzedStmt {
    if (stmt.kind === "if" || stmt.kind === "until") {
      if (stmt.kind === "until") hasUntil = true;
      return {
        kind: stmt.kind,
        cond: analyzePredicate(stmt.cond),
        body: stmt.body.map((child) => analyzeStmt(child)),
        loc: stmt.loc,
      };
    }

    if (UNSUPPORTED_COMMANDS.has(stmt.name)) {
      throw new PrayerAnalyzeError(`command '${stmt.name}' is not available in Gantry PrayerLang`, stmt.loc);
    }
    const spec = COMMANDS[stmt.name];
    if (!spec) {
      throw new PrayerAnalyzeError(`unknown command '${stmt.name}'`, stmt.loc, nearestNames(stmt.name, Object.keys(COMMANDS)));
    }
    const [min, max] = spec.arity;
    if (stmt.args.length < min || stmt.args.length > max) {
      throw new PrayerAnalyzeError(`command '${stmt.name}' expects ${arityText(min, max)}, got ${stmt.args.length}`, stmt.loc);
    }
    assertPermitted(spec);
    const args = stmt.args.map((arg, index) => analyzeArg(arg, spec.argTypes[index] ?? "any"));
    return { kind: "command", cmd: { spec, args, loc: stmt.loc } };
  }

  function analyzePredicate(pred: AstPredicate): AnalyzedPredicate {
    const metric = pred.metric.toUpperCase();
    if (!PREDICATES.has(metric)) {
      throw new PrayerAnalyzeError(`unknown predicate '${pred.metric}'`, pred.loc, nearestNames(metric, [...PREDICATES]));
    }
    const argTypes = PREDICATE_ARG_TYPES[metric] ?? [];
    return {
      metric: metric as PredicateName,
      args: pred.args.map((arg, index) => analyzeArg(arg, argTypes[index] ?? "any")),
      op: pred.op,
      rhs: pred.rhs,
      loc: pred.loc,
    };
  }

  function analyzeArg(arg: AstArg, type: ArgType): AnalyzedArg {
    if (arg.kind === "int") return { kind: "static", value: arg.value };
    if (arg.kind === "macro") {
      if (arg.name === "here") {
        if (!snapshot.currentSystem) throw new PrayerAnalyzeError("$here cannot resolve because current system is unknown", arg.loc);
        return { kind: "static", value: snapshot.currentSystem };
      }
      return { kind: "dynamic", macro: arg.name };
    }

    if (type === "item") {
      return { kind: "static", value: resolveId(arg.name, snapshot.items, "item", arg.loc, true) };
    }
    if (type === "destination") {
      if (arg.name === "home") return { kind: "dynamic", macro: "home" };
      if (arg.name === "nearest_station") return { kind: "dynamic", macro: "nearest_station" };
      return { kind: "static", value: resolveId(arg.name, snapshot.pois, "destination", arg.loc, true) };
    }
    return { kind: "static", value: arg.name };
  }

  function resolveId(
    raw: string,
    entries: Array<{ id: string; name?: string }>,
    label: string,
    loc: { line: number; col: number },
    allowUnknown = false,
  ): string {
    if (entries.length === 0) return raw;
    const normalizedRaw = normalize(raw);
    const exact = entries.find((entry) => entry.id === raw || normalize(entry.id) === normalizedRaw || normalize(entry.name ?? "") === normalizedRaw);
    if (exact) return exact.id;

    const ranked = entries
      .map((entry) => ({ entry, score: Math.max(similarity(raw, entry.id), similarity(raw, entry.name ?? "")) }))
      .sort((a, b) => b.score - a.score);
    const best = ranked[0];
    if (best && best.score >= snapshot.fuzzyMatchThreshold) {
      warnings.push({ message: `Assuming ${label} '${best.entry.id}' from '${raw}'`, loc });
      return best.entry.id;
    }
    if (allowUnknown) return raw;
    throw new PrayerAnalyzeError(`unknown ${label} '${raw}'`, loc, ranked.slice(0, 3).map((hit) => hit.entry.id));
  }

  function assertPermitted(spec: CommandSpec): void {
    if (!spec.backingTool) return;
    const globalDenied = snapshot.agentDeniedTools["*"] ?? {};
    const agentDenied = snapshot.agentDeniedTools[snapshot.agentName] ?? {};
    if (spec.backingTool in globalDenied || spec.backingTool in agentDenied) {
      throw new PrayerAnalyzeError(`command '${spec.name}' uses denied tool '${spec.backingTool}'`);
    }
  }
}

function arityText(min: number, max: number): string {
  return min === max ? `${min} arg${min === 1 ? "" : "s"}` : `${min}-${max} args`;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function nearestNames(raw: string, names: string[]): string[] {
  return names
    .map((name) => ({ name, score: similarity(raw, name) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((hit) => hit.name);
}

function similarity(a: string, b: string): number {
  const aa = normalize(a);
  const bb = normalize(b);
  if (!aa && !bb) return 1;
  if (!aa || !bb) return 0;
  const distance = levenshtein(aa, bb);
  return 1 - distance / Math.max(aa.length, bb.length);
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = Array.from({ length: b.length + 1 }, () => 0);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}
