"use client";

import { useState } from "react";
import {
  Eye,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Zap,
  AlertTriangle,
  AlertCircle,
  CheckCircle,
  MinusCircle,
  Clock,
  Brain,
  Activity,
  Play,
  Square,
  RotateCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { relativeTime } from "@/lib/utils";
import { apiFetch } from "@/lib/api";
import { useOverseerStatus, useOverseerDecisions } from "@/hooks/use-overseer";
import { useFleetStatus } from "@/hooks/use-fleet-status";
import { useAuth } from "@/hooks/use-auth";
import type { OverseerDecision, OverseerAction, ActionResult } from "@/shared/types/overseer";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJsonSafe<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

function formatCost(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

type DecisionStatus = "success" | "error" | "no_action";

function StatusBadge({ status }: { status: DecisionStatus }) {
  if (status === "success") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono font-semibold uppercase tracking-wider bg-success/10 border border-success/30 text-success">
        <CheckCircle className="w-2.5 h-2.5" />
        success
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono font-semibold uppercase tracking-wider bg-error/10 border border-error/30 text-error">
        <AlertTriangle className="w-2.5 h-2.5" />
        error
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono font-semibold uppercase tracking-wider bg-muted/10 border border-border text-muted-foreground">
      <MinusCircle className="w-2.5 h-2.5" />
      no action
    </span>
  );
}

// ---------------------------------------------------------------------------
// Action type badge
// ---------------------------------------------------------------------------

const ACTION_TYPE_COLORS: Record<string, string> = {
  issue_order: "bg-primary/10 border-primary/30 text-primary",
  trigger_routine: "bg-blue-500/10 border-blue-500/30 text-blue-400",
  start_agent: "bg-success/10 border-success/30 text-success",
  stop_agent: "bg-error/10 border-error/30 text-error",
  reassign_role: "bg-warning/10 border-warning/30 text-warning",
  no_action: "bg-muted/10 border-border text-muted-foreground",
};

function ActionTypeBadge({ type }: { type: string }) {
  const colorClass = ACTION_TYPE_COLORS[type] ?? "bg-muted/10 border-border text-muted-foreground";
  return (
    <span
      className={cn(
        "inline-block px-1.5 py-0.5 text-[9px] font-mono font-semibold uppercase tracking-wider border",
        colorClass
      )}
    >
      {type.replace(/_/g, " ")}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Actions list
// ---------------------------------------------------------------------------

function ActionsList({ actionsJson }: { actionsJson: string }) {
  const raw = parseJsonSafe<unknown>(actionsJson, null);

  // Handle both formats: array of strings (actual) or array of OverseerAction objects (typed)
  const items: Array<{ type?: string; params?: Record<string, unknown>; text?: string }> = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string") {
        items.push({ text: item });
      } else if (item && typeof item === "object") {
        items.push(item as { type?: string; params?: Record<string, unknown> });
      }
    }
  }

  if (!items.length) {
    return <p className="text-xs text-muted-foreground italic">No actions recorded.</p>;
  }

  return (
    <div className="space-y-1">
      {items.map((item, i) => (
        <div key={i} className="border border-border/50 bg-background/50 px-2 py-1.5">
          {item.text ? (
            <p className="text-xs text-foreground font-mono">{item.text}</p>
          ) : (
            <>
              <ActionTypeBadge type={item.type ?? "no_action"} />
              {item.params && Object.keys(item.params).length > 0 && (
                <div className="pl-1 mt-1 space-y-0.5">
                  {Object.entries(item.params).map(([k, v]) => (
                    <div key={k} className="flex items-baseline gap-1 text-[10px]">
                      <span className="text-muted-foreground font-mono">{k}:</span>
                      <span className="text-foreground font-mono">
                        {typeof v === "object" ? JSON.stringify(v) : String(v)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Results list
// ---------------------------------------------------------------------------

function ResultsList({ resultsJson }: { resultsJson: string }) {
  const raw = parseJsonSafe<unknown>(resultsJson, null);

  // Handle both formats: structured ActionResult[] or a reasoning object/string
  if (!raw) {
    return <p className="text-xs text-muted-foreground italic">No results recorded.</p>;
  }

  // If it's an object with a "reasoning" field (actual format), show it directly
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const reasoning = obj.reasoning ? String(obj.reasoning) : null;
    const actions = Array.isArray(obj.actions) ? (obj.actions as Array<Record<string, unknown>>) : [];
    return (
      <div className="space-y-2">
        {reasoning && (
          <div className="border border-border/50 bg-background/50 p-2">
            <p className="text-xs text-foreground font-mono whitespace-pre-wrap">
              {reasoning}
            </p>
          </div>
        )}
        {actions.length > 0 && (
          <div className="space-y-1">
            {actions.map((a, i) => (
              <div key={i} className="border border-border/50 bg-background/50 px-2 py-1.5">
                <p className="text-xs text-foreground font-mono">
                  {a.type ? String(a.type) : ""}{a.target ? ` → ${a.target}` : ""}{a.reason ? ` (${a.reason})` : ""}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Array format (typed ActionResult[])
  if (Array.isArray(raw) && raw.length > 0) {
    return (
      <div className="space-y-2">
        {(raw as ActionResult[]).map((result, i) => (
          <div
            key={i}
            className={cn(
              "border p-2 space-y-1",
              result?.success
                ? "border-success/20 bg-success/5"
                : "border-error/20 bg-error/5"
            )}
          >
            <div className="flex items-center gap-2">
              <ActionTypeBadge type={result?.action?.type ?? "no_action"} />
              <span className={cn("text-[10px] font-mono font-semibold", result?.success ? "text-success" : "text-error")}>
                {result?.success ? "✓" : "✗"}
              </span>
            </div>
            {result?.message && (
              <p className="text-[10px] text-muted-foreground font-mono pl-1">{result.message}</p>
            )}
          </div>
        ))}
      </div>
    );
  }

  return <p className="text-xs text-muted-foreground italic">No results recorded.</p>;
}

// ---------------------------------------------------------------------------
// Decision card
// ---------------------------------------------------------------------------

function DecisionCard({ decision }: { decision: OverseerDecision }) {
  const [expanded, setExpanded] = useState(false);
  const [snapshotOpen, setSnapshotOpen] = useState(false);

  // A tick is pending if duration_ms hasn't been populated yet (still running).
  // Treat very old (>10 min) null-duration rows as stale/unknown instead of running,
  // to catch writer bugs that would otherwise spin forever.
  const createdAtTime = new Date(decision.created_at).getTime();
  const ageMs = Date.now() - createdAtTime;
  const isStale = decision.duration_ms == null && ageMs > 10 * 60 * 1000; // >10 min old
  const isPending = decision.duration_ms == null && !isStale;

  const hasActions =
    decision.actions_json &&
    decision.actions_json !== "[]" &&
    decision.actions_json !== "null";
  const hasResults =
    decision.results_json &&
    decision.results_json !== "[]" &&
    decision.results_json !== "null";

  return (
    <div className={cn(
      "border border-border bg-card transition-colors",
      decision.status === "error" && "border-error/20",
      decision.status === "success" && hasActions && "border-primary/10",
      isPending && "border-primary/30"
    )}>
      {/* Header row — always visible */}
      <button
        onClick={() => setExpanded((o) => !o)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-secondary/30 transition-colors"
      >
        <span className="text-muted-foreground/60">
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
        </span>

        {/* Tick number */}
        <span className="font-mono text-xs text-primary font-semibold shrink-0 w-16">
          tick #{decision.tick_number}
        </span>

        {/* Status badge — show spinner when pending */}
        {isPending ? (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono font-semibold uppercase tracking-wider bg-primary/10 border border-primary/30 text-primary">
            <RefreshCw className="w-2.5 h-2.5 animate-spin" />
            running
          </span>
        ) : isStale ? (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono font-semibold uppercase tracking-wider bg-muted/20 border border-muted/30 text-muted-foreground">
            <AlertCircle className="w-2.5 h-2.5" />
            stale
          </span>
        ) : (
          <StatusBadge status={decision.status} />
        )}

        {/* Triggered by */}
        <span className="flex-1 text-xs text-muted-foreground font-mono truncate">
          {decision.triggered_by}
        </span>

        {/* Metadata */}
        <div className="hidden sm:flex items-center gap-3 shrink-0 text-[10px] text-muted-foreground font-mono">
          {decision.model && (
            <span className="flex items-center gap-1">
              <Brain className="w-3 h-3" />
              {decision.model}
            </span>
          )}
          {isPending ? (
            <span className="flex items-center gap-1 text-primary/70 animate-pulse">
              <Clock className="w-3 h-3" />
              in progress
            </span>
          ) : (
            <>
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {formatDuration(decision.duration_ms)}
              </span>
              <span>{formatCost(decision.cost_estimate)}</span>
            </>
          )}
        </div>

        {/* Timestamp */}
        <span
          className="shrink-0 text-[10px] text-muted-foreground/60 font-mono"
          title={new Date(decision.created_at).toLocaleString()}
        >
          {relativeTime(decision.created_at)}
        </span>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-border/50 px-4 py-3 space-y-4">
          {/* Metadata row */}
          <div className="flex flex-wrap gap-4 text-[10px] font-mono text-muted-foreground border-b border-border/30 pb-3">
            <div>
              <span className="text-muted-foreground/60">model </span>
              <span className="text-foreground">{decision.model || "—"}</span>
            </div>
            <div>
              <span className="text-muted-foreground/60">tokens in </span>
              <span className="text-foreground">{formatTokens(decision.input_tokens)}</span>
            </div>
            <div>
              <span className="text-muted-foreground/60">tokens out </span>
              <span className="text-foreground">{formatTokens(decision.output_tokens)}</span>
            </div>
            <div>
              <span className="text-muted-foreground/60">cost </span>
              {isPending ? (
                <span className="text-primary/70 animate-pulse">pending</span>
              ) : isStale ? (
                <span className="text-muted-foreground">{formatCost(decision.cost_estimate) ?? "unknown"}</span>
              ) : (
                <span className="text-foreground">{formatCost(decision.cost_estimate)}</span>
              )}
            </div>
            <div>
              <span className="text-muted-foreground/60">duration </span>
              {isPending ? (
                <span className="text-primary/70 animate-pulse">pending</span>
              ) : isStale ? (
                <span className="text-muted-foreground">unknown</span>
              ) : (
                <span className="text-foreground">{formatDuration(decision.duration_ms)}</span>
              )}
            </div>
            <div>
              <span className="text-muted-foreground/60">at </span>
              <span className="text-foreground">
                {new Date(decision.created_at).toLocaleString()}
              </span>
            </div>
          </div>

          {/* Actions */}
          {hasActions && (
            <div className="space-y-2">
              <h3 className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/70 flex items-center gap-1.5">
                <Zap className="w-3 h-3" />
                Actions
              </h3>
              <ActionsList actionsJson={decision.actions_json} />
            </div>
          )}

          {/* Results */}
          {hasResults && (
            <div className="space-y-2">
              <h3 className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/70 flex items-center gap-1.5">
                <Activity className="w-3 h-3" />
                Results
              </h3>
              <ResultsList resultsJson={decision.results_json} />
            </div>
          )}

          {/* Snapshot toggle */}
          <div>
            <button
              onClick={() => setSnapshotOpen((o) => !o)}
              className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/60 hover:text-muted-foreground transition-colors"
            >
              {snapshotOpen ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
              Raw Snapshot
            </button>
            {snapshotOpen && (
              <pre className="mt-2 p-3 bg-background border border-border text-[9px] font-mono text-muted-foreground overflow-x-auto max-h-64 whitespace-pre-wrap break-all">
                {decision.snapshot_json
                  ? JSON.stringify(parseJsonSafe(decision.snapshot_json, {}), null, 2)
                  : "(empty)"}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status panel
// ---------------------------------------------------------------------------

function ProcessControls() {
  const { data: fleetStatus } = useFleetStatus();
  const { isAdmin } = useAuth();
  const overseerAgent = fleetStatus?.agents.find((a) => a.name === "overseer");
  const [busy, setBusy] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);

  if (!isAdmin || !overseerAgent) return null;

  const isRunning = overseerAgent.llmRunning;

  async function handleControl(action: "start" | "stop" | "restart") {
    setBusy(true);
    setControlError(null);
    try {
      await apiFetch(`/agents/overseer/${action}`, { method: "POST" });
    } catch (err) {
      setControlError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border/30 pt-3">
      {!isRunning ? (
        <button
          onClick={() => handleControl("start")}
          disabled={busy}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono text-success hover:bg-success/10 border border-success/30 transition-colors disabled:opacity-50"
          title="Start overseer"
        >
          <Play className="w-3.5 h-3.5" /> Start
        </button>
      ) : (
        <button
          onClick={() => handleControl("stop")}
          disabled={busy}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono text-error hover:bg-error/10 border border-error/30 transition-colors disabled:opacity-50"
          title="Stop overseer"
        >
          <Square className="w-3.5 h-3.5" /> Stop
        </button>
      )}
      <button
        onClick={() => handleControl("restart")}
        disabled={busy}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono text-muted-foreground hover:text-foreground hover:bg-secondary border border-border transition-colors disabled:opacity-50"
        title="Restart overseer"
      >
        <RotateCw className="w-3.5 h-3.5" /> Restart
      </button>
      {controlError && (
        <span className="text-xs text-destructive font-mono">{controlError}</span>
      )}
    </div>
  );
}

function StatusPanel() {
  const { data, loading, error, refresh } = useOverseerStatus();
  const { data: fleetStatus } = useFleetStatus();
  const overseerAgent = fleetStatus?.agents.find((a) => a.name === "overseer");
  // Mobile: start collapsed, expand on tap
  const [mobileExpanded, setMobileExpanded] = useState(false);

  const isRunning = overseerAgent?.llmRunning ?? false;

  return (
    <div className="bg-card border border-border">
      {/* ---- Compact single-line summary (mobile only, always visible) ---- */}
      <button
        className="sm:hidden w-full flex items-center gap-3 px-4 py-3 text-left min-h-[44px]"
        onClick={() => setMobileExpanded((o) => !o)}
        aria-expanded={mobileExpanded}
        aria-label="Toggle overseer status details"
      >
        {/* Status dot */}
        <span
          className={cn(
            "inline-block w-2 h-2 rounded-full shrink-0",
            isRunning ? "bg-success" : "bg-muted-foreground/40"
          )}
        />

        {/* Label + status badge */}
        <span className="text-sm font-semibold text-primary uppercase tracking-wider flex items-center gap-2 min-w-0">
          <Eye className="w-4 h-4 shrink-0" />
          <span className="truncate">Overseer</span>
          {overseerAgent && (
            <span className={cn(
              "text-[10px] font-mono px-1.5 py-0.5 border shrink-0",
              isRunning
                ? "text-success border-success/30 bg-success/10"
                : "text-muted-foreground border-border"
            )}>
              {isRunning ? "ACTIVE" : "IDLE"}
            </span>
          )}
        </span>

        {/* Key metrics inline */}
        {data && !loading && (
          <span className="ml-auto flex items-center gap-3 text-[11px] font-mono text-muted-foreground shrink-0">
            <span>{data.decisionsToday} decisions</span>
            <span>{formatCost(data.costToday)}</span>
          </span>
        )}

        {/* Expand chevron */}
        <span className="text-muted-foreground/60 shrink-0">
          {mobileExpanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
        </span>
      </button>

      {/* ---- Full panel content ---- */}
      {/* On desktop (sm+): always shown. On mobile: only when expanded. */}
      <div className={cn(
        "space-y-3 p-4",
        // Mobile: hide unless expanded
        "hidden sm:block",
        mobileExpanded && "block"
      )}>
        {/* Header row (desktop) */}
        <div className="hidden sm:flex items-center justify-between">
          <h2 className="text-sm font-semibold text-primary uppercase tracking-wider flex items-center gap-2">
            <Eye className="w-4 h-4" />
            Overseer Status
            {overseerAgent && (
              <span className={cn(
                "text-[10px] font-mono px-1.5 py-0.5 border",
                isRunning
                  ? "text-success border-success/30 bg-success/10"
                  : "text-muted-foreground border-border"
              )}>
                {isRunning ? "ACTIVE" : "IDLE"}
              </span>
            )}
          </h2>
          <button
            onClick={refresh}
            className="p-1 text-muted-foreground hover:text-foreground transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center"
            title="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Mobile header row (only visible when expanded) */}
        <div className="sm:hidden flex items-center justify-between border-t border-border/30 pt-3 -mt-1">
          <span className="text-xs text-muted-foreground uppercase tracking-wider">Details</span>
          <button
            onClick={refresh}
            className="p-2 text-muted-foreground hover:text-foreground transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center"
            title="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>

        {error ? (
          <p className="text-xs text-error font-mono">{error}</p>
        ) : loading ? (
          <p className="text-xs text-muted-foreground italic">Loading...</p>
        ) : data ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="space-y-0.5">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70">Decisions Today</p>
              <p className="font-mono text-lg font-semibold text-foreground">{data.decisionsToday}</p>
            </div>
            <div className="space-y-0.5">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70">Cost Today</p>
              <p className="font-mono text-lg font-semibold text-foreground">{formatCost(data.costToday)}</p>
            </div>
          </div>
        ) : null}

        <ProcessControls />

        <p className="text-[10px] text-muted-foreground/50 italic border-t border-border/30 pt-2">
          The overseer is a 6th Claude Code agent connecting via <span className="font-mono">/mcp/overseer</span>.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Decision timeline
// ---------------------------------------------------------------------------

function DecisionTimeline() {
  const { data, loading, error, refresh } = useOverseerDecisions(50);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-primary uppercase tracking-wider">
          Decision Timeline
        </h2>
        <button
          onClick={refresh}
          className="p-1 text-muted-foreground hover:text-foreground transition-colors"
          title="Refresh"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {error && (
        <p className="text-xs text-error font-mono">{error}</p>
      )}

      {loading && (
        <div className="flex items-center gap-1 py-6 justify-center">
          <span className="w-1.5 h-1.5 bg-primary animate-bounce [animation-delay:0ms]" />
          <span className="w-1.5 h-1.5 bg-primary animate-bounce [animation-delay:150ms]" />
          <span className="w-1.5 h-1.5 bg-primary animate-bounce [animation-delay:300ms]" />
        </div>
      )}

      {!loading && data && data.length === 0 && (
        <div className="border border-border bg-card p-8 text-center">
          <p className="text-xs text-muted-foreground italic">No decisions recorded yet.</p>
          <p className="text-[10px] text-muted-foreground/60 mt-1">
            The overseer agent must connect and complete at least one tick.
          </p>
        </div>
      )}

      {!loading && data && data.length > 0 && (
        <div className="space-y-1">
          {data.map((decision) => (
            <DecisionCard key={decision.id} decision={decision} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function OverseerPage() {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="border-b border-primary/20 pb-4">
        <h1 className="text-lg font-semibold text-primary uppercase tracking-wider">
          Overseer
        </h1>
        <p className="text-xs text-muted-foreground mt-1">
          Fleet-level autonomous monitoring and corrective actions.
        </p>
      </div>

      {/* Status panel */}
      <StatusPanel />

      {/* Decision timeline */}
      <DecisionTimeline />
    </div>
  );
}
