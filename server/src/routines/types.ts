/**
 * Deterministic Routine Library — Core Types
 *
 * Routines are scripted state machines that execute sequences of game actions
 * without LLM inference. They reduce cost by ~80% for repetitive tasks.
 *
 * Implemented — Phase 1
 */

// ---------------------------------------------------------------------------
// Routine phases & results
// ---------------------------------------------------------------------------

/** A phase in a routine's execution. */
export interface RoutinePhase {
  name: string;
  startedAt: number;
  completedAt?: number;
  result?: unknown;
  error?: string;
}

/** Final result of a routine execution. */
export interface RoutineResult {
  status: "completed" | "handoff" | "error";
  /** Human-readable summary for LLM consumption. */
  summary: string;
  /** Structured output data. */
  data: Record<string, unknown>;
  /** Set when status === "handoff" — reason the LLM needs to take over. */
  handoffReason?: string;
  /** Phases executed during this routine run. */
  phases: RoutinePhase[];
  /** Total duration in ms. */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Routine context — injected into every routine
// ---------------------------------------------------------------------------

/** Thin MCP tool client that talks directly to the game via the gantry proxy. */
export interface RoutineToolClient {
  /** Execute a game tool and return its result. */
  execute(
    tool: string,
    args?: Record<string, unknown>,
    opts?: { timeoutMs?: number; noRetry?: boolean },
  ): Promise<{ result?: unknown; error?: unknown }>;
  /** Wait for the next game tick (typically ~2-3s). */
  waitForTick(ms?: number): Promise<void>;
}

/** Context provided to routines at execution time. */
export interface RoutineContext {
  /** Agent name (e.g. "my-agent"). */
  agentName: string;
  /** Tool client for executing game actions. */
  client: RoutineToolClient;
  /** Per-agent game state cache. */
  statusCache: Map<string, { data: Record<string, unknown>; fetchedAt: number }>;
  /** Log a message during routine execution. */
  log: (level: "info" | "warn" | "error" | "debug", msg: string, data?: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// Routine definition
// ---------------------------------------------------------------------------

/** A routine that can be dispatched by the proxy. */
export interface RoutineDefinition<TParams = Record<string, unknown>> {
  /** Unique routine name (e.g. "sell_cycle"). */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Validate and parse params. Returns parsed params or throws. */
  parseParams(raw: unknown): TParams;
  /** Execute the routine. */
  run(ctx: RoutineContext, params: TParams): Promise<RoutineResult>;
}
