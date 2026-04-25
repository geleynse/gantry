"use client";

// #508 — "Routines not showing in activity tab"
// Investigation: Routines already appear in the feed. Agents call the MCP tool `execute_routine`,
// which is logged as a tool call with tool_name "execute_routine". Sub-calls are logged as
// "routine:NAME:tool_name" and grouped by trace_id. The "Routines" filter tab, isRoutineRecord(),
// groupRoutineCalls(), and RoutineGroupRow are all wired up and working. No code fix needed.

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useSSE } from "@/hooks/use-sse";
import { apiFetch } from "@/lib/api";
import { formatTime, formatDateTime } from "@/lib/time";
import { formatNumber } from "@/lib/format";
import { ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Pickaxe, DollarSign, Navigation } from "lucide-react";
import { PrayerRow } from "@/components/prayer-row";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ToolCallRecord {
  id: number;
  agent: string;
  tool_name: string;
  args_summary: string | null;
  result_summary: string | null;
  success: number; // 0 or 1
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

interface TurnCost {
  turnNumber: number;
  startedAt: string;
  completedAt: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  iterations: number | null;
  model: string | null;
}

/** Sentinel tool_name used for assistant text records */
const ASSISTANT_TEXT_TOOL = "__assistant_text";

/** Sentinel tool_name used for extended reasoning/thinking block records */
const REASONING_TOOL = "__reasoning";

/** Max chars to show before truncating assistant text */
const TEXT_TRUNCATE_LEN = 200;

// ---------------------------------------------------------------------------
// Compound tool metadata — mirrors server-side descriptions
// ---------------------------------------------------------------------------

const COMPOUND_TOOL_DESCRIPTIONS: Record<string, string> = {
  batch_mine: "Mine multiple ticks with auto-stop on cargo full",
  travel_to: "Undock → travel → dock in one operation",
  jump_route: "Multi-system jump via shortest path",
  multi_sell: "Sell cargo across multiple buyers",
  scan_and_attack: "Scan for hostiles and engage",
  loot_wrecks: "Loot multiple wrecks at current location",
  battle_readiness: "Check combat readiness status",
  flee: "Emergency escape from combat",
  pray: "Execute a bounded PrayerLang script",
};

const COMPOUND_TOOL_NAMES = new Set(Object.keys(COMPOUND_TOOL_DESCRIPTIONS));

function isCompoundTool(record: ToolCallRecord): boolean {
  return record.is_compound === 1 || COMPOUND_TOOL_NAMES.has(record.tool_name);
}

// ---------------------------------------------------------------------------
// Filter categories
// ---------------------------------------------------------------------------

type FilterId = "all" | "navigation" | "combat" | "economy" | "social" | "routines";

const FILTERS: { id: FilterId; label: string }[] = [
  { id: "all", label: "All" },
  { id: "routines", label: "Routines" },
  { id: "navigation", label: "Navigation" },
  { id: "combat", label: "Combat" },
  { id: "economy", label: "Economy" },
  { id: "social", label: "Social" },
];

const FILTER_TOOLS: Record<Exclude<FilterId, "all" | "routines">, string[]> = {
  navigation: ["jump", "travel", "travel_to", "jump_route", "find_route", "get_map", "scan_local"],
  combat: ["scan_and_attack", "attack", "flee", "loot_wrecks"],
  economy: ["batch_mine", "multi_sell", "buy", "analyze_market", "get_missions"],
  social: ["write_diary", "write_doc", "write_report", "captains_log_add", "search_memory"],
};

/** WS protocol events stored as tool calls — hide from categorised views */
function isWsEvent(toolName: string): boolean {
  return toolName.startsWith("ws:");
}

function isAssistantText(record: ToolCallRecord): boolean {
  return record.tool_name === ASSISTANT_TEXT_TOOL;
}

function isReasoning(record: ToolCallRecord): boolean {
  return record.tool_name === REASONING_TOOL;
}

function isRoutineRecord(toolName: string): boolean {
  return toolName === "execute_routine" || toolName.startsWith("routine:");
}

function matchesFilter(record: ToolCallRecord, filter: FilterId): boolean {
  if (filter === "all") return !isWsEvent(record.tool_name);
  if (filter === "routines") return isRoutineRecord(record.tool_name);
  // Hide assistant text and reasoning in category views — only visible in the "all" view
  if (isAssistantText(record) || isReasoning(record)) return false;
  return FILTER_TOOLS[filter].includes(record.tool_name);
}

// ---------------------------------------------------------------------------
// Deduplication: collapse consecutive identical ws: events into a single row
// ---------------------------------------------------------------------------

interface DisplayRecord {
  record: ToolCallRecord;
  /** > 1 means collapsed group */
  count: number;
  /** All records in a collapsed group (for expansion) */
  groupRecords: ToolCallRecord[];
  /** ISO timestamp of last event in group */
  lastTimestamp: string;
  /** True when this is a routine group (execute_routine + sub-calls) */
  isRoutineGroup?: boolean;
}

function deduplicateWsEvents(entries: ToolCallRecord[]): DisplayRecord[] {
  const result: DisplayRecord[] = [];
  for (const record of entries) {
    if (!isWsEvent(record.tool_name)) {
      result.push({ record, count: 1, groupRecords: [record], lastTimestamp: record.timestamp });
      continue;
    }
    const last = result[result.length - 1];
    if (last && last.record.tool_name === record.tool_name && isWsEvent(record.tool_name)) {
      // Collapse into existing group
      last.count++;
      last.groupRecords.push(record);
      last.lastTimestamp = record.timestamp;
    } else {
      result.push({ record, count: 1, groupRecords: [record], lastTimestamp: record.timestamp });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Routine grouping: collapse execute_routine + sub-calls into a single row
// ---------------------------------------------------------------------------

function parseJson<T>(str: string | null): T | null {
  if (!str) return null;
  try { return JSON.parse(str) as T; } catch { return null; }
}

function groupRoutineCalls(entries: DisplayRecord[]): DisplayRecord[] {
  // Collect routine:* sub-calls keyed by trace_id
  const subCallsByTraceId = new Map<string, ToolCallRecord[]>();
  const subCallIds = new Set<number>();

  for (const { record } of entries) {
    if (record.tool_name.startsWith("routine:") && record.trace_id) {
      const arr = subCallsByTraceId.get(record.trace_id) ?? [];
      arr.push(record);
      subCallsByTraceId.set(record.trace_id, arr);
      subCallIds.add(record.id);
    }
  }

  const result: DisplayRecord[] = [];
  for (const display of entries) {
    const { record } = display;

    // Sub-calls are absorbed into their parent group row
    if (subCallIds.has(record.id)) continue;

    if (record.tool_name === "execute_routine" && record.trace_id) {
      const subs = subCallsByTraceId.get(record.trace_id) ?? [];
      result.push({
        record,
        count: subs.length,
        groupRecords: subs,
        lastTimestamp: display.lastTimestamp,
        isRoutineGroup: true,
      });
    } else {
      result.push(display);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_ENTRIES = 200;
const PAGE_SIZE = 50;

/** Sort records by timestamp descending, with id as stable tiebreaker (#513) */
function sortByTimestamp(entries: ToolCallRecord[]): ToolCallRecord[] {
  return [...entries].sort((a, b) => {
    const ta = new Date(a.timestamp).getTime();
    const tb = new Date(b.timestamp).getTime();
    if (ta !== tb) return tb - ta; // newer first
    return b.id - a.id; // higher id (later insertion) first for stable same-second ordering
  });
}

/** Format cost + tokens into a badge string (e.g., "$0.047 | 12k tok") */
function formatCostBadge(cost: number | null, inputTokens: number | null, outputTokens: number | null): string | null {
  if (cost === null || inputTokens === null || outputTokens === null) return null;
  const totalTokens = inputTokens + outputTokens;
  const tokenDisplay = totalTokens >= 1000 ? `${Math.round(totalTokens / 1000)}k` : String(totalTokens);
  return `$${cost.toFixed(3)} | ${tokenDisplay} tok`;
}

/** Find the turn that contains this tool call timestamp */
function findTurnForToolCall(record: ToolCallRecord, turns: TurnCost[]): TurnCost | null {
  const toolCallTime = new Date(record.timestamp).getTime();
  for (const turn of turns) {
    const turnStart = new Date(turn.startedAt).getTime();
    const turnEnd = turn.completedAt ? new Date(turn.completedAt).getTime() : Infinity;
    if (toolCallTime >= turnStart && toolCallTime <= turnEnd) {
      return turn;
    }
  }
  return null;
}

function rowBorderClass(record: ToolCallRecord): string {
  if (record.status === "pending") return "border-l-2 border-l-info animate-pulse";
  if (!record.success) return "border-l-2 border-l-error";
  if (record.error_code === "cooldown") return "border-l-2 border-l-warning";
  return "border-l-2 border-l-success";
}

function statusDotClass(record: ToolCallRecord): string {
  if (record.status === "pending") return "bg-info animate-pulse";
  if (!record.success) return "bg-error";
  if (record.error_code === "cooldown") return "bg-warning";
  return "bg-success";
}

function ElapsedTimer({ since }: { since: string }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = new Date(since).getTime();
    const tick = () => setElapsed(Date.now() - start);
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [since]);
  return <span>{Math.round(elapsed / 1000)}s</span>;
}

// ---------------------------------------------------------------------------
// AssistantTextRow — renders narrative commentary between tool calls (#300)
// ---------------------------------------------------------------------------

function AssistantTextRow({ record }: { record: ToolCallRecord }) {
  const [expanded, setExpanded] = useState(false);
  const text = record.assistant_text ?? "";
  const isStreaming = record.status === "pending";
  const isLong = text.length > TEXT_TRUNCATE_LEN;
  const displayText = !expanded && isLong
    ? text.slice(0, TEXT_TRUNCATE_LEN) + "..."
    : text;

  return (
    <div className="border-b border-border">
      <div className="px-3 py-2 text-xs flex items-start gap-2 bg-secondary/10 border-l-2 border-l-primary/30">
        {/* Timestamp */}
        <span className="text-muted-foreground shrink-0 w-16 font-mono">
          {formatTime(record.timestamp)}
        </span>

        {/* Label */}
        <span className="text-primary/60 shrink-0 text-[10px] uppercase tracking-wider font-bold mt-0.5">
          commentary
        </span>

        {/* Live streaming indicator */}
        {isStreaming && (
          <span className="shrink-0 flex items-center gap-1 text-[9px] text-info uppercase tracking-wider mt-0.5">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-info animate-pulse" />
            live
          </span>
        )}

        {/* Text content */}
        <span className="text-foreground/70 italic min-w-0 flex-1 whitespace-pre-wrap break-words leading-relaxed">
          {displayText}
        </span>
      </div>

      {/* Show more / less toggle */}
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="px-3 py-1 text-[10px] text-primary/60 hover:text-primary bg-secondary/10 border-l-2 border-l-primary/30 w-full text-left cursor-pointer transition-colors"
        >
          {expanded ? "show less" : "show more"}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ReasoningRow — renders extended thinking/reasoning blocks (collapsible)
// ---------------------------------------------------------------------------

function ReasoningRow({ record }: { record: ToolCallRecord }) {
  const [expanded, setExpanded] = useState(false);
  const text = record.assistant_text ?? "";
  const isLong = text.length > TEXT_TRUNCATE_LEN;
  const displayText = !expanded && isLong
    ? text.slice(0, TEXT_TRUNCATE_LEN) + "..."
    : text;

  return (
    <div className="border-b border-border">
      <div
        onClick={() => isLong && setExpanded(!expanded)}
        className={cn(
          "px-3 py-2 text-xs flex items-start gap-2 bg-indigo-950/20 border-l-2 border-l-indigo-500/40",
          isLong && "cursor-pointer hover:bg-indigo-950/30",
        )}
      >
        {/* Timestamp */}
        <span className="text-muted-foreground shrink-0 w-16 font-mono">
          {formatTime(record.timestamp)}
        </span>

        {/* Label */}
        <span className="text-indigo-400/80 shrink-0 text-[10px] uppercase tracking-wider font-bold mt-0.5">
          reasoning
        </span>

        {/* Expand/collapse hint */}
        {isLong && (
          <span className="shrink-0 mt-0.5">
            {expanded
              ? <ChevronUp className="w-3 h-3 text-indigo-400/50" />
              : <ChevronDown className="w-3 h-3 text-indigo-400/50" />
            }
          </span>
        )}

        {/* Text content */}
        <span className="text-foreground/60 italic min-w-0 flex-1 whitespace-pre-wrap break-words leading-relaxed">
          {displayText}
        </span>
      </div>

      {/* Explicit show more / less toggle for accessibility */}
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="px-3 py-1 text-[10px] text-indigo-400/60 hover:text-indigo-400 bg-indigo-950/20 border-l-2 border-l-indigo-500/40 w-full text-left cursor-pointer transition-colors"
        >
          {expanded ? "show less" : "show more"}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RoutineGroupRow — renders an execute_routine group with expandable sub-calls
// ---------------------------------------------------------------------------

function RoutineGroupRow({
  record,
  count,
  groupRecords,
  isGroupExpanded,
  onToggle,
}: {
  record: ToolCallRecord;
  count: number;
  groupRecords: ToolCallRecord[];
  isGroupExpanded: boolean;
  onToggle: () => void;
}) {
  const args = parseJson<{ routine?: string }>(record.args_summary);
  const result = parseJson<{ status?: string; summary?: string }>(record.result_summary);
  const routineName = args?.routine ?? "unknown";
  const routineStatus = result?.status;
  const routineSummary = result?.summary;

  const statusBadgeClass =
    routineStatus === "completed" ? "bg-success/20 text-success" :
    routineStatus === "handoff"   ? "bg-warning/20 text-warning" :
    routineStatus === "error"     ? "bg-error/20 text-error" :
    "bg-muted/20 text-muted-foreground";

  return (
    <div>
      <div
        onClick={onToggle}
        className={cn(
          "px-3 py-2 border-b border-border text-xs font-mono flex items-center gap-2",
          "hover:bg-primary/5 cursor-pointer",
          rowBorderClass(record),
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

        {/* Routine name badge */}
        <span className="px-1.5 py-0.5 rounded text-[10px] bg-purple-500/20 text-purple-400 shrink-0 font-sans">
          {routineName}
        </span>

        {/* Status badge */}
        {routineStatus && (
          <span className={cn("px-1.5 py-0.5 rounded text-[10px] shrink-0 font-sans", statusBadgeClass)}>
            {routineStatus}
          </span>
        )}

        {/* Summary text */}
        {routineSummary && (
          <span className="text-muted-foreground min-w-0 flex-1 truncate">
            {routineSummary.length > 100 ? routineSummary.slice(0, 100) + "…" : routineSummary}
          </span>
        )}

        {/* Step count */}
        {count > 0 && (
          <span className="text-muted-foreground/60 text-[10px] shrink-0">
            {count} steps
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

      {/* Expanded sub-call list */}
      {isGroupExpanded && groupRecords.length > 0 && (
        <div className="bg-background/50 border-b border-border">
          {groupRecords.map((sub) => {
            // Strip "routine:NAME:" prefix to show just the tool name
            const toolDisplay = sub.tool_name.replace(/^routine:[^:]+:/, "");
            return (
              <div
                key={sub.id}
                className="px-6 py-1.5 text-[10px] font-mono flex items-center gap-2 border-b border-border/30 last:border-b-0"
              >
                <span className="text-muted-foreground shrink-0 w-16">
                  {formatTime(sub.timestamp)}
                </span>
                <span className={cn("inline-block w-1.5 h-1.5 rounded-full shrink-0", statusDotClass(sub))} />
                <span className="text-foreground/60">{toolDisplay}</span>
                {sub.result_summary && (
                  <span className="text-muted-foreground/60 min-w-0 flex-1">
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
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CompoundToolRow — distinct rendering for compound tools with sub-call support
// ---------------------------------------------------------------------------

/** Per-tool visual theme config */
interface CompoundToolTheme {
  bg: string;
  border: string;
  hover: string;
  nameCls: string;
  badgeCls: string;
  connectorCls: string;
  icon: React.ReactNode;
  label: string;
}

const COMPOUND_TOOL_THEMES: Record<string, CompoundToolTheme> = {
  batch_mine: {
    bg: "bg-amber-950/20",
    border: "border-l-2 border-l-amber-500/40",
    hover: "hover:bg-amber-500/5",
    nameCls: "text-amber-300",
    badgeCls: "bg-amber-500/20 text-amber-400",
    connectorCls: "border-l-amber-500/30",
    icon: <Pickaxe className="w-3 h-3" />,
    label: "batch_mine",
  },
  multi_sell: {
    bg: "bg-emerald-950/20",
    border: "border-l-2 border-l-emerald-500/40",
    hover: "hover:bg-emerald-500/5",
    nameCls: "text-emerald-300",
    badgeCls: "bg-emerald-500/20 text-emerald-400",
    connectorCls: "border-l-emerald-500/30",
    icon: <DollarSign className="w-3 h-3" />,
    label: "multi_sell",
  },
  travel_to: {
    bg: "bg-cyan-950/20",
    border: "border-l-2 border-l-cyan-500/40",
    hover: "hover:bg-cyan-500/5",
    nameCls: "text-cyan-300",
    badgeCls: "bg-cyan-500/20 text-cyan-400",
    connectorCls: "border-l-cyan-500/30",
    icon: <Navigation className="w-3 h-3" />,
    label: "travel_to",
  },
};

/** Default theme for compound tools not in the specific map */
const DEFAULT_COMPOUND_THEME: CompoundToolTheme = {
  bg: "bg-blue-950/20",
  border: "border-l-2 border-l-blue-500/40",
  hover: "hover:bg-blue-500/5",
  nameCls: "text-blue-300",
  badgeCls: "bg-blue-500/20 text-blue-400",
  connectorCls: "border-l-blue-500/30",
  icon: null,
  label: "compound",
};

function getCompoundTheme(toolName: string): CompoundToolTheme {
  return COMPOUND_TOOL_THEMES[toolName] ?? DEFAULT_COMPOUND_THEME;
}

/**
 * Best-effort extraction of the total operation count from compound tool args.
 * Returns null when no meaningful total can be derived.
 */
function getCompoundTotal(toolName: string, argsSummary: string | null): number | null {
  if (!argsSummary) return null;
  const args = parseJson<Record<string, unknown>>(argsSummary);
  if (!args) return null;

  if (toolName === "batch_mine") {
    const cycles = Number(args.cycles ?? args.max_cycles);
    return Number.isFinite(cycles) && cycles > 0 ? cycles : null;
  }
  if (toolName === "multi_sell") {
    // items may be an array or a count
    if (Array.isArray(args.items)) return args.items.length;
    const count = Number(args.item_count ?? args.count);
    return Number.isFinite(count) && count > 0 ? count : null;
  }
  if (toolName === "travel_to") {
    if (Array.isArray(args.waypoints)) return args.waypoints.length;
    const stops = Number(args.stops ?? args.hops);
    return Number.isFinite(stops) && stops > 0 ? stops : null;
  }
  return null;
}

/**
 * Best-effort parsing of a completion summary from the result_summary.
 * Returns null when nothing useful can be extracted.
 */
function getCompletionSummary(toolName: string, resultSummary: string | null): string | null {
  if (!resultSummary) return null;
  const result = parseJson<Record<string, unknown>>(resultSummary);
  if (!result) return null;

  try {
    if (toolName === "batch_mine") {
      const units = Number(result.total_mined ?? result.units_mined ?? result.amount);
      const durationMs = Number(result.duration_ms ?? result.elapsed_ms);
      if (Number.isFinite(units) && units > 0) {
        const durStr = Number.isFinite(durationMs) && durationMs > 0
          ? ` in ${Math.round(durationMs / 1000)}s`
          : "";
        return `Mined ${units} units total${durStr}`;
      }
    }
    if (toolName === "multi_sell") {
      const items = Number(result.items_sold ?? result.sold_count ?? result.count);
      const credits = Number(result.total_credits ?? result.credits_earned ?? result.revenue);
      if (Number.isFinite(items) && items > 0) {
        const credStr = Number.isFinite(credits) && credits > 0
          ? ` for ${formatNumber(credits)} credits`
          : "";
        return `Sold ${items} item${items !== 1 ? "s" : ""}${credStr}`;
      }
    }
    if (toolName === "travel_to") {
      const dest = String(result.destination ?? result.arrived_at ?? result.system ?? "");
      const hops = Number(result.waypoints_used ?? result.hops ?? result.stops);
      if (dest) {
        const hopStr = Number.isFinite(hops) && hops > 0
          ? ` via ${hops} waypoint${hops !== 1 ? "s" : ""}`
          : "";
        return `Arrived at ${dest}${hopStr}`;
      }
    }
  } catch {
    // best-effort — fall through to null
  }
  return null;
}

function CompoundToolRow({
  record,
  agentName,
  isGroupExpanded,
  onToggle,
}: {
  record: ToolCallRecord;
  agentName: string;
  isGroupExpanded: boolean;
  onToggle: () => void;
}) {
  const [subCalls, setSubCalls] = useState<ToolCallRecord[]>([]);
  const [subLoaded, setSubLoaded] = useState(false);

  const theme = getCompoundTheme(record.tool_name);
  const description = COMPOUND_TOOL_DESCRIPTIONS[record.tool_name] ?? null;
  const total = getCompoundTotal(record.tool_name, record.args_summary);

  useEffect(() => {
    if (!isGroupExpanded || subLoaded) return;
    apiFetch<{ tool_calls: ToolCallRecord[] }>(
      `/tool-calls?agent=${encodeURIComponent(agentName)}&parent_id=${record.id}&limit=100`
    )
      .then(({ tool_calls }) => setSubCalls(tool_calls))
      .catch(() => { /* sub-call load failure is non-fatal */ })
      .finally(() => setSubLoaded(true));
  }, [isGroupExpanded, subLoaded, agentName, record.id]);

  const completionSummary = record.status !== "pending"
    ? (getCompletionSummary(record.tool_name, record.result_summary) ?? "Complete")
    : null;

  return (
    <div>
      {/* Header row */}
      <div
        onClick={onToggle}
        className={cn(
          "px-3 py-2 border-b border-border text-xs font-mono flex items-center gap-2",
          "cursor-pointer",
          theme.bg,
          theme.border,
          theme.hover,
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

        {/* Tool-specific icon */}
        {theme.icon && (
          <span className={cn("shrink-0", theme.nameCls)}>
            {theme.icon}
          </span>
        )}

        {/* Tool name */}
        <span className={cn("font-bold shrink-0", theme.nameCls)}>{record.tool_name}</span>

        {/* "compound" badge */}
        <span className={cn(
          "px-1.5 py-0.5 text-[9px] font-sans uppercase tracking-wider font-medium shrink-0",
          theme.badgeCls,
        )}>
          compound
        </span>



        {/* Progress indicator for pending tools */}
        {record.status === "pending" && total !== null && (
          <span className={cn(
            "px-1.5 py-0.5 text-[9px] font-sans font-medium shrink-0 text-info animate-pulse",
          )}>
            {subLoaded ? `${subCalls.length}/${total}` : `—/${total}`} ops
          </span>
        )}

        {/* Sub-call count hint when complete and collapsed */}
        {record.status !== "pending" && !isGroupExpanded && subLoaded && subCalls.length > 0 && (
          <span className="text-muted-foreground/50 text-[10px] shrink-0">
            {subCalls.length} sub-ops
          </span>
        )}

        {/* Description — shown when no sub-call count visible */}
        {description && !(!isGroupExpanded && subLoaded && subCalls.length > 0) && (
          <span className="text-muted-foreground/60 text-[10px] min-w-0 flex-1 truncate font-sans italic">
            {description}
          </span>
        )}

        {/* Args summary if no description */}
        {!description && record.args_summary && (
          <span className="text-muted-foreground min-w-0 flex-1 truncate">
            {record.args_summary}
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
          {/* Assistant reasoning (if present on the compound tool record itself) */}
          {record.assistant_text && (
            <div className="px-6 py-2 space-y-1 border-b border-border/30">
              <div className="text-[10px] uppercase tracking-wider text-primary/50">
                Assistant reasoning
              </div>
              <div className="whitespace-pre-wrap break-words text-foreground/60 italic leading-relaxed text-[10px]">
                {record.assistant_text}
              </div>
            </div>
          )}

          {/* Result summary */}
          {record.result_summary && (
            <div className="px-6 py-2 space-y-1 border-b border-border/30">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Result</div>
              <pre className="whitespace-pre-wrap break-all font-mono text-foreground/80 text-[10px]">
                {record.result_summary}
              </pre>
            </div>
          )}

          {/* Sub-calls with tree connector lines */}
          {!subLoaded && (
            <div className="px-6 py-2 text-[10px] text-muted-foreground italic">Loading sub-calls…</div>
          )}
          {subLoaded && subCalls.length === 0 && !record.assistant_text && !record.result_summary && (
            <div className="px-6 py-2 text-[10px] text-muted-foreground italic">
              No sub-calls recorded
            </div>
          )}
          {subLoaded && subCalls.length > 0 && (
            <>
              <div className="px-6 py-1 text-[9px] uppercase tracking-wider text-muted-foreground/40 font-sans border-b border-border/30">
                {subCalls.length} sub-operation{subCalls.length !== 1 ? 's' : ''}
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
                        !isLast && cn("border-l", theme.connectorCls),
                      )}
                    >
                      <span className="text-muted-foreground shrink-0 w-16">
                        {formatTime(sub.timestamp)}
                      </span>
                      <span className={cn("inline-block w-1.5 h-1.5 rounded-full shrink-0", statusDotClass(sub))} />
                      <span className="text-foreground/60">{sub.tool_name}</span>
                      {sub.args_summary && (
                        <span className="text-muted-foreground/60 min-w-0 flex-1">
                          {sub.args_summary}
                        </span>
                      )}
                      {sub.result_summary && (
                        <span className="text-muted-foreground/50 min-w-0 flex-1">
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

          {/* Completion summary */}
          {completionSummary !== null && (
            <div className={cn(
              "px-6 py-1.5 text-[9px] text-muted-foreground italic",
              "border-t border-border/50 mt-1 pt-1",
            )}>
              {completionSummary}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ToolCallFeed
// ---------------------------------------------------------------------------

export function ToolCallFeed({ agentName }: { agentName: string }) {
  const [entries, setEntries] = useState<ToolCallRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<FilterId>("all");
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set());
  const [turnCosts, setTurnCosts] = useState<TurnCost[]>([]);
  const [shownCostTurns, setShownCostTurns] = useState<Set<number>>(new Set());

  // Turn history navigation (#224)
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [totalLoaded, setTotalLoaded] = useState(0);
  const [isLive, setIsLive] = useState(true);

  // SSE for real-time updates — listen for 'tool_call' events (array of records)
  const sseUrl = `/api/tool-calls/stream?agent=${encodeURIComponent(agentName)}`;
  const { data: sseData, connected, error: sseError } = useSSE<ToolCallRecord[]>(sseUrl, "tool_call");

  // Fetch turn costs for cost badges (#329)
  useEffect(() => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // Last 24 hours
    apiFetch<{ turns: TurnCost[] }>(
      `/tool-calls/turn-costs?agent=${encodeURIComponent(agentName)}&since=${encodeURIComponent(since)}`
    )
      .then(({ turns }) => setTurnCosts(turns ?? []))
      .catch((err) => {
        // Log but don't fail — turn costs are optional
        console.warn('[ToolCallFeed] Failed to load turn costs:', err);
      });
  }, [agentName]);

  // Initial load and page changes from REST endpoint
  useEffect(() => {
    setLoading(true);
    setError(null);
    if (page === 0) {
      setEntries([]);
    }
    const offset = page * PAGE_SIZE;
    apiFetch<{ tool_calls: ToolCallRecord[] }>(
      `/tool-calls?agent=${encodeURIComponent(agentName)}&limit=${PAGE_SIZE}&offset=${offset}`
    )
      .then(({ tool_calls }) => {
        // Sort by timestamp so thinking entries interleave with tool calls (#513)
        setEntries(sortByTimestamp(tool_calls));
        setHasMore(tool_calls.length === PAGE_SIZE);
        setTotalLoaded(offset + tool_calls.length);
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        setError(`Failed to load tool calls: ${msg}`);
        console.error('[ToolCallFeed] API error:', err);
      })
      .finally(() => setLoading(false));
  }, [agentName, page]);

  // Merge SSE events only when on page 0 (live view)
  useEffect(() => {
    if (!sseData || !Array.isArray(sseData) || sseData.length === 0) return;
    if (page !== 0 || !isLive) return;
    setEntries((prev) => {
      const updated = [...prev];
      let changed = false;
      for (const record of sseData) {
        const existingIdx = updated.findIndex((r) => r.id === record.id);
        if (existingIdx >= 0) {
          // Update existing (e.g. pending -> complete)
          updated[existingIdx] = record;
          changed = true;
        } else {
          // New record -- prepend
          updated.unshift(record);
          changed = true;
        }
      }
      if (!changed) return prev;
      const trimmed = updated.length > MAX_ENTRIES ? updated.slice(0, MAX_ENTRIES) : updated;
      return sortByTimestamp(trimmed);
    });
  }, [sseData, page, isLive]);

  // Toggle row expansion
  function toggleExpand(id: number) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  // Toggle group expansion (#225)
  function toggleGroupExpand(groupId: number) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }

  // Navigate pages (#224)
  function goNewer() {
    if (page > 0) {
      setPage(page - 1);
      if (page - 1 === 0) setIsLive(true);
    }
  }

  function goOlder() {
    if (hasMore) {
      setPage(page + 1);
      setIsLive(false);
    }
  }

  function goToLive() {
    setPage(0);
    setIsLive(true);
  }

  // For "all" filter, show ws: events but deduplicated; for category filters, no ws events
  const filteredEntries = activeFilter === "all"
    ? entries // deduplication handles ws: events
    : entries.filter((r) => matchesFilter(r, activeFilter));

  // Apply ws: deduplication for "all" view; straight pass-through for category views
  const baseDisplayEntries: DisplayRecord[] = activeFilter === "all"
    ? deduplicateWsEvents(filteredEntries)
    : filteredEntries.map((r) => ({ record: r, count: 1, groupRecords: [r], lastTimestamp: r.timestamp }));

  // Group execute_routine parents with their routine:* sub-calls by trace_id
  const displayEntries: DisplayRecord[] = groupRoutineCalls(baseDisplayEntries);

  return (
    <div className="bg-card border border-border">
      {/* Header: filters + connection status */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border">
        <div className="flex items-center gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setActiveFilter(f.id)}
              className={cn(
                "px-2 py-1 text-[10px] uppercase tracking-wider cursor-pointer transition-colors",
                activeFilter === f.id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <span
            className={cn(
              "inline-block w-1.5 h-1.5 rounded-full",
              connected ? "bg-success" : "bg-error"
            )}
          />
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
            {connected ? "live" : "offline"}
          </span>
        </div>
      </div>

      {/* Turn history navigation bar (#224) */}
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border bg-secondary/20">
        <div className="flex items-center gap-1.5">
          <button
            onClick={goNewer}
            disabled={page === 0}
            className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
            title="Newer"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
          <span className="text-[10px] text-muted-foreground tabular-nums min-w-[80px] text-center">
            {page === 0 && isLive ? (
              <span className="text-success">Latest</span>
            ) : (
              <>Page {page + 1}</>
            )}
          </span>
          <button
            onClick={goOlder}
            disabled={!hasMore}
            className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
            title="Older"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>

        {page > 0 && (
          <button
            onClick={goToLive}
            className="text-[10px] px-2 py-0.5 bg-success/20 text-success hover:bg-success/30 transition-colors uppercase tracking-wider"
          >
            Back to live
          </button>
        )}
      </div>

      {/* SSE error */}
      {sseError && (
        <div className="px-3 py-1.5 text-[10px] text-warning bg-warning/10 border-b border-border">
          {sseError}
        </div>
      )}

      {/* API error */}
      {error && (
        <div className="px-3 py-1.5 text-[10px] text-error bg-error/10 border-b border-border">
          {error}
        </div>
      )}

      {/* Feed body */}
      <div className="max-h-[calc(100vh-300px)] overflow-y-auto">
        {loading && (
          <div className="px-3 py-8 text-center text-xs text-muted-foreground italic">
            Loading…
          </div>
        )}

        {!loading && !error && displayEntries.length === 0 && (
          <div className="px-3 py-8 text-center text-xs text-muted-foreground italic">
            No tool calls recorded
          </div>
        )}

        {displayEntries.map(({ record, count, groupRecords, lastTimestamp, isRoutineGroup }) => {
          // Assistant text records get their own distinct rendering (#300)
          if (isAssistantText(record)) {
            return <AssistantTextRow key={record.id} record={record} />;
          }

          // Extended reasoning blocks get collapsible rendering with indigo styling
          if (isReasoning(record)) {
            return <ReasoningRow key={record.id} record={record} />;
          }

          // Routine groups get distinct rendering with badges and expandable sub-calls
          if (isRoutineGroup) {
            return (
              <RoutineGroupRow
                key={record.id}
                record={record}
                count={count}
                groupRecords={groupRecords}
                isGroupExpanded={expandedGroups.has(record.id)}
                onToggle={() => toggleGroupExpand(record.id)}
              />
            );
          }

          // PrayerLang scripts get violet-themed row with script/diff/subcall detail.
          // Grouped pray rows (count > 1) keep the violet theme + script preview;
          // PrayerRow renders a "Nx" badge next to the tool name in that case.
          if (record.tool_name === "pray") {
            return (
              <PrayerRow
                key={record.id}
                record={record}
                agentName={agentName}
                isGroupExpanded={expandedGroups.has(record.id)}
                onToggle={() => toggleGroupExpand(record.id)}
                count={count}
              />
            );
          }

          // Compound tools get blue-tinted row with description and expandable sub-calls
          if (isCompoundTool(record) && count === 1) {
            return (
              <CompoundToolRow
                key={record.id}
                record={record}
                agentName={agentName}
                isGroupExpanded={expandedGroups.has(record.id)}
                onToggle={() => toggleGroupExpand(record.id)}
              />
            );
          }

          const isExpanded = expandedIds.has(record.id);
          const isCollapsedGroup = count > 1;
          const isGroupExpanded = expandedGroups.has(record.id);
          return (
            <div key={record.id}>
              {/* Row */}
              <div
                onClick={() => isCollapsedGroup ? toggleGroupExpand(record.id) : toggleExpand(record.id)}
                className={cn(
                  "px-3 py-2 border-b border-border text-xs font-mono flex items-center gap-2",
                  isCollapsedGroup
                    ? "text-muted-foreground/60 border-l-2 border-l-muted-foreground/30 hover:bg-primary/5 cursor-pointer"
                    : cn(
                        "hover:bg-primary/5 cursor-pointer",
                        rowBorderClass(record),
                        !record.success && "bg-error/5"
                      )
                )}
              >
                {/* Timestamp */}
                <span className="text-muted-foreground shrink-0 w-16">
                  {formatTime(record.timestamp)}
                </span>

                {/* Status dot */}
                {!isCollapsedGroup && (
                  <span
                    className={cn(
                      "inline-block w-1.5 h-1.5 rounded-full shrink-0",
                      statusDotClass(record)
                    )}
                  />
                )}

                {/* Expand/collapse icon for groups (#225) */}
                {isCollapsedGroup && (
                  <span className="shrink-0">
                    {isGroupExpanded
                      ? <ChevronUp className="w-3 h-3 text-muted-foreground/50" />
                      : <ChevronDown className="w-3 h-3 text-muted-foreground/50" />
                    }
                  </span>
                )}

                {/* Tool name */}
                <span className={cn("font-bold shrink-0", isCollapsedGroup ? "text-muted-foreground/60" : "text-foreground")}>
                  {record.tool_name}
                  {isCollapsedGroup && (
                    <span className="ml-1 font-normal text-muted-foreground/50">{count}x</span>
                  )}
                </span>

                {/* Args summary — show full text (#226) */}
                {!isCollapsedGroup && record.args_summary && (
                  <span className="text-muted-foreground min-w-0 flex-1">
                    {record.args_summary}
                  </span>
                )}

                {/* Result summary inline (#226) */}
                {!isCollapsedGroup && record.result_summary && !isExpanded && (
                  <span className={cn(
                    "min-w-0 flex-1",
                    record.success ? "text-muted-foreground" : "text-error/80"
                  )}>
                    {record.result_summary}
                  </span>
                )}

                {/* Time range for collapsed groups */}
                {isCollapsedGroup && (
                  <span className="text-muted-foreground/40 text-[10px] ml-auto shrink-0">
                    …{formatTime(lastTimestamp)}
                  </span>
                )}

                {/* Cost badge — show only on first tool call of turn (#329) */}
                {!isCollapsedGroup && (() => {
                  const turn = findTurnForToolCall(record, turnCosts);
                  if (!turn || shownCostTurns.has(turn.turnNumber)) return null;

                  const costBadge = formatCostBadge(turn.costUsd, turn.inputTokens, turn.outputTokens);
                  if (!costBadge) return null;

                  // Mark this turn as shown
                  setShownCostTurns(prev => new Set([...prev, turn.turnNumber]));

                  return (
                    <span className="text-muted-foreground/60 text-[9px] shrink-0 px-2 py-0.5 rounded bg-secondary/30">
                      {costBadge}
                    </span>
                  );
                })()}

                {/* Duration */}
                {!isCollapsedGroup && record.status === "pending" ? (
                  <span className="text-info shrink-0 text-right w-16">
                    <ElapsedTimer since={record.timestamp} />
                  </span>
                ) : !isCollapsedGroup && record.duration_ms !== null ? (
                  <span className="text-muted-foreground shrink-0 text-right w-16">
                    {record.duration_ms}ms
                  </span>
                ) : null}
              </div>

              {/* Expanded details for individual records */}
              {isExpanded && !isCollapsedGroup && (
                <div className="bg-background p-3 text-xs border-b border-border space-y-2">
                  {record.args_summary && (
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                        Args
                      </div>
                      <pre className="whitespace-pre-wrap break-all font-mono text-foreground/80">
                        {record.args_summary}
                      </pre>
                    </div>
                  )}
                  {record.result_summary && (
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                        Result
                      </div>
                      <pre className="whitespace-pre-wrap break-all font-mono text-foreground/80">
                        {record.result_summary}
                      </pre>
                    </div>
                  )}
                  {record.assistant_text && (
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-primary/50 mb-1">
                        Assistant reasoning
                      </div>
                      <div className="whitespace-pre-wrap break-words text-foreground/60 italic leading-relaxed">
                        {record.assistant_text}
                      </div>
                    </div>
                  )}
                  {record.error_code && (
                    <div className="text-error text-[10px] uppercase tracking-wider">
                      Error: {record.error_code}
                    </div>
                  )}
                  {!record.args_summary && !record.result_summary && !record.error_code && !record.assistant_text && (
                    <span className="text-muted-foreground italic">No details available</span>
                  )}
                </div>
              )}

              {/* Expanded group records (#225) */}
              {isCollapsedGroup && isGroupExpanded && (
                <div className="bg-background/50 border-b border-border">
                  {groupRecords.map((gr) => (
                    <div
                      key={gr.id}
                      className="px-6 py-1.5 text-[10px] font-mono flex items-center gap-2 border-b border-border/30 last:border-b-0"
                    >
                      <span className="text-muted-foreground shrink-0 w-16">
                        {formatTime(gr.timestamp)}
                      </span>
                      <span
                        className={cn(
                          "inline-block w-1.5 h-1.5 rounded-full shrink-0",
                          statusDotClass(gr)
                        )}
                      />
                      <span className="text-foreground/60">{gr.tool_name}</span>
                      {gr.args_summary && (
                        <span className="text-muted-foreground/60 min-w-0 flex-1">
                          {gr.args_summary}
                        </span>
                      )}
                      {gr.result_summary && (
                        <span className="text-muted-foreground/60 min-w-0 flex-1">
                          {gr.result_summary}
                        </span>
                      )}
                      {gr.duration_ms !== null && (
                        <span className="text-muted-foreground/50 shrink-0 w-14 text-right">
                          {gr.duration_ms}ms
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
