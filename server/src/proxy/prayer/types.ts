import type { GameClientLike } from "../compound-tools/index.js";

export interface SourceLoc {
  line: number;
  col: number;
}

export type MacroName = "here" | "home" | "nearest_station";

export type AstArg =
  | { kind: "ident"; name: string; loc: SourceLoc }
  | { kind: "macro"; name: MacroName; loc: SourceLoc }
  | { kind: "int"; value: number; loc: SourceLoc };

export type CompareOp = ">" | ">=" | "<" | "<=" | "==" | "!=";

export interface AstPredicate {
  metric: string;
  args: AstArg[];
  op: CompareOp;
  rhs: number;
  loc: SourceLoc;
}

export type AstStmt =
  | { kind: "command"; name: string; args: AstArg[]; loc: SourceLoc }
  | { kind: "if"; cond: AstPredicate; body: AstStmt[]; loc: SourceLoc }
  | { kind: "until"; cond: AstPredicate; body: AstStmt[]; loc: SourceLoc };

export interface AstProgram {
  statements: AstStmt[];
  source: string;
}

export type ArgType = "item" | "destination" | "integer" | "any";

export type ResolvedArg = string | number;

export interface ArgMapperContext {
  agentName: string;
  statusCache: Map<string, { data: Record<string, unknown>; fetchedAt: number }>;
}

export type Dispatcher =
  | { kind: "compound"; tool: string; argMapper: (args: ResolvedArg[], ctx: ArgMapperContext) => Promise<Record<string, unknown>> | Record<string, unknown> }
  | { kind: "passthrough"; tool: string; argMapper: (args: ResolvedArg[], ctx: ArgMapperContext) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined }
  | { kind: "native"; handler: (args: ResolvedArg[], state: ExecState, deps: ExecutorDeps) => Promise<void> };

export interface CommandSpec {
  name: string;
  backingTool: string | null;
  arity: [min: number, max: number];
  argTypes: ArgType[];
  dispatcher: Dispatcher;
}

export type AnalyzedArg =
  | { kind: "static"; value: string | number }
  | { kind: "dynamic"; macro: "home" | "nearest_station" };

export interface AnalyzedCommand {
  spec: CommandSpec;
  args: AnalyzedArg[];
  loc: SourceLoc;
}

export type PredicateName = "FUEL" | "CREDITS" | "CARGO_PCT" | "CARGO" | "MINED" | "STASHED" | "STASH" | "MISSION_ACTIVE";

export interface AnalyzedPredicate {
  metric: PredicateName;
  args: AnalyzedArg[];
  op: CompareOp;
  rhs: number;
  loc: SourceLoc;
}

export type AnalyzedStmt =
  | { kind: "command"; cmd: AnalyzedCommand }
  | { kind: "if"; cond: AnalyzedPredicate; body: AnalyzedStmt[]; loc: SourceLoc }
  | { kind: "until"; cond: AnalyzedPredicate; body: AnalyzedStmt[]; loc: SourceLoc };

export interface AnalyzerWarning {
  message: string;
  loc?: SourceLoc;
}

export interface AnalyzerSnapshot {
  agentName: string;
  currentSystem: string | null;
  currentPoi: string | null;
  items: Array<{ id: string; name?: string }>;
  pois: Array<{ id: string; name?: string; type?: string; system_id?: string }>;
  agentDeniedTools: Record<string, Record<string, string>>;
  fuzzyMatchThreshold: number;
}

export interface AnalyzedProgram {
  statements: AnalyzedStmt[];
  warnings: AnalyzerWarning[];
  maxStepsHint: number | null;
  source: string;
}

export interface SubToolCall {
  tool: string;
  args: unknown;
  result: unknown;
  durationMs: number;
  ok: boolean;
}

export interface ExecState {
  stepsExecuted: number;
  startedAt: number;
  transientRetriesUsed: number;
  log: SubToolCall[];
  cargoBaseline: Map<string, number>;
  haltRequested: boolean;
  interrupt: { reason: string } | null;
}

export interface ExecutorDeps {
  agentName: string;
  client: GameClientLike;
  compoundActions: Record<string, (client: GameClientLike, agentName: string, args: Record<string, unknown>) => Promise<unknown>>;
  statusCache: Map<string, { data: Record<string, unknown>; fetchedAt: number }>;
  battleCache?: Map<string, unknown>;
  eventBuffers?: Map<string, { hasEventOfType(types: string[]): boolean }>;
  handlePassthrough: (tool: string, args?: Record<string, unknown>) => Promise<unknown>;
  isToolDenied?: (backingTool: string) => string | null;
  logSubTool?: (tool: string, args: unknown, result: unknown, durationMs: number) => void;
  maxSteps: number;
  maxLoopIters: number;
  maxWallClockMs: number;
  /**
   * Optional callback invoked on each step boundary with the current state.
   * Used for checkpoint/resume — best-effort, errors swallowed by caller.
   */
  onCheckpoint?: (state: ExecState) => void;
  /**
   * Optional pre-built ExecState to resume from (e.g. loaded from a
   * checkpoint). When provided, the executor uses this instead of building
   * a fresh state at the start of the run.
   */
  initialState?: ExecState;
}

export interface PrayDiff {
  credits?: { before: number; after: number; delta: number };
  fuel?: { before: number; after: number; delta: number };
  cargo?: Array<{ item: string; before: number; after: number; delta: number }>;
  flags?: { docked_before?: boolean; docked_after?: boolean };
}

export interface PrayResult {
  status: "completed" | "halted" | "step_limit_reached" | "interrupted" | "error";
  steps_executed: number;
  normalized_script: string;
  warnings?: string[];
  diff?: PrayDiff;
  handoff_reason?: string;
  error?: {
    tier: "parse" | "analyze" | "runtime";
    code?: string;
    message: string;
    line?: number;
    col?: number;
    suggestions?: string[];
  };
  subcalls?: Array<{ tool: string; ok: boolean; duration_ms: number }>;
  duration_ms: number;
}

export class PrayerParseError extends Error {
  readonly tier = "parse" as const;
  constructor(message: string, readonly loc: SourceLoc) {
    super(message);
  }
}

export class PrayerAnalyzeError extends Error {
  readonly tier = "analyze" as const;
  constructor(message: string, readonly loc?: SourceLoc, readonly suggestions?: string[]) {
    super(message);
  }
}

export class PrayerRuntimeError extends Error {
  readonly tier = "runtime" as const;
  constructor(readonly code: string, message: string, readonly loc?: SourceLoc) {
    super(message);
  }
}
