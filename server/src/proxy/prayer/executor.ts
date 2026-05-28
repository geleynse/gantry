import { evalPredicate, resolveArg } from "./predicates.js";
import { diffSnapshots, resultFromError, snapshotDiff } from "./result.js";
import { cargoByItem } from "./state.js";
import { createLogger } from "../../lib/logger.js";
import {
  PrayerRuntimeError,
  type AnalyzedCommand,
  type AnalyzedProgram,
  type AnalyzedStmt,
  type ExecState,
  type ExecutorDeps,
  type PrayResult,
} from "./types.js";

const log = createLogger("prayer-executor");

const INTERRUPT_EVENTS = [
  "pirate_warning",
  "pirate_combat",
  "combat_update",
  "player_died",
  "respawn_state",
  "police_warning",
  "scan_detected",
];

export async function executePrayerProgram(program: AnalyzedProgram, deps: ExecutorDeps): Promise<PrayResult> {
  const startedAt = Date.now();
  const beforeData = deps.statusCache.get(deps.agentName)?.data ?? {};
  const before = snapshotDiff(beforeData);
  const state: ExecState = deps.initialState
    ? { ...deps.initialState, startedAt }  // Reset wall-clock on resume so stale checkpoint age doesn't exhaust the budget immediately.
    : {
        stepsExecuted: 0,
        startedAt,
        transientRetriesUsed: 0,
        log: [],
        cargoBaseline: cargoByItem(beforeData),
        haltRequested: false,
        interrupt: null,
      };

  try {
    await runBlock(program.statements, state, deps);
    const after = snapshotDiff(deps.statusCache.get(deps.agentName)?.data ?? beforeData);
    return {
      status: state.haltRequested ? "halted" : "completed",
      steps_executed: state.stepsExecuted,
      normalized_script: program.source,
      warnings: program.warnings.map((w) => w.message),
      diff: diffSnapshots(before, after),
      subcalls: state.log.map((entry) => ({ tool: entry.tool, ok: entry.ok, duration_ms: entry.durationMs })),
      duration_ms: Date.now() - startedAt,
    };
  } catch (err) {
    const after = snapshotDiff(deps.statusCache.get(deps.agentName)?.data ?? beforeData);
    return resultFromError(err, program, state, startedAt, diffSnapshots(before, after));
  }
}

async function runBlock(stmts: AnalyzedStmt[], state: ExecState, deps: ExecutorDeps): Promise<void> {
  for (const stmt of stmts) {
    checkLimits(state, deps);
    checkInterrupts(state, deps);
    if (state.haltRequested) return;

    if (stmt.kind === "command") {
      await executeCommand(stmt.cmd, state, deps);
      state.stepsExecuted++;
      tryCheckpoint(state, deps);
      continue;
    }

    if (stmt.kind === "if") {
      if (await evalPredicate(stmt.cond, state, deps)) {
        await runBlock(stmt.body, state, deps);
      }
      continue;
    }

    let iters = 0;
    while (!(await evalPredicate(stmt.cond, state, deps))) {
      if (iters++ >= deps.maxLoopIters) {
        throw new PrayerRuntimeError("loop_limit_exceeded", "Prayer until loop exceeded max iterations", stmt.loc);
      }
      await runBlock(stmt.body, state, deps);
      checkLimits(state, deps);
      checkInterrupts(state, deps);
      if (state.haltRequested) return;
    }
  }
}

async function executeCommand(cmd: AnalyzedCommand, state: ExecState, deps: ExecutorDeps): Promise<void> {
  const backingTool = cmd.spec.backingTool;
  if (backingTool) {
    const denial = deps.isToolDenied?.(backingTool);
    if (denial) throw new PrayerRuntimeError("denied_at_execute", `Tool '${backingTool}' is denied: ${denial}`, cmd.loc);
  }

  const args = cmd.args.map((arg) => resolveArg(arg, deps));
  const disp = cmd.spec.dispatcher;
  if (disp.kind === "native") {
    try {
      await disp.handler(args, state, deps);
    } catch (err) {
      if (err instanceof PrayerRuntimeError && err.code.startsWith("skip_")) return;
      throw err;
    }
    return;
  }

  const toolName = disp.tool;
  const argCtx = { agentName: deps.agentName, statusCache: deps.statusCache };
  let attempts = 0;
  for (;;) {
    const started = Date.now();
    try {
      const mapped = await disp.argMapper(args, argCtx);
      const result = disp.kind === "compound"
        ? await deps.compoundActions[disp.tool](deps.client, deps.agentName, mapped ?? {})
        : await deps.handlePassthrough(disp.tool, mapped);
      const durationMs = Date.now() - started;
      const classification = classifyResult(result);
      state.log.push({ tool: toolName, args: mapped, result, durationMs, ok: classification !== "fatal" });
      deps.logSubTool?.(`pray:${toolName}`, mapped, result, durationMs);
      if (classification === "skip" || classification === "ok") return;
      if (classification === "transient" && attempts < 3 && state.transientRetriesUsed < 20) {
        attempts++;
        state.transientRetriesUsed++;
        await deps.client.waitForTick();
        continue;
      }
      throw new PrayerRuntimeError("tool_fatal", `${toolName} failed: ${JSON.stringify(result)}`, cmd.loc);
    } catch (err) {
      if (err instanceof PrayerRuntimeError && err.code.startsWith("skip_")) return;
      throw err;
    }
  }
}

function classifyResult(result: unknown): "ok" | "skip" | "transient" | "fatal" {
  if (!result || typeof result !== "object") return "ok";
  const obj = result as Record<string, unknown>;
  const error = obj.error;
  const stopped = String(obj.stopped_reason ?? "");
  const status = String(obj.status ?? "");

  if (stopped === "cargo_full" || stopped === "depleted") return "skip";
  if (status === "no_wrecks" || status === "not_in_battle") return "skip";
  if (stopped === "shutdown_signal") return "fatal";
  if (!error && status !== "error" && stopped !== "error") return "ok";

  const text = JSON.stringify(error ?? obj).toLowerCase();
  if (text.includes("rate_limited") || text.includes("429") || text.includes("pending") || text.includes("busy") || text.includes("try again")) {
    return "transient";
  }
  if (text.includes("not in cargo") || text.includes("no ") || text.includes("nothing")) return "skip";
  return "fatal";
}

function tryCheckpoint(state: ExecState, deps: ExecutorDeps): void {
  if (!deps.onCheckpoint) return;
  try {
    deps.onCheckpoint(state);
  } catch {
    // best-effort — never let checkpointing crash a prayer
  }
}

function checkLimits(state: ExecState, deps: ExecutorDeps): void {
  if (state.stepsExecuted >= deps.maxSteps) {
    throw new PrayerRuntimeError("step_limit_reached", "Prayer script reached max_steps");
  }
  if (Date.now() - state.startedAt > deps.maxWallClockMs) {
    log.warn("prayer wall-clock exceeded", {
      agent: deps.agentName,
      budget_ms: deps.maxWallClockMs,
      elapsed_ms: Date.now() - state.startedAt,
      steps_executed: state.stepsExecuted,
      transient_retries: state.transientRetriesUsed,
      last_subtools: state.log.slice(-5).map(e => ({
        tool: e.tool,
        ok: e.ok,
        duration_ms: e.durationMs,
      })),
    });
    throw new PrayerRuntimeError("wall_clock_exceeded", "Prayer script exceeded wall-clock limit");
  }
}

function checkInterrupts(state: ExecState, deps: ExecutorDeps): void {
  if (deps.battleCache?.get(deps.agentName)) {
    state.interrupt = { reason: "combat_started" };
    throw new PrayerRuntimeError("interrupted", "combat_started");
  }
  const buf = deps.eventBuffers?.get(deps.agentName);
  const detected = INTERRUPT_EVENTS.find((event) => buf?.hasEventOfType([event]));
  if (detected) {
    state.interrupt = { reason: detected };
    throw new PrayerRuntimeError("interrupted", detected);
  }
}
