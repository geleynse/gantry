"use client";

/**
 * Prayer tab body for the agent-detail page.
 *
 * Top card = per-agent adoption stats pulled from /api/prayer/adoption.
 * List = recent prayer calls rendered via <PrayerRow />.
 */

import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";
import { Sparkles, RefreshCw } from "lucide-react";
import { formatAbsolute, relativeTime } from "@/lib/time";
import { PrayerRow, type PrayerToolCallRecord } from "./prayer-row";

// ---------------------------------------------------------------------------
// API payload types — match src/web/routes/prayer.ts
// ---------------------------------------------------------------------------

interface AgentAdoption {
  agent: string;
  prayEnabled: boolean;
  prayerCount: number;
  turnCount: number;
  adoptionRatio: number;
  avgStepsExecuted: number | null;
  successRate: number | null;
  completedCount: number;
  errorCount: number;
  lastPrayerAt: string | null;
}

interface PrayerSummary {
  id: number;
  agent: string;
  timestamp: string;
  status: string;
  success: boolean;
  durationMs: number | null;
  traceId: string | null;
  script: string | null;
  maxSteps: number | null;
  timeoutTicks: number | null;
  normalizedScript: string | null;
  stepsExecuted: number | null;
  handoffReason: string | null;
  errorTier: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  errorLine: number | null;
  errorCol: number | null;
  suggestions: string[] | null;
  diff: unknown;
  warnings: string[] | null;
  subcallCount: number;
  subcalls: Array<{
    id: number;
    toolName: string;
    success: boolean;
    durationMs: number | null;
    errorCode: string | null;
    argsSummary: string | null;
    resultSummary: string | null;
    timestamp: string;
  }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatPct(ratio: number | null): string {
  if (ratio === null) return "—";
  return `${(ratio * 100).toFixed(0)}%`;
}

function formatAvg(n: number | null): string {
  if (n === null) return "—";
  return n.toFixed(1);
}

/**
 * Map a PrayerSummary subcall into the PrayerToolCallRecord shape so it
 * can be passed to PrayerRow as preloaded data (no extra fetch needed).
 * The summary subcall is a slim projection — fields without a source
 * value get sensible defaults (success → status, no compound flag, etc.).
 */
function subcallToRecord(
  s: PrayerSummary["subcalls"][number],
  parentId: number,
  agent: string,
): PrayerToolCallRecord {
  return {
    id: s.id,
    agent,
    tool_name: s.toolName,
    args_summary: s.argsSummary,
    result_summary: s.resultSummary,
    success: s.success ? 1 : 0,
    error_code: s.errorCode,
    duration_ms: s.durationMs,
    is_compound: 0,
    trace_id: null,
    parent_id: parentId,
    status: s.success ? "complete" : "error",
    assistant_text: null,
    timestamp: s.timestamp,
    created_at: s.timestamp,
  };
}

/**
 * Re-hydrate a PrayerSummary back into the shape PrayerRow expects
 * (it accepts a ToolCallRecord-shaped object). We round-trip through
 * the same JSON contract the tool-call-feed uses so the row's internal
 * parsing stays identical.
 */
function summaryToRecord(p: PrayerSummary): PrayerToolCallRecord {
  const args = {
    script: p.script ?? undefined,
    max_steps: p.maxSteps ?? undefined,
    timeout_ticks: p.timeoutTicks ?? undefined,
  };
  const error = p.errorCode || p.errorTier || p.errorMessage
    ? {
        tier: p.errorTier ?? undefined,
        code: p.errorCode ?? undefined,
        message: p.errorMessage ?? undefined,
        line: p.errorLine ?? undefined,
        col: p.errorCol ?? undefined,
        suggestions: p.suggestions ?? undefined,
      }
    : undefined;
  const result = {
    status: p.status,
    steps_executed: p.stepsExecuted ?? undefined,
    handoff_reason: p.handoffReason ?? undefined,
    normalized_script: p.normalizedScript ?? undefined,
    warnings: p.warnings ?? undefined,
    diff: p.diff ?? undefined,
    error,
  };
  // Narrow status back into the union tool-call-feed expects.
  const feedStatus: "pending" | "complete" | "error" =
    p.status === "pending" ? "pending" : p.success ? "complete" : "error";
  return {
    id: p.id,
    agent: p.agent,
    tool_name: "pray",
    args_summary: JSON.stringify(args),
    result_summary: JSON.stringify(result),
    success: p.success ? 1 : 0,
    error_code: p.errorCode,
    duration_ms: p.durationMs,
    is_compound: 1,
    trace_id: p.traceId,
    parent_id: null,
    status: feedStatus,
    assistant_text: null,
    timestamp: p.timestamp,
    created_at: p.timestamp,
  };
}

// ---------------------------------------------------------------------------
// AdoptionCard — compact stats grid for a single agent
// ---------------------------------------------------------------------------

function AdoptionCard({ row }: { row: AgentAdoption }) {
  const adoptionClass =
    row.adoptionRatio >= 0.2 ? "text-success" :
    row.adoptionRatio > 0    ? "text-warning" :
                               "text-muted-foreground";

  const successClass =
    row.successRate === null   ? "text-muted-foreground" :
    row.successRate >= 0.9     ? "text-success" :
    row.successRate >= 0.6     ? "text-warning" :
                                 "text-error";

  return (
    <div className="bg-card border border-border p-4 space-y-3">
      <div className="flex items-center gap-2 border-b border-border pb-2">
        <Sparkles className="w-4 h-4 text-violet-400" />
        <h3 className="text-[10px] uppercase tracking-wider text-foreground/70">Prayer adoption (24h)</h3>
        {!row.prayEnabled && (
          <span className="ml-auto text-[9px] uppercase tracking-wider font-sans px-1.5 py-0.5 bg-muted/20 text-muted-foreground border border-border">
            prayer disabled
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        <Stat label="Adoption" value={formatPct(row.adoptionRatio)} tone={adoptionClass} sub={`${row.prayerCount}/${row.turnCount} turns`} />
        <Stat label="Success" value={formatPct(row.successRate)} tone={successClass} sub={`${row.completedCount} completed`} />
        <Stat label="Avg steps" value={formatAvg(row.avgStepsExecuted)} />
        <Stat label="Errors" value={String(row.errorCount)} tone={row.errorCount > 0 ? "text-error" : "text-muted-foreground"} />
      </div>

      {row.lastPrayerAt && (
        <div
          className="text-[10px] text-muted-foreground"
          title={relativeTime(row.lastPrayerAt)}
        >
          Last prayer: {formatAbsolute(row.lastPrayerAt)}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone, sub }: { label: string; value: string; tone?: string; sub?: string }) {
  return (
    <div className="space-y-0.5">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn("font-mono text-sm font-bold", tone ?? "text-foreground")}>{value}</div>
      {sub && <div className="text-[9px] text-muted-foreground/70">{sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PrayerPanel — main export
// ---------------------------------------------------------------------------

export function PrayerPanel({ agentName }: { agentName: string }) {
  const [adoption, setAdoption] = useState<AgentAdoption | null>(null);
  const [prayers, setPrayers] = useState<PrayerSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [adoptionRes, prayersRes] = await Promise.all([
        apiFetch<{ hours: number; adoption: AgentAdoption[] }>(`/prayer/adoption?hours=24`),
        apiFetch<{ prayers: PrayerSummary[] }>(`/prayer/recent?agent=${encodeURIComponent(agentName)}&limit=25`),
      ]);
      const row = adoptionRes.adoption.find((r) => r.agent === agentName) ?? null;
      setAdoption(row);
      setPrayers(prayersRes.prayers);
    } catch (err) {
      setError((err as Error).message ?? "Failed to load prayer telemetry");
    } finally {
      setLoading(false);
    }
  }, [agentName]);

  useEffect(() => { load(); }, [load]);

  function toggleExpand(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      {/* Adoption card */}
      {adoption ? (
        <AdoptionCard row={adoption} />
      ) : loading ? (
        <div className="bg-card border border-border p-4 text-[11px] text-muted-foreground italic">
          Loading adoption…
        </div>
      ) : (
        <div className="bg-card border border-border p-4 text-[11px] text-muted-foreground italic">
          No adoption data available
        </div>
      )}

      {/* Recent prayers list */}
      <div className="bg-card border border-border">
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border">
          <div className="flex items-center gap-2">
            <Sparkles className="w-3.5 h-3.5 text-violet-400" />
            <h3 className="text-[10px] uppercase tracking-wider text-foreground/70">Recent prayers</h3>
            <span className="text-[10px] text-muted-foreground">({prayers.length})</span>
          </div>
          <button
            onClick={load}
            disabled={loading}
            className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors"
            title="Refresh"
          >
            <RefreshCw className={cn("w-3 h-3", loading && "animate-spin")} />
            {loading ? "…" : "refresh"}
          </button>
        </div>

        {error && (
          <div className="px-3 py-1.5 text-[10px] text-error bg-error/10 border-b border-border">{error}</div>
        )}

        {loading && prayers.length === 0 && (
          <div className="px-3 py-8 text-center text-xs text-muted-foreground italic">Loading…</div>
        )}

        {!loading && !error && prayers.length === 0 && (
          <div className="px-3 py-8 text-center text-xs text-muted-foreground italic">
            No prayers recorded for {agentName} yet.
          </div>
        )}

        {prayers.map((p) => (
          <PrayerRow
            key={p.id}
            record={summaryToRecord(p)}
            agentName={agentName}
            isGroupExpanded={expanded.has(p.id)}
            onToggle={() => toggleExpand(p.id)}
            preloadedSubcalls={p.subcalls.map((s) => subcallToRecord(s, p.id, p.agent))}
          />
        ))}
      </div>
    </div>
  );
}

// Exported for tests
export const __test__ = { summaryToRecord, subcallToRecord, formatPct, formatAvg };
