import type { RoutineResult } from "../routines/types.js";
import { queryRun, queryAll, getDbIfInitialized } from "./database.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("routine-jobs");

export type RoutineJobStatus = "running" | "completed" | "error";

export interface RoutineJob {
  id: string;
  agentName: string;
  routineId: string;
  traceId: string;
  startedAt: string;
  sequence: number;
  status: RoutineJobStatus;
  durationMs?: number;
  result?: RoutineResult;
  formatted?: string;
  error?: string;
}

export interface RoutineJobSnapshot {
  id: string;
  agent: string;
  routine: string;
  status: RoutineJobStatus;
  started_at: string;
  duration_ms: number;
  trace_id: string;
  result?: {
    status: RoutineResult["status"];
    summary?: string;
    handoff_reason?: string;
  };
  text?: string;
  error?: string;
}

const MAX_ROUTINE_JOBS = 200;

const routineJobs = new Map<string, RoutineJob>();
const latestRoutineJobByAgent = new Map<string, string>();
let nextRoutineJobSequence = 1;

// ---------------------------------------------------------------------------
// SQLite persistence helpers
// ---------------------------------------------------------------------------

function persistJobCreate(job: RoutineJob): void {
  if (!getDbIfInitialized()) return;
  try {
    queryRun(
      `INSERT OR REPLACE INTO routine_jobs
         (id, agent, routine, trace_id, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      job.id, job.agentName, job.routineId, job.traceId, job.status, job.startedAt,
    );
  } catch (err) {
    log.warn("failed to persist routine job create", { id: job.id, error: String(err) });
  }
}

function persistJobFinish(job: RoutineJob): void {
  if (!getDbIfInitialized()) return;
  try {
    const completedAt = new Date().toISOString();
    queryRun(
      `UPDATE routine_jobs
       SET status = ?, completed_at = ?, duration_ms = ?,
           result_status = ?, result_summary = ?, handoff_reason = ?, error = ?
       WHERE id = ?`,
      job.status,
      completedAt,
      job.durationMs ?? null,
      job.result?.status ?? null,
      job.result?.summary ?? null,
      job.result?.handoffReason ?? null,
      job.error ?? null,
      job.id,
    );
  } catch (err) {
    log.warn("failed to persist routine job finish", { id: job.id, error: String(err) });
  }
}

interface RoutineJobRow {
  id: string;
  agent: string;
  routine: string;
  trace_id: string;
  status: string;
  started_at: string;
  duration_ms: number | null;
  result_status: string | null;
  result_summary: string | null;
  handoff_reason: string | null;
  error: string | null;
}

/**
 * Load recent routine jobs from SQLite on startup (fills in-memory map).
 * Call once after DB is initialized.
 */
export function loadRecentRoutineJobs(limit = 50): void {
  if (!getDbIfInitialized()) return;
  try {
    const rows = queryAll<RoutineJobRow>(
      `SELECT id, agent, routine, trace_id, status, started_at,
              duration_ms, result_status, result_summary, handoff_reason, error
       FROM routine_jobs
       ORDER BY started_at DESC
       LIMIT ?`,
      limit,
    );
    for (const row of rows) {
      const job: RoutineJob = {
        id: row.id,
        agentName: row.agent,
        routineId: row.routine,
        traceId: row.trace_id,
        startedAt: row.started_at,
        sequence: nextRoutineJobSequence++,
        status: row.status as RoutineJobStatus,
        durationMs: row.duration_ms ?? undefined,
        result: row.result_status ? {
          status: row.result_status as RoutineResult["status"],
          summary: row.result_summary ?? "",
          data: {},
          phases: [],
          durationMs: row.duration_ms ?? 0,
          ...(row.handoff_reason ? { handoffReason: row.handoff_reason } : {}),
        } : undefined,
        error: row.error ?? undefined,
      };
      routineJobs.set(job.id, job);
      // Track latest per-agent only for completed/error (running rows from a prior process are stale)
      if (job.status !== "running") {
        const existing = latestRoutineJobByAgent.get(job.agentName);
        if (!existing) {
          latestRoutineJobByAgent.set(job.agentName, job.id);
        }
      }
    }
    log.info("loaded routine jobs from DB", { count: rows.length });
  } catch (err) {
    log.warn("failed to load routine jobs from DB", { error: String(err) });
  }
}

/**
 * Query recent routine jobs directly from the database (bypasses in-memory map).
 */
export function getRecentRoutineJobs(limit = 50): RoutineJobSnapshot[] {
  if (!getDbIfInitialized()) return [];
  try {
    const rows = queryAll<RoutineJobRow>(
      `SELECT id, agent, routine, trace_id, status, started_at,
              duration_ms, result_status, result_summary, handoff_reason, error
       FROM routine_jobs
       ORDER BY started_at DESC
       LIMIT ?`,
      limit,
    );
    return rows.map((row) => ({
      id: row.id,
      agent: row.agent,
      routine: row.routine,
      status: row.status as RoutineJobStatus,
      started_at: row.started_at,
      duration_ms: row.duration_ms ?? 0,
      trace_id: row.trace_id,
      result: row.result_status ? {
        status: row.result_status as RoutineResult["status"],
        summary: row.result_summary ?? undefined,
        handoff_reason: row.handoff_reason ?? undefined,
      } : undefined,
      error: row.error ?? undefined,
    }));
  } catch (err) {
    log.warn("getRecentRoutineJobs failed", { error: String(err) });
    return [];
  }
}

// ---------------------------------------------------------------------------
// In-memory map helpers (unchanged interface)
// ---------------------------------------------------------------------------

function pruneRoutineJobs(): void {
  const excess = routineJobs.size - MAX_ROUTINE_JOBS;
  if (excess <= 0) return;

  const oldest = [...routineJobs.values()]
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
    .slice(0, excess);

  for (const job of oldest) {
    routineJobs.delete(job.id);
    if (latestRoutineJobByAgent.get(job.agentName) === job.id) {
      latestRoutineJobByAgent.delete(job.agentName);
    }
  }
}

export function createRoutineJob(input: {
  agentName: string;
  routineId: string;
  traceId: string;
}): RoutineJob {
  const job: RoutineJob = {
    id: `${input.agentName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    agentName: input.agentName,
    routineId: input.routineId,
    traceId: input.traceId,
    startedAt: new Date().toISOString(),
    sequence: nextRoutineJobSequence++,
    status: "running",
  };
  routineJobs.set(job.id, job);
  latestRoutineJobByAgent.set(job.agentName, job.id);
  pruneRoutineJobs();
  persistJobCreate(job);
  return job;
}

export function completeRoutineJob(job: RoutineJob, result: RoutineResult, formatted: string, durationMs: number): void {
  job.status = result.status === "error" ? "error" : "completed";
  job.result = result;
  job.formatted = formatted;
  job.durationMs = durationMs;
  persistJobFinish(job);
}

export function failRoutineJob(job: RoutineJob, error: string, durationMs: number): void {
  job.status = "error";
  job.error = error;
  job.durationMs = durationMs;
  persistJobFinish(job);
}

export function getRoutineJob(id: string): RoutineJob | undefined {
  return routineJobs.get(id);
}

export function getLatestRoutineJobForAgent(agentName: string): RoutineJob | undefined {
  const id = latestRoutineJobByAgent.get(agentName);
  return id ? routineJobs.get(id) : undefined;
}

export function toRoutineJobSnapshot(job: RoutineJob): RoutineJobSnapshot {
  return {
    id: job.id,
    agent: job.agentName,
    routine: job.routineId,
    status: job.status,
    started_at: job.startedAt,
    duration_ms: job.durationMs ?? Date.now() - Date.parse(job.startedAt),
    trace_id: job.traceId,
    result: job.result ? {
      status: job.result.status,
      summary: job.result.summary,
      handoff_reason: job.result.handoffReason,
    } : undefined,
    text: job.formatted,
    error: job.error,
  };
}

export function listRoutineJobs(options: {
  agentName?: string;
  status?: RoutineJobStatus;
  limit?: number;
} = {}): RoutineJobSnapshot[] {
  const limit = Math.max(1, Math.min(options.limit ?? 50, MAX_ROUTINE_JOBS));
  return [...routineJobs.values()]
    .filter((job) => !options.agentName || job.agentName === options.agentName)
    .filter((job) => !options.status || job.status === options.status)
    .sort((a, b) => b.sequence - a.sequence)
    .slice(0, limit)
    .map(toRoutineJobSnapshot);
}

export function clearRoutineJobsForTesting(): void {
  routineJobs.clear();
  latestRoutineJobByAgent.clear();
  nextRoutineJobSequence = 1;
}
