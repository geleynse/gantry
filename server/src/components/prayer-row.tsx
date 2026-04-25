"use client";

/**
 * Themed tool-call-feed row for `pray` (PrayerLang scripts).
 *
 * Matches the CompoundToolRow shape in tool-call-feed.tsx — same props,
 * same expand/collapse pattern, but with prayer-specific content:
 *  - Script rendered in monospace when expanded
 *  - Normalized script + subcall tree + diff payload
 *  - Status badge that reads from result_summary.status
 *  - Step/timeout/subcall counts in the header
 */

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";
import { formatTime } from "@/lib/time";
import { ChevronDown, ChevronUp, Sparkles } from "lucide-react";

// ---------------------------------------------------------------------------
// Types — mirror the tool-call-feed ToolCallRecord shape
// ---------------------------------------------------------------------------

export interface PrayerToolCallRecord {
  id: number;
  agent: string;
  tool_name: string;
  args_summary: string | null;
  result_summary: string | null;
  success: number;
  error_code: string | null;
  duration_ms: number | null;
  is_compound: number;
  trace_id: string | null;
  parent_id: number | null;
  status: "pending" | "complete" | "error";
  assistant_text: string | null;
  timestamp: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJson<T>(s: string | null): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

interface PrayerArgs {
  script?: string;
  max_steps?: number;
  timeout_ticks?: number;
}

interface PrayerResult {
  status?: string;
  steps_executed?: number;
  handoff_reason?: string;
  normalized_script?: string;
  warnings?: string[];
  diff?: unknown;
  error?: {
    tier?: string;
    code?: string;
    message?: string;
    line?: number;
    col?: number;
    suggestions?: string[];
  };
}

function statusBadgeClasses(status: string): string {
  switch (status) {
    case "completed":            return "bg-success/20 text-success";
    case "halted":               return "bg-amber-500/20 text-amber-400";
    case "step_limit_reached":   return "bg-amber-500/20 text-amber-400";
    case "interrupted":          return "bg-orange-500/20 text-orange-400";
    case "error":                return "bg-error/20 text-error";
    case "pending":              return "bg-info/20 text-info";
    default:                     return "bg-muted/20 text-muted-foreground";
  }
}

function borderClass(record: PrayerToolCallRecord): string {
  if (record.status === "pending") return "border-l-2 border-l-info animate-pulse";
  if (!record.success) return "border-l-2 border-l-error";
  return "border-l-2 border-l-violet-500/40";
}

function statusDotClass(record: PrayerToolCallRecord): string {
  if (record.status === "pending") return "bg-info animate-pulse";
  if (!record.success) return "bg-error";
  return "bg-success";
}

function ElapsedTimer({ since }: { since: string }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = new Date(since).getTime();
    const tick = () => setElapsed(Date.now() - start);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [since]);
  return <span>{Math.round(elapsed / 1000)}s</span>;
}

// ---------------------------------------------------------------------------
// PrayerRow — main export
// ---------------------------------------------------------------------------

export function PrayerRow({
  record,
  agentName,
  isGroupExpanded,
  onToggle,
  preloadedSubcalls,
  count = 1,
}: {
  record: PrayerToolCallRecord;
  agentName: string;
  isGroupExpanded: boolean;
  onToggle: () => void;
  /**
   * If provided, skip the /api/tool-calls fetch and use these subcalls
   * directly. Used when the parent already has the data (e.g. PrayerPanel
   * fetches PrayerSummary which contains subcalls inline).
   */
  preloadedSubcalls?: PrayerToolCallRecord[];
  /**
   * Group size when this row represents collapsed adjacent prayer calls
   * in tool-call-feed. Defaults to 1. When > 1 a small "Nx" badge is
   * shown next to the tool name; the displayed record is the most recent
   * call in the group (existing tool-call-feed behavior).
   */
  count?: number;
}) {
  const [subCalls, setSubCalls] = useState<PrayerToolCallRecord[]>(preloadedSubcalls ?? []);
  const [subLoaded, setSubLoaded] = useState(preloadedSubcalls !== undefined);

  const args = parseJson<PrayerArgs>(record.args_summary) ?? {};
  const result = parseJson<PrayerResult>(record.result_summary) ?? {};

  const displayStatus =
    record.status === "pending"
      ? "pending"
      : (result.status ?? (record.success ? "completed" : "error"));
  const stepsExecuted = typeof result.steps_executed === "number" ? result.steps_executed : null;
  const maxSteps = typeof args.max_steps === "number" ? args.max_steps : null;
  const script = typeof args.script === "string" ? args.script : "";
  const normalizedScript = typeof result.normalized_script === "string" ? result.normalized_script : null;
  const handoffReason = typeof result.handoff_reason === "string" ? result.handoff_reason : null;
  const error = result.error ?? null;
  const warnings = Array.isArray(result.warnings) ? result.warnings : null;

  // First line preview for collapsed row
  const scriptPreview = script.split("\n")[0]?.slice(0, 80) ?? "";
  const hasMoreScript = script.includes("\n") || script.length > 80;

  useEffect(() => {
    if (!isGroupExpanded || subLoaded) return;
    if (preloadedSubcalls !== undefined) return; // already provided by parent
    apiFetch<{ tool_calls: PrayerToolCallRecord[] }>(
      `/tool-calls?agent=${encodeURIComponent(agentName)}&parent_id=${record.id}&limit=100`,
    )
      .then(({ tool_calls }) => setSubCalls(tool_calls))
      .catch(() => { /* non-fatal */ })
      .finally(() => setSubLoaded(true));
  }, [isGroupExpanded, subLoaded, agentName, record.id, preloadedSubcalls]);

  return (
    <div>
      {/* Header row */}
      <div
        onClick={onToggle}
        className={cn(
          "px-3 py-2 border-b border-border text-xs font-mono flex items-center gap-2 cursor-pointer",
          "bg-violet-950/20 hover:bg-violet-500/5",
          borderClass(record),
        )}
      >
        {/* Timestamp */}
        <span className="text-muted-foreground shrink-0 w-16">
          {formatTime(record.timestamp)}
        </span>

        {/* Status dot */}
        <span className={cn("inline-block w-1.5 h-1.5 rounded-full shrink-0", statusDotClass(record))} />

        {/* Expand/collapse icon */}
        <span className="shrink-0">
          {isGroupExpanded
            ? <ChevronUp className="w-3 h-3 text-muted-foreground/50" />
            : <ChevronDown className="w-3 h-3 text-muted-foreground/50" />
          }
        </span>

        {/* Prayer icon */}
        <span className="shrink-0 text-violet-300">
          <Sparkles className="w-3 h-3" />
        </span>

        {/* Tool name */}
        <span className="font-bold shrink-0 text-violet-300">
          pray
          {count > 1 && (
            <span className="ml-1 font-normal text-violet-300/60">{count}x</span>
          )}
        </span>

        {/* Prayer badge */}
        <span className="px-1.5 py-0.5 text-[9px] font-sans uppercase tracking-wider font-medium shrink-0 bg-violet-500/20 text-violet-400">
          prayer
        </span>

        {/* Status badge */}
        <span className={cn("px-1.5 py-0.5 text-[10px] shrink-0 font-sans", statusBadgeClasses(displayStatus))}>
          {displayStatus}
        </span>

        {/* Step counter */}
        {stepsExecuted !== null && (
          <span className="text-muted-foreground/70 text-[10px] shrink-0 font-sans">
            {stepsExecuted}{maxSteps !== null ? `/${maxSteps}` : ""} steps
          </span>
        )}

        {/* Script preview */}
        {scriptPreview && (
          <span className="text-muted-foreground/80 min-w-0 flex-1 truncate">
            {scriptPreview}{hasMoreScript ? "…" : ""}
          </span>
        )}

        {/* Sub-call count hint when complete and collapsed */}
        {record.status !== "pending" && !isGroupExpanded && subLoaded && subCalls.length > 0 && (
          <span className="text-muted-foreground/50 text-[10px] shrink-0">
            {subCalls.length} sub-ops
          </span>
        )}

        {/* Duration */}
        {record.status === "pending" ? (
          <span className="text-info shrink-0 text-right w-16">
            <ElapsedTimer since={record.timestamp} />
          </span>
        ) : record.duration_ms !== null ? (
          <span className="text-muted-foreground shrink-0 text-right w-16">
            {record.duration_ms}ms
          </span>
        ) : null}
      </div>

      {/* Expanded detail section */}
      {isGroupExpanded && (
        <div className="bg-background/50 border-b border-border">
          {/* Script */}
          {script && (
            <div className="px-6 py-2 space-y-1 border-b border-border/30">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Script</div>
              <pre className="whitespace-pre-wrap break-all font-mono text-foreground/80 text-[10px]">{script}</pre>
            </div>
          )}

          {/* Normalized (if present and different from input) */}
          {normalizedScript && normalizedScript !== script && (
            <div className="px-6 py-2 space-y-1 border-b border-border/30">
              <div className="text-[10px] uppercase tracking-wider text-violet-400/70">Normalized</div>
              <pre className="whitespace-pre-wrap break-all font-mono text-foreground/70 text-[10px]">{normalizedScript}</pre>
            </div>
          )}

          {/* Warnings */}
          {warnings && warnings.length > 0 && (
            <div className="px-6 py-2 space-y-1 border-b border-border/30">
              <div className="text-[10px] uppercase tracking-wider text-warning/70">Warnings</div>
              <ul className="text-[10px] text-warning/90 list-disc pl-4 space-y-0.5">
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Error block */}
          {error && (
            <div className="px-6 py-2 space-y-1 border-b border-border/30 bg-error/5">
              <div className="text-[10px] uppercase tracking-wider text-error/80">
                Error
                {error.tier ? ` — ${error.tier}` : ""}
                {error.code ? ` (${error.code})` : ""}
              </div>
              {error.message && (
                <div className="text-[10px] text-error/90 font-mono">{error.message}</div>
              )}
              {(error.line != null || error.col != null) && (
                <div className="text-[9px] text-muted-foreground">
                  at line {error.line ?? "?"}{error.col != null ? `, col ${error.col}` : ""}
                </div>
              )}
              {Array.isArray(error.suggestions) && error.suggestions.length > 0 && (
                <div className="pt-1">
                  <div className="text-[9px] uppercase tracking-wider text-muted-foreground/70">Suggestions</div>
                  <ul className="text-[10px] text-muted-foreground list-disc pl-4 space-y-0.5">
                    {error.suggestions.map((s, i) => <li key={i}>{s}</li>)}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Handoff reason */}
          {handoffReason && (
            <div className="px-6 py-2 space-y-1 border-b border-border/30">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Handoff reason</div>
              <div className="text-[10px] text-foreground/70 italic">{handoffReason}</div>
            </div>
          )}

          {/* Subcall tree */}
          {!subLoaded && (
            <div className="px-6 py-2 text-[10px] text-muted-foreground italic">Loading sub-calls…</div>
          )}
          {subLoaded && subCalls.length > 0 && (
            <>
              <div className="px-6 py-1 text-[9px] uppercase tracking-wider text-muted-foreground/40 font-sans border-b border-border/30">
                {subCalls.length} sub-operation{subCalls.length !== 1 ? "s" : ""}
              </div>
              <div className="ml-4">
                {subCalls.map((sub, idx) => {
                  const isLast = idx === subCalls.length - 1;
                  return (
                    <div
                      key={sub.id}
                      className={cn(
                        "pl-3 py-1.5 text-[10px] font-mono flex items-center gap-2",
                        "border-b border-border/30 last:border-b-0",
                        !isLast && "border-l border-l-violet-500/30",
                      )}
                    >
                      <span className="text-muted-foreground shrink-0 w-16">
                        {formatTime(sub.timestamp)}
                      </span>
                      <span className={cn("inline-block w-1.5 h-1.5 rounded-full shrink-0", statusDotClass(sub))} />
                      <span className="text-foreground/60">{sub.tool_name}</span>
                      {sub.args_summary && (
                        <span className="text-muted-foreground/60 min-w-0 flex-1 truncate">
                          {sub.args_summary}
                        </span>
                      )}
                      {sub.result_summary && (
                        <span className="text-muted-foreground/50 min-w-0 flex-1 truncate">
                          {sub.result_summary}
                        </span>
                      )}
                      {sub.duration_ms !== null && (
                        <span className="text-muted-foreground/50 shrink-0 w-14 text-right">
                          {sub.duration_ms}ms
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* Diff payload (raw) */}
          {result.diff != null && (
            <div className="px-6 py-2 space-y-1 border-b border-border/30">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Diff</div>
              <pre className="whitespace-pre-wrap break-all font-mono text-foreground/70 text-[10px]">
                {typeof result.diff === "string" ? result.diff : JSON.stringify(result.diff, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers exported for tests
// ---------------------------------------------------------------------------

export const __test__ = {
  statusBadgeClasses,
  parseJson,
};
