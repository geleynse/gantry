"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Clock3, RefreshCw, Route, Search, XCircle } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useAgentNames } from "@/hooks/use-agent-names";

type RoutineJobStatus = "running" | "completed" | "error";

interface RoutineJob {
  id: string;
  agent: string;
  routine: string;
  status: RoutineJobStatus;
  started_at: string;
  duration_ms: number;
  trace_id: string;
  result?: {
    status: string;
    summary?: string;
    handoff_reason?: string;
  };
  text?: string;
  error?: string;
}

interface RoutineJobsResponse {
  jobs: RoutineJob[];
}

const STATUS_OPTIONS: Array<"all" | RoutineJobStatus> = ["all", "running", "completed", "error"];
const STATUS_CARD_OPTIONS: RoutineJobStatus[] = ["running", "completed", "error"];

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

function formatStartedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function statusClasses(status: RoutineJobStatus): string {
  if (status === "running") return "border-warning/30 bg-warning/10 text-warning";
  if (status === "completed") return "border-success/30 bg-success/10 text-success";
  return "border-destructive/30 bg-destructive/10 text-destructive";
}

function StatusIcon({ status }: { status: RoutineJobStatus }) {
  if (status === "running") return <Clock3 className="h-4 w-4" />;
  if (status === "completed") return <CheckCircle2 className="h-4 w-4" />;
  return <XCircle className="h-4 w-4" />;
}

export default function RoutinesPage() {
  const agentNames = useAgentNames();
  const [jobs, setJobs] = useState<RoutineJob[]>([]);
  const [agent, setAgent] = useState("all");
  const [status, setStatus] = useState<"all" | RoutineJobStatus>("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadJobs() {
    setError(null);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (agent !== "all") params.set("agent", agent);
      if (status !== "all") params.set("status", status);
      const data = await apiFetch<RoutineJobsResponse>(`/routines/jobs?${params.toString()}`);
      setJobs(data.jobs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    loadJobs();
    const timer = setInterval(loadJobs, 5000);
    return () => clearInterval(timer);
  }, [agent, status]);

  const visibleJobs = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return jobs;
    return jobs.filter((job) => {
      return [
        job.agent,
        job.routine,
        job.status,
        job.trace_id,
        job.id,
        job.result?.summary,
        job.error,
      ].some((value) => value?.toLowerCase().includes(needle));
    });
  }, [jobs, query]);

  const counts = useMemo(() => {
    return jobs.reduce(
      (acc, job) => {
        acc[job.status] += 1;
        return acc;
      },
      { running: 0, completed: 0, error: 0 } as Record<RoutineJobStatus, number>,
    );
  }, [jobs]);

  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 lg:px-8">
        <header className="flex flex-col gap-4 border-b border-border pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm uppercase tracking-wider text-muted-foreground">
              <Route className="h-4 w-4" />
              Routine Jobs
            </div>
            <h1 className="mt-2 text-2xl font-semibold text-foreground">Async Routine History</h1>
          </div>
          <button
            onClick={loadJobs}
            className="inline-flex h-9 items-center gap-2 border border-border px-3 text-sm text-foreground transition-colors hover:bg-secondary disabled:opacity-50"
            disabled={loading}
            title="Refresh routine jobs"
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            Refresh
          </button>
        </header>

        <section className="grid gap-3 sm:grid-cols-3">
          {STATUS_CARD_OPTIONS.map((option) => (
            <button
              key={option}
              onClick={() => setStatus(option === status ? "all" : option)}
              className={cn(
                "flex items-center justify-between border px-4 py-3 text-left transition-colors hover:bg-secondary/60",
                status === option ? statusClasses(option) : "border-border bg-card text-foreground",
              )}
            >
              <span className="inline-flex items-center gap-2 text-sm font-medium capitalize">
                <StatusIcon status={option} />
                {option}
              </span>
              <span className="font-mono text-lg">{counts[option]}</span>
            </button>
          ))}
        </section>

        <section className="flex flex-col gap-3 border-b border-border pb-4 lg:flex-row lg:items-center">
          <label className="flex min-w-0 flex-1 items-center gap-2 border border-border bg-card px-3 py-2">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search agent, routine, trace, summary"
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
          </label>
          <select
            value={agent}
            onChange={(event) => setAgent(event.target.value)}
            className="h-10 border border-border bg-card px-3 text-sm text-foreground outline-none"
          >
            <option value="all">All agents</option>
            {agentNames.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as "all" | RoutineJobStatus)}
            className="h-10 border border-border bg-card px-3 text-sm text-foreground outline-none"
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option} value={option}>{option === "all" ? "All statuses" : option}</option>
            ))}
          </select>
        </section>

        {error && (
          <div className="flex items-center gap-2 border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        )}

        <section className="overflow-hidden border border-border">
          <div className="grid grid-cols-[140px_150px_1fr_120px_120px] gap-3 border-b border-border bg-muted/30 px-4 py-2 text-xs uppercase tracking-wider text-muted-foreground max-lg:hidden">
            <div>Started</div>
            <div>Agent</div>
            <div>Routine</div>
            <div>Status</div>
            <div className="text-right">Duration</div>
          </div>

          {loading && visibleJobs.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">Loading routine jobs...</div>
          ) : visibleJobs.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">No routine jobs match the current filters.</div>
          ) : (
            <div className="divide-y divide-border">
              {visibleJobs.map((job) => (
                <article key={job.id} className="grid gap-3 px-4 py-4 lg:grid-cols-[140px_150px_1fr_120px_120px] lg:items-start">
                  <div className="font-mono text-xs text-muted-foreground">{formatStartedAt(job.started_at)}</div>
                  <div className="min-w-0 font-mono text-sm text-foreground">{job.agent}</div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">{job.routine}</span>
                      <span className="font-mono text-xs text-muted-foreground">{job.trace_id}</span>
                    </div>
                    {(job.result?.summary || job.error || job.text) && (
                      <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                        {job.error ?? job.result?.summary ?? job.text}
                      </p>
                    )}
                  </div>
                  <div>
                    <span className={cn("inline-flex items-center gap-1.5 border px-2 py-1 text-xs capitalize", statusClasses(job.status))}>
                      <StatusIcon status={job.status} />
                      {job.status}
                    </span>
                  </div>
                  <div className="font-mono text-sm text-muted-foreground lg:text-right">{formatDuration(job.duration_ms)}</div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
