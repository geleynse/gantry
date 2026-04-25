"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, ChevronDown, Clock3, RefreshCw, Route, Search, XCircle } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useAgentNames } from "@/hooks/use-agent-names";
import { formatAbsolute } from "@/lib/time";
import { abbreviateTrace, formatDuration } from "./helpers";

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

// 7-column grid: Started | Agent | Trace | Routine | Summary | Status | Duration.
// Hard-coded literal class strings so Tailwind's JIT scanner picks them up.
const GRID_HEADER_CLASSES = "grid-cols-[140px_130px_90px_140px_1fr_110px_100px]";
const GRID_ROW_CLASSES = "lg:grid-cols-[140px_130px_90px_140px_1fr_110px_100px]";

/**
 * Routine start times are full absolute timestamps (matches every other
 * table on the dashboard via the shared helper).
 */
const formatStartedAt = formatAbsolute;

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

/**
 * Summary cell with an expand affordance.
 *
 * Renders truncated text (up to ~3 lines via line-clamp). When the rendered
 * text overflows we expose a chevron the operator can click to toggle the
 * full multi-line text. Avoids native `title` on long text — multi-paragraph
 * summaries don't render well in a tooltip.
 */
function SummaryCell({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const ref = useRef<HTMLParagraphElement | null>(null);

  // Detect whether the rendered text actually overflows. Re-runs whenever
  // the text changes; the resize/scrollHeight check is cheap.
  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    setTruncated(el.scrollHeight - el.clientHeight > 1);
  }, [text]);

  if (!text) {
    return <span className="text-xs text-muted-foreground/40">—</span>;
  }

  return (
    <div className="flex items-start gap-1.5">
      <p
        ref={ref}
        className={cn(
          "text-sm text-muted-foreground flex-1 min-w-0",
          !expanded && "line-clamp-2"
        )}
      >
        {text}
      </p>
      {(truncated || expanded) && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
          title={expanded ? "Collapse" : "Expand summary"}
          aria-label={expanded ? "Collapse summary" : "Expand summary"}
        >
          <ChevronDown
            className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")}
          />
        </button>
      )}
    </div>
  );
}

/** Trace ID cell. Shows abbreviated form; full ID surfaced on hover via
 *  native `title` (always small, single-line — title tooltip is fine here). */
function TraceCell({ traceId }: { traceId: string }) {
  if (!traceId) {
    return <span className="font-mono text-xs text-muted-foreground/40">—</span>;
  }
  return (
    <span
      className="font-mono text-xs text-muted-foreground cursor-help"
      title={traceId}
    >
      {abbreviateTrace(traceId)}
    </span>
  );
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
          <div
            className={cn(
              "grid gap-3 border-b border-border bg-muted/30 px-4 py-2 text-xs uppercase tracking-wider text-muted-foreground max-lg:hidden",
              GRID_HEADER_CLASSES
            )}
          >
            <div>Started</div>
            <div>Agent</div>
            <div>Trace</div>
            <div>Routine</div>
            <div>Summary</div>
            <div>Status</div>
            <div className="text-right">Duration</div>
          </div>

          {loading && visibleJobs.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">Loading routine jobs...</div>
          ) : visibleJobs.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">No routine jobs match the current filters.</div>
          ) : (
            <div className="divide-y divide-border">
              {visibleJobs.map((job) => {
                const summaryText = job.error ?? job.result?.summary ?? job.text ?? "";
                return (
                  <article
                    key={job.id}
                    className={cn(
                      "grid gap-3 px-4 py-4 lg:items-start",
                      GRID_ROW_CLASSES
                    )}
                  >
                    <div className="font-mono text-xs text-muted-foreground">
                      {formatStartedAt(job.started_at)}
                    </div>
                    <div className="min-w-0 font-mono text-sm text-foreground">{job.agent}</div>
                    <div className="min-w-0">
                      <TraceCell traceId={job.trace_id} />
                    </div>
                    <div className="min-w-0 font-medium text-foreground truncate" title={job.routine}>
                      {job.routine}
                    </div>
                    <div className="min-w-0">
                      <SummaryCell text={summaryText} />
                    </div>
                    <div>
                      <span
                        className={cn(
                          "inline-flex items-center gap-1.5 border px-2 py-1 text-xs capitalize",
                          statusClasses(job.status),
                        )}
                      >
                        <StatusIcon status={job.status} />
                        {job.status}
                      </span>
                    </div>
                    <div className="font-mono text-sm text-muted-foreground lg:text-right">
                      {formatDuration(job.duration_ms)}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
