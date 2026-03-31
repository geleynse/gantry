"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { AGENT_COLORS, AGENT_NAMES } from "@/lib/utils";
import { useSSE } from "@/hooks/use-sse";
import { apiFetch } from "@/lib/api";
import { formatTime } from "@/lib/time";
import { Pause, Play } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActivityEvent {
  id: number;
  agent: string;
  tool_name: string;
  params_summary: string | null;
  result_summary: string | null;
  status: string; // 'pending' | 'complete' | 'error'
  timestamp: string;
  duration_ms: number | null;
  is_compound?: boolean;
  trace_id?: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_EVENTS = 200;

/** Tool categories for type-filter chips */
type ToolFilter = "all" | "actions" | "queries" | "routines" | "text";

const TOOL_FILTERS: { id: ToolFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "actions", label: "Actions" },
  { id: "queries", label: "Queries" },
  { id: "routines", label: "Routines" },
  { id: "text", label: "Text" },
];

/** Status filter */
type StatusFilter = "all" | "success" | "error" | "pending";

const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "success", label: "Success" },
  { id: "error", label: "Error" },
  { id: "pending", label: "Pending" },
];

// State-changing (write) actions — classified as "actions"
const ACTION_TOOLS = new Set([
  "jump", "travel", "travel_to", "jump_route", "attack", "flee", "loot_wrecks",
  "scan_and_attack", "batch_mine", "mine", "multi_sell", "sell", "buy",
  "dock", "undock", "repair", "refuel", "craft", "deposit_items", "withdraw_items",
  "create_sell_order", "cancel_order", "jettison", "self_destruct", "logout", "login",
]);

// Read-only query tools — classified as "queries"
const QUERY_TOOLS = new Set([
  "get_status", "get_location", "get_system", "get_ship", "get_skills",
  "get_missions", "get_map", "scan_local", "get_poi", "find_route", "find_local_route",
  "analyze_market", "view_market", "view_storage", "get_notifications",
  "get_global_market", "list_agents", "get_inventory",
]);

function classifyTool(toolName: string): Exclude<ToolFilter, "all"> {
  // Text events
  if (toolName === "__assistant_text" || toolName === "__reasoning") return "text";

  // Routine sub-calls and execute_routine
  if (toolName.startsWith("routine:") || toolName === "execute_routine") return "routines";

  // WS events — treat as queries
  if (toolName.startsWith("ws:")) return "queries";

  const base = toolName.toLowerCase();
  if (ACTION_TOOLS.has(base)) return "actions";
  if (QUERY_TOOLS.has(base)) return "queries";

  // spacemolt compound dispatch
  if (base === "spacemolt") return "actions";

  return "actions"; // default unknown tools to actions
}

function matchesToolFilter(ev: ActivityEvent, filter: ToolFilter): boolean {
  if (filter === "all") return true;
  return classifyTool(ev.tool_name) === filter;
}

function matchesStatusFilter(ev: ActivityEvent, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "success") return ev.status === "complete";
  if (filter === "error") return ev.status === "error";
  if (filter === "pending") return ev.status === "pending";
  return true;
}

// ---------------------------------------------------------------------------
// Sort helper
// ---------------------------------------------------------------------------

function sortByTimestamp(events: ActivityEvent[]): ActivityEvent[] {
  return [...events].sort((a, b) => {
    const ta = new Date(a.timestamp).getTime();
    const tb = new Date(b.timestamp).getTime();
    if (ta !== tb) return tb - ta;
    return b.id - a.id;
  });
}

// ---------------------------------------------------------------------------
// Row styling helpers
// ---------------------------------------------------------------------------

function rowBorderClass(ev: ActivityEvent): string {
  if (ev.status === "pending") return "border-l-2 border-l-info animate-pulse";
  if (ev.status === "error") return "border-l-2 border-l-error";
  return "border-l-2 border-l-success";
}

function statusDotClass(ev: ActivityEvent): string {
  if (ev.status === "pending") return "bg-info animate-pulse";
  if (ev.status === "error") return "bg-error";
  return "bg-success";
}

// ---------------------------------------------------------------------------
// ElapsedTimer — shows running duration for pending events
// ---------------------------------------------------------------------------

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
// ThreeDotLoader — SSE connecting indicator
// ---------------------------------------------------------------------------

function ThreeDotLoader() {
  return (
    <div className="flex items-center gap-1 px-3 py-8 justify-center">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="inline-block w-1.5 h-1.5 bg-muted-foreground rounded-full"
          style={{ animation: `bounce-dot 1.2s infinite ${i * 0.2}s` }}
        />
      ))}
      <style>{`
        @keyframes bounce-dot {
          0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
          40% { transform: translateY(-6px); opacity: 1; }
        }
      `}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ActivityRow — single event row
// ---------------------------------------------------------------------------

function ActivityRow({
  event,
  onAgentClick,
}: {
  event: ActivityEvent;
  onAgentClick: (agent: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const agentColor = AGENT_COLORS[event.agent] ?? "#888";

  // Text/reasoning special display
  const isAssistantText = event.tool_name === "__assistant_text";
  const isReasoning = event.tool_name === "__reasoning";

  // Routine detection & extraction
  const isRoutineSubCall = event.tool_name.startsWith("routine:");
  const isExecuteRoutine = event.tool_name === "execute_routine";
  const isRoutine = isRoutineSubCall || isExecuteRoutine;

  let routineName = "";
  let displayToolName = event.tool_name;

  if (isAssistantText) {
    displayToolName = "text";
  } else if (isReasoning) {
    displayToolName = "reasoning";
  } else if (isRoutineSubCall) {
    const parts = event.tool_name.split(":");
    routineName = parts[1];
    displayToolName = parts[parts.length - 1];
  } else if (isExecuteRoutine) {
    try {
      const params = JSON.parse(event.params_summary || "{}");
      routineName = params.routine || "";
    } catch {
      // Fallback
    }
  }

  return (
    <div className={cn("border-b border-border", !event.result_summary && !event.params_summary && "opacity-80")}>
      {/* Main row */}
      <div
        onClick={() => setExpanded((x) => !x)}
        className={cn(
          "px-3 py-1.5 text-xs font-mono flex items-center gap-2 hover:bg-primary/5 cursor-pointer",
          rowBorderClass(event),
          event.status === "error" && "bg-error/5",
          (isAssistantText || isReasoning) && "opacity-70 italic",
        )}
      >
        {/* Timestamp */}
        <span className="text-muted-foreground shrink-0 w-16 tabular-nums">
          {formatTime(event.timestamp)}
        </span>

        {/* Status dot */}
        <span className={cn("inline-block w-1.5 h-1.5 rounded-full shrink-0", statusDotClass(event))} />

        {/* Agent name — color-coded, links to agent detail */}
        <Link
          href={`/agent/${event.agent}`}
          onClick={(e) => {
            e.stopPropagation();
            onAgentClick(event.agent);
          }}
          className="shrink-0 text-[10px] uppercase tracking-wider font-sans px-1.5 py-0.5 hover:opacity-80 transition-opacity"
          style={{ color: agentColor, backgroundColor: `${agentColor}22` }}
        >
          {event.agent}
        </Link>

        {/* Routine badge */}
        {isRoutine && (
          <span className="shrink-0 text-[9px] uppercase font-sans font-bold px-1 bg-warning/20 text-warning border border-warning/30" title={routineName}>
            Routine
          </span>
        )}

        {/* Routine name (if subcall) */}
        {isRoutineSubCall && routineName && (
          <span className="shrink-0 text-muted-foreground/60 italic">
            {routineName}:
          </span>
        )}

        {/* Text/reasoning badge */}
        {(isAssistantText || isReasoning) && (
          <span className="shrink-0 text-[9px] uppercase font-sans px-1 bg-muted/30 text-muted-foreground border border-border">
            {isReasoning ? "reasoning" : "text"}
          </span>
        )}

        {/* Tool name */}
        <span className={cn(
          "font-bold shrink-0",
          isExecuteRoutine ? "text-warning" : "text-foreground",
          (isAssistantText || isReasoning) && "text-muted-foreground font-normal",
        )}>
          {displayToolName}
        </span>

        {/* Result summary inline */}
        {event.result_summary && !expanded && (
          <span className={cn(
            "min-w-0 flex-1 truncate text-muted-foreground",
            event.status === "error" && "text-error/80",
          )}>
            {event.result_summary}
          </span>
        )}

        {/* Duration or elapsed timer */}
        {event.status === "pending" ? (
          <span className="text-info shrink-0 text-right w-14">
            <ElapsedTimer since={event.timestamp} />
          </span>
        ) : event.duration_ms != null && event.duration_ms > 0 ? (
          <span className="text-muted-foreground shrink-0 text-right w-14">
            {event.duration_ms}ms
          </span>
        ) : null}
      </div>

      {/* Expanded detail panel */}
      {expanded && (
        <div className="bg-background p-3 text-xs border-b border-border space-y-2 font-mono">
          {event.params_summary && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Params</div>
              <pre className="whitespace-pre-wrap break-all text-foreground/80">{event.params_summary}</pre>
            </div>
          )}
          {event.result_summary && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Result</div>
              <pre className="whitespace-pre-wrap break-all text-foreground/80">{event.result_summary}</pre>
            </div>
          )}
          {!event.params_summary && !event.result_summary && (
            <span className="text-muted-foreground italic">No details available</span>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ActivityFeed — main component
// ---------------------------------------------------------------------------

export function ActivityFeed() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [sseConnecting, setSseConnecting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [activeToolFilter, setActiveToolFilter] = useState<ToolFilter>("all");
  const [activeStatusFilter, setActiveStatusFilter] = useState<StatusFilter>("all");
  const [hasNewEvents, setHasNewEvents] = useState(false);

  // Throughput tracking — events per second over a rolling window
  const [throughput, setThroughput] = useState<string | null>(null);
  const eventTimesRef = useRef<number[]>([]);

  // Agent filter toggles — all on by default
  const [agentToggles, setAgentToggles] = useState<Record<string, boolean>>(
    () => Object.fromEntries(AGENT_NAMES.map((n) => [n, true])),
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtTopRef = useRef(true);

  // SSE connection for real-time updates (all agents — no agent filter on the stream URL)
  const sseUrl = `/api/activity/stream`;
  const { data: sseData, connected, error: sseError } = useSSE<ActivityEvent[]>(sseUrl, "activity");

  // Track when SSE first connects
  useEffect(() => {
    if (connected) setSseConnecting(false);
  }, [connected]);

  // Initial load from REST
  useEffect(() => {
    setLoading(true);
    apiFetch<{ events: ActivityEvent[]; count: number }>("/activity/feed")
      .then(({ events: loaded }) => {
        setEvents(sortByTimestamp(loaded));
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        setError(`Failed to load activity: ${msg}`);
      })
      .finally(() => setLoading(false));
  }, []);

  // Track scroll position to know if user is at top
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      isAtTopRef.current = el.scrollTop < 40;
      if (isAtTopRef.current) setHasNewEvents(false);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Merge incoming SSE events (skip when paused)
  useEffect(() => {
    if (!sseData || !Array.isArray(sseData) || sseData.length === 0) return;

    // Track throughput (record arrival times)
    const now = Date.now();
    eventTimesRef.current.push(now);
    // Keep only last 60s
    eventTimesRef.current = eventTimesRef.current.filter((t) => now - t < 60_000);
    const rate = eventTimesRef.current.length / 60;
    setThroughput(rate < 0.1 ? null : rate >= 1 ? `~${Math.round(rate)}/s` : `~${(rate * 60).toFixed(0)}/min`);

    if (paused) return;

    setEvents((prev) => {
      const updated = [...prev];
      let changed = false;
      for (const record of sseData) {
        const existingIdx = updated.findIndex((r) => r.id === record.id);
        if (existingIdx >= 0) {
          updated[existingIdx] = record;
          changed = true;
        } else {
          updated.unshift(record);
          changed = true;
        }
      }
      if (!changed) return prev;
      const trimmed = updated.length > MAX_EVENTS ? updated.slice(0, MAX_EVENTS) : updated;
      return sortByTimestamp(trimmed);
    });

    // Show "New events" badge if user has scrolled away from top
    if (!isAtTopRef.current) {
      setHasNewEvents(true);
    }
  }, [sseData, paused]);

  // Auto-scroll to top (newest) when not paused and user is already at top
  useEffect(() => {
    if (!paused && isAtTopRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [events, paused]);

  // Flash page title on error events
  useEffect(() => {
    if (!sseData || !Array.isArray(sseData)) return;
    const hasError = sseData.some((ev) => ev.status === "error");
    if (!hasError) return;
    const originalTitle = document.title;
    document.title = "\u26a0 Error \u2014 GANTRY";
    const tid = setTimeout(() => { document.title = originalTitle; }, 3000);
    return () => clearTimeout(tid);
  }, [sseData]);

  const toggleAgent = useCallback((name: string) => {
    setAgentToggles((prev) => ({ ...prev, [name]: !prev[name] }));
  }, []);

  const scrollToTop = useCallback(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setHasNewEvents(false);
  }, []);

  // Apply filters
  const visibleEvents = events.filter(
    (ev) =>
      agentToggles[ev.agent] !== false &&
      matchesToolFilter(ev, activeToolFilter) &&
      matchesStatusFilter(ev, activeStatusFilter),
  );

  const isConnecting = sseConnecting && !connected;

  return (
    <div className="bg-card border border-border flex flex-col h-[calc(100vh-200px)]">
      {/* Header: tool type + status filters + pause + connection */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border shrink-0 flex-wrap gap-y-1.5">
        {/* Filter chips */}
        <div className="flex items-center gap-1 flex-wrap">
          {TOOL_FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setActiveToolFilter(f.id)}
              className={cn(
                "px-2 py-1 text-[10px] uppercase tracking-wider transition-colors",
                activeToolFilter === f.id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {f.label}
            </button>
          ))}

          <span className="text-border mx-0.5 text-xs select-none">|</span>

          {STATUS_FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setActiveStatusFilter(f.id)}
              className={cn(
                "px-2 py-1 text-[10px] uppercase tracking-wider transition-colors",
                activeStatusFilter === f.id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Connection status + throughput + pause */}
        <div className="flex items-center gap-2 shrink-0">
          {throughput && connected && (
            <span className="text-[9px] text-muted-foreground tabular-nums">{throughput}</span>
          )}

          <button
            onClick={() => setPaused((p) => !p)}
            title={paused ? "Resume auto-scroll" : "Pause auto-scroll"}
            className={cn(
              "inline-flex items-center gap-1 px-2 py-1 text-[10px] uppercase tracking-wider border transition-colors",
              paused
                ? "text-warning border-warning/30 hover:bg-warning/10"
                : "text-muted-foreground border-border hover:text-foreground",
            )}
          >
            {paused ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
            {paused ? "Resume" : "Pause"}
          </button>

          {/* Live indicator */}
          <div className="flex items-center gap-1">
            <span
              className={cn(
                "inline-block w-1.5 h-1.5 rounded-full",
                connected ? "bg-success animate-pulse" : "bg-error",
              )}
            />
            <span
              className={cn(
                "text-[9px] uppercase tracking-wider font-bold",
                connected ? "text-success" : "text-error",
              )}
            >
              {connected ? "LIVE" : "DISCONNECTED"}
            </span>
          </div>
        </div>
      </div>

      {/* Agent toggle chips */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border shrink-0 flex-wrap">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground mr-1">Agents:</span>
        {AGENT_NAMES.map((name) => {
          const color = AGENT_COLORS[name] ?? "#888";
          const on = agentToggles[name] !== false;
          return (
            <button
              key={name}
              onClick={() => toggleAgent(name)}
              className={cn(
                "px-2 py-0.5 text-[10px] uppercase tracking-wider border transition-all",
                on ? "opacity-100" : "opacity-30 grayscale",
              )}
              style={{
                color: on ? color : undefined,
                borderColor: on ? `${color}66` : undefined,
                backgroundColor: on ? `${color}11` : undefined,
              }}
              title={`Toggle ${name}`}
            >
              {name}
            </button>
          );
        })}
      </div>

      {/* SSE error banner */}
      {sseError && (
        <div className="px-3 py-1.5 text-[10px] text-warning bg-warning/10 border-b border-border shrink-0">
          {sseError}
        </div>
      )}

      {/* API error */}
      {error && (
        <div className="px-3 py-1.5 text-[10px] text-error bg-error/10 border-b border-border shrink-0">
          {error}
        </div>
      )}

      {/* Feed body */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto relative">
        {/* "New events" scroll-to-top badge */}
        {hasNewEvents && (
          <div className="sticky top-0 z-10 flex justify-center py-1 pointer-events-none">
            <button
              onClick={scrollToTop}
              className="pointer-events-auto inline-flex items-center gap-1 px-3 py-1 bg-primary text-primary-foreground text-[10px] uppercase tracking-wider shadow-lg"
            >
              New events \u2014 scroll to top
            </button>
          </div>
        )}

        {/* Three-dot connecting indicator */}
        {isConnecting && (loading || events.length === 0) && <ThreeDotLoader />}

        {loading && !isConnecting && (
          <div className="px-3 py-8 text-center text-xs text-muted-foreground italic">
            Loading\u2026
          </div>
        )}

        {!loading && !error && visibleEvents.length === 0 && (
          <div className="px-3 py-8 text-center text-xs text-muted-foreground italic">
            No activity yet
          </div>
        )}

        {visibleEvents.map((ev) => (
          <ActivityRow
            key={ev.id}
            event={ev}
            onAgentClick={toggleAgent}
          />
        ))}
      </div>

      {/* Footer: event count */}
      <div className="px-3 py-1.5 border-t border-border shrink-0 text-[10px] text-muted-foreground flex items-center gap-2">
        <span>{visibleEvents.length} event{visibleEvents.length !== 1 ? "s" : ""} shown</span>
        {paused && (
          <span className="text-warning uppercase tracking-wider">\u2014 paused</span>
        )}
      </div>
    </div>
  );
}
