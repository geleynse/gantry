"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiFetch, isApiError } from "@/lib/api";
import { formatAbsolute, relativeTime } from "@/lib/time";
import { computeCost } from "@/lib/model-pricing";

interface SessionSummary {
  id: string;
  createdAt: number;
  updatedAt: number;
  firstMessage?: string;
  firstAssistantText?: string | null;
  hasSubagents?: boolean;
  messageCount?: number;
  isOngoing?: boolean;
  gitBranch?: string;
  contextConsumption?: number;
}

interface SessionListResponse {
  sessions: SessionSummary[];
  nextCursor: string | null;
  hasMore: boolean;
  scanned: number;
}

interface SessionMessage {
  uuid: string;
  parentUuid: string | null;
  type: string;
  timestamp: string;
  role: string;
  content: unknown;
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  toolCalls?: Array<{ id?: string; name?: string; input?: unknown }>;
  toolResults?: Array<{ tool_use_id?: string; content?: unknown; is_error?: boolean }>;
  isSidechain?: boolean;
  isMeta?: boolean;
}

interface SessionDetail {
  session: SessionSummary;
  messages: SessionMessage[];
  metrics?: {
    durationMs?: number;
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    messageCount?: number;
  };
}

const PAGE_SIZE = 20;

function stripLogin(firstMessage: string | undefined): string {
  if (!firstMessage) return "";
  // The turn-specific prompt always sits at the bottom of the LOGIN payload;
  // the system-prompt boilerplate above it is the same on every turn and
  // useless as a preview. Take the last non-empty paragraph instead of trying
  // to enumerate every header marker the boilerplate uses.
  const paragraphs = firstMessage
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const last = paragraphs[paragraphs.length - 1] ?? firstMessage;
  return last.replace(/\s+/g, " ").slice(0, 220);
}

function formatTokens(n: number | undefined): string {
  if (!n) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1) + "k";
  return (n / 1_000_000).toFixed(2) + "M";
}

function formatDuration(ms: number | undefined): string {
  if (!ms || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function messageContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) return String((part as { text: unknown }).text ?? "");
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function MessageRow({ msg, toolCallsOpen }: { msg: SessionMessage; toolCallsOpen: boolean }) {
  const text = messageContentToText(msg.content);
  const isUser = msg.role === "user";
  const tools = msg.toolCalls ?? [];
  const results = msg.toolResults ?? [];

  // Skip rows that contain only tool plumbing with no human-visible content
  if (!text && tools.length === 0 && results.length === 0) return null;

  return (
    // Task C: per-message anchor — #sessions/<sid>/msg/<uuid> fragments scroll here
    <div
      id={`msg-${msg.uuid}`}
      className={cn(
        "border-l-2 pl-3 py-2 text-xs",
        isUser
          ? "border-l-info/50 bg-info/5"
          : msg.role === "assistant"
            ? "border-l-primary/50 bg-primary/5"
            : "border-l-muted-foreground/30",
      )}
    >
      <div className="flex items-center gap-2 mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        <span className={cn("font-semibold", isUser ? "text-info" : "text-primary")}>
          {msg.role}
        </span>
        <span className="opacity-70">{formatAbsolute(msg.timestamp)}</span>
        {msg.model && <span className="opacity-70">{msg.model}</span>}
        {msg.isSidechain && <span className="text-warning opacity-80">sidechain</span>}
        {msg.isMeta && <span className="opacity-50">meta</span>}
      </div>
      {text && (
        <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/90 max-h-72 overflow-auto">
          {text}
        </pre>
      )}
      {tools.length > 0 && (
        <div className="mt-1 space-y-1">
          {tools.map((t, i) => (
            <details key={t.id ?? i} open={toolCallsOpen} className="text-[10px] text-muted-foreground">
              <summary className="cursor-pointer hover:text-foreground">
                <span className="text-warning">→ {t.name ?? "tool"}</span>
              </summary>
              <pre className="ml-3 mt-1 whitespace-pre-wrap break-words text-[10px] opacity-80 max-h-48 overflow-auto">
                {JSON.stringify(t.input, null, 2)}
              </pre>
            </details>
          ))}
        </div>
      )}
      {results.length > 0 && (
        <div className="mt-1 space-y-1">
          {results.map((r, i) => (
            <details key={r.tool_use_id ?? i} className="text-[10px] text-muted-foreground">
              <summary className={cn("cursor-pointer hover:text-foreground", r.is_error && "text-error")}>
                ← result{r.is_error ? " (error)" : ""}
              </summary>
              <pre className="ml-3 mt-1 whitespace-pre-wrap break-words text-[10px] opacity-80 max-h-48 overflow-auto">
                {messageContentToText(r.content) || JSON.stringify(r.content, null, 2)}
              </pre>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

function SessionDetailView({
  agentName,
  sessionId,
  session,
  onViewLogs,
  scrollToMsgUuid,
  onCostComputed,
}: {
  agentName: string;
  sessionId: string;
  /** Session summary from the list — has createdAt/updatedAt for log time window (Task A) */
  session?: SessionSummary;
  /** Called when user clicks "View logs" — navigate to Logs tab with time window (Task A) */
  onViewLogs?: (from: number, to: number) => void;
  /** If set, scroll this message UUID into view after detail loads (Task C) */
  scrollToMsgUuid?: string;
  /** Called with computed cost (or null) and durationMs once detail is loaded — used for page total + anomaly flags */
  onCostComputed?: (sessionId: string, cost: number | null, durationMs: number | undefined) => void;
}) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toolCallsOpen, setToolCallsOpen] = useState(true);
  const onCostComputedRef = useRef(onCostComputed);
  onCostComputedRef.current = onCostComputed;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<SessionDetail>(`/agents/${agentName}/sessions/${sessionId}`)
      .then((data) => {
        if (!cancelled) {
          setDetail(data);
          const m = data.metrics ?? {};
          const model = data.messages.find((msg) => msg.role === "assistant" && msg.model)?.model;
          onCostComputedRef.current?.(sessionId, computeCost(m, model), m.durationMs);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentName, sessionId]);

  // Task C: after detail loads, scroll to the target message if requested
  useEffect(() => {
    if (!detail || !scrollToMsgUuid) return;
    const el = document.getElementById(`msg-${scrollToMsgUuid}`);
    if (el) {
      // Small delay to ensure layout is complete
      setTimeout(() => el.scrollIntoView({ behavior: "smooth", block: "center" }), 80);
    }
  }, [detail, scrollToMsgUuid]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
        <Loader2 className="w-3 h-3 animate-spin" /> Loading transcript…
      </div>
    );
  }
  if (error) {
    return <div className="px-3 py-4 text-xs text-error">Failed to load: {error}</div>;
  }
  if (!detail) return null;

  const metrics = detail.metrics ?? {};
  // Prefer the passed session summary (has createdAt/updatedAt from the list) over detail.session
  const sessionData = session ?? detail.session;
  // Find the model from the first assistant message with a model field.
  const firstModel = detail.messages.find((m) => m.role === "assistant" && m.model)?.model;
  const sessionCost = computeCost(metrics, firstModel);

  return (
    <div className="bg-background/60 border-t border-border">
      <div className="flex flex-wrap items-center gap-4 px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border/50">
        <span>
          Msgs <span className="text-foreground font-mono normal-case">{metrics.messageCount ?? detail.messages.length}</span>
        </span>
        <span>
          Duration <span className="text-foreground font-mono normal-case">{formatDuration(metrics.durationMs)}</span>
        </span>
        <span>
          Input <span className="text-foreground font-mono normal-case">{formatTokens(metrics.inputTokens)}</span>
        </span>
        <span>
          Output <span className="text-foreground font-mono normal-case">{formatTokens(metrics.outputTokens)}</span>
        </span>
        <span>
          Cache R <span className="text-foreground font-mono normal-case">{formatTokens(metrics.cacheReadTokens)}</span>
        </span>
        <span>
          Cache W <span className="text-foreground font-mono normal-case">{formatTokens(metrics.cacheCreationTokens)}</span>
        </span>
        {sessionCost != null && (
          <span>
            Cost <span className="text-foreground font-mono normal-case">${sessionCost.toFixed(3)}</span>
          </span>
        )}
        {/* Task A: jump to Logs tab filtered to this session's time window */}
        {onViewLogs && (
          <button
            onClick={() => onViewLogs(sessionData.createdAt, sessionData.updatedAt)}
            className="text-[10px] normal-case text-info/80 hover:text-info transition-colors flex items-center gap-1 tracking-normal"
            title={`View logs from ${formatAbsolute(sessionData.createdAt)} to ${formatAbsolute(sessionData.updatedAt)}`}
          >
            📜 View logs (turn window)
          </button>
        )}
        <button
          onClick={() => setToolCallsOpen((v) => !v)}
          className="ml-auto text-[10px] text-muted-foreground hover:text-foreground transition-colors normal-case tracking-normal"
        >
          {toolCallsOpen ? "Collapse tools" : "Expand tools"}
        </button>
      </div>
      <div className="divide-y divide-border/30 max-h-[60vh] overflow-auto px-3 py-2 space-y-1">
        {detail.messages.map((m) => (
          <MessageRow key={m.uuid} msg={m} toolCallsOpen={toolCallsOpen} />
        ))}
      </div>
    </div>
  );
}

/** Parse session ID (and optional message UUID) from hash.
 *  Supported formats:
 *   - #sessions/<sessionId>            → expand that session
 *   - #sessions/<sessionId>/msg/<uuid> → expand session AND scroll to message (Task C)
 */
function parseSessionHash(): { sessionId: string | null; msgUuid: string | null } {
  if (typeof window === "undefined") return { sessionId: null, msgUuid: null };
  const hash = window.location.hash.slice(1); // strip #
  const parts = hash.split("/");
  if (parts[0] === "sessions" && parts[1] && parts[1].length > 8) {
    const sessionId = parts[1];
    // #sessions/<sid>/msg/<uuid>
    const msgUuid = parts[2] === "msg" && parts[3] ? parts[3] : null;
    return { sessionId, msgUuid };
  }
  return { sessionId: null, msgUuid: null };
}

function DevtoolsSetupCard({ url, reason, onRetry, retrying }: { url: string; reason: string; onRetry: () => void; retrying: boolean }) {
  return (
    <div className="border border-warning/40 bg-warning/5 px-4 py-5 space-y-3">
      <div className="text-sm font-medium text-warning">claude-devtools is not reachable</div>
      <div className="text-xs text-foreground/80 leading-relaxed space-y-2">
        <p>
          The Sessions panel reads transcripts from a local{" "}
          <a href="https://github.com/matt1398/claude-devtools" target="_blank" rel="noopener" className="text-info hover:underline">
            claude-devtools
          </a>{" "}
          server. Gantry expected it at{" "}
          <code className="bg-background/60 px-1 py-0.5 text-[10px] font-mono">{url}</code> but the request failed:
        </p>
        <pre className="bg-background/60 border border-border px-2 py-1 text-[10px] font-mono whitespace-pre-wrap break-words">{reason}</pre>
        <p className="pt-1">
          Install the standalone server on the fleet host and run it as a systemd <code className="text-[10px] font-mono">--user</code> unit listening on{" "}
          <code className="text-[10px] font-mono">127.0.0.1:3456</code>, or set the <code className="text-[10px] font-mono">DEVTOOLS_URL</code> environment variable on Gantry to point at a remote instance.
        </p>
        <p>
          Full instructions:{" "}
          <a href="https://github.com/geleynse/gantry/blob/main/docs/devtools-integration.md" target="_blank" rel="noopener" className="text-info hover:underline">
            docs/devtools-integration.md
          </a>
        </p>
      </div>
      <button
        onClick={onRetry}
        disabled={retrying}
        className="text-xs border border-border px-3 py-1 hover:bg-secondary transition-colors disabled:opacity-40 flex items-center gap-1.5"
      >
        <RefreshCw className={cn("w-3 h-3", retrying && "animate-spin")} />
        Retry
      </button>
    </div>
  );
}

export function AgentSessionsPanel({
  agentName,
  onViewLogs,
}: {
  agentName: string;
  /** Passed from client.tsx — switches to Logs tab with a time filter (Task A) */
  onViewLogs?: (from: number, to: number) => void;
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialHash = parseSessionHash();
  const [expandedId, setExpandedId] = useState<string | null>(() => initialHash.sessionId);
  // Task C: message UUID to scroll to after the session detail loads
  const [targetMsgUuid, setTargetMsgUuid] = useState<string | null>(() => initialHash.msgUuid);
  // Task B: epoch-ms timestamp for session matching when navigating from Activity tab tool calls
  const [sessionMatchTime] = useState<number | null>(() => {
    if (typeof window === "undefined") return null;
    const sp = new URLSearchParams(window.location.search);
    const t = sp.get("sessionTime");
    return t ? Number(t) : null;
  });
  const [sessionCosts, setSessionCosts] = useState<Map<string, number>>(new Map());
  const [sessionDurations, setSessionDurations] = useState<Map<string, number>>(new Map());
  const [devtoolsInfo, setDevtoolsInfo] = useState<{ url: string; reason: string } | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const didScrollRef = useRef(false);

  const handleCostComputed = useCallback((sid: string, cost: number | null, durationMs: number | undefined) => {
    if (cost != null) {
      setSessionCosts((prev) => { const n = new Map(prev); n.set(sid, cost); return n; });
    }
    if (durationMs != null) {
      setSessionDurations((prev) => { const n = new Map(prev); n.set(sid, durationMs); return n; });
    }
  }, []);

  const setExpanded = useCallback((id: string | null) => {
    setExpandedId(id);
    if (id) {
      window.history.replaceState(null, "", `#sessions/${id}`);
    } else {
      window.history.replaceState(null, "", "#sessions");
    }
  }, []);

  const loadPage = useCallback(
    async (nextCursor: string | null, reset: boolean) => {
      setLoading(true);
      setError(null);
      setDevtoolsInfo(null);
      try {
        const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
        if (nextCursor) qs.set("cursor", nextCursor);
        const data = await apiFetch<SessionListResponse>(`/agents/${agentName}/sessions?${qs.toString()}`);
        setSessions((prev) => (reset ? data.sessions : [...prev, ...data.sessions]));
        setCursor(data.nextCursor);
        setHasMore(data.hasMore);
      } catch (err) {
        // Detect the structured 503 from the server when claude-devtools isn't
        // reachable. Render a setup card instead of a raw stack trace.
        if (isApiError(err) && err.status === 503) {
          try {
            const body = JSON.parse(err.body) as { code?: string; url?: string; reason?: string };
            if (body.code === "devtools_unavailable") {
              setDevtoolsInfo({ url: body.url ?? "(unknown)", reason: body.reason ?? "unreachable" });
              return;
            }
          } catch {
            // fall through to generic error
          }
        }
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [agentName],
  );

  useEffect(() => {
    setSessions([]);
    setCursor(null);
    setHasMore(true);
    // Restore hash-based deep link on agent change
    const { sessionId, msgUuid } = parseSessionHash();
    setExpandedId(sessionId);
    setTargetMsgUuid(msgUuid);
    didScrollRef.current = false;
    loadPage(null, true);
  }, [agentName, loadPage]);

  // Scroll to the expanded row once it appears in the DOM.
  useEffect(() => {
    if (!expandedId || didScrollRef.current) return;
    const el = rowRefs.current.get(expandedId);
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      didScrollRef.current = true;
    }
  }, [expandedId, sessions]);

  // Task B: auto-expand the session that contains the tool call timestamp.
  // Runs once after sessions load when ?sessionTime= is present and no explicit session ID is in the hash.
  useEffect(() => {
    if (!sessionMatchTime || expandedId || sessions.length === 0) return;
    // Find the most recent session whose window contains the tool call timestamp.
    // Sessions are returned newest-first, so we prefer earlier matches.
    const match = sessions.find(
      (s) => sessionMatchTime >= s.createdAt && sessionMatchTime <= s.updatedAt,
    );
    if (match) {
      setExpandedId(match.id);
      window.history.replaceState(null, "", `#sessions/${match.id}`);
    }
  }, [sessionMatchTime, expandedId, sessions]);

  if (devtoolsInfo) {
    return <DevtoolsSetupCard url={devtoolsInfo.url} reason={devtoolsInfo.reason} onRetry={() => loadPage(null, true)} retrying={loading} />;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          Showing <span className="text-foreground font-mono">{sessions.length}</span> session
          {sessions.length === 1 ? "" : "s"} for{" "}
          <span className="text-primary font-medium">{agentName}</span>
          {sessionCosts.size > 0 && (() => {
            const total = Array.from(sessionCosts.values()).reduce((a, b) => a + b, 0);
            return (
              <span className="ml-2 text-muted-foreground/70">
                — Total: <span className="font-mono text-foreground/70">${total.toFixed(2)}</span>
              </span>
            );
          })()}
        </div>
        <button
          onClick={() => loadPage(null, true)}
          disabled={loading}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
        >
          <RefreshCw className={cn("w-3 h-3", loading && "animate-spin")} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="text-xs text-error bg-error/10 border border-error/30 px-3 py-2">
          {error}
        </div>
      )}

      <div className="border border-border">
        {sessions.length === 0 && !loading && !error && (
          <div className="px-3 py-8 text-center text-xs text-muted-foreground italic">
            No sessions found for this agent.
          </div>
        )}
        {(() => {
          // Compute median durationMs across sessions we've fetched detail for.
          const durations = Array.from(sessionDurations.values()).sort((a, b) => a - b);
          const medianDuration = durations.length > 0
            ? durations[Math.floor(durations.length / 2)]
            : null;
          return sessions.map((s) => {
          const expanded = expandedId === s.id;
          const ctx = s.contextConsumption ?? 0;
          const msgCount = s.messageCount ?? 0;
          const dur = sessionDurations.get(s.id);
          const isSlow = medianDuration != null && dur != null && dur > 2 * medianDuration;
          return (
            <div
              key={s.id}
              ref={(el) => { if (el) rowRefs.current.set(s.id, el); else rowRefs.current.delete(s.id); }}
              className="border-b border-border last:border-b-0"
            >
              <button
                onClick={() => setExpanded(expanded ? null : s.id)}
                className={cn(
                  "w-full text-left px-3 py-2 hover:bg-secondary/50 transition-colors",
                  expanded && "bg-secondary/30",
                )}
              >
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 shrink-0 text-muted-foreground">
                    {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                      <span title={formatAbsolute(s.updatedAt)} className="text-foreground/80 normal-case">
                        {relativeTime(s.updatedAt)}
                      </span>
                      <span>
                        {msgCount} msg{msgCount === 1 ? "" : "s"}
                        {msgCount > 15 && (
                          <span className="ml-1 px-1 py-0.5 text-[9px] bg-info/20 text-info rounded">long</span>
                        )}
                      </span>
                      {ctx > 0 && (
                        <span>
                          ctx{" "}
                          <span className={cn(
                            "font-mono normal-case",
                            ctx > 200_000 ? "text-error" : ctx > 100_000 ? "text-warning" : "text-foreground/80",
                          )}>
                            {formatTokens(ctx)}
                          </span>
                        </span>
                      )}
                      {s.isOngoing && <span className="text-success animate-pulse">ongoing</span>}
                      {s.hasSubagents && <span className="text-warning">subagents</span>}
                      {isSlow && (
                        <span className="px-1 py-0.5 text-[9px] bg-warning/20 text-warning rounded">slow</span>
                      )}
                      <span className="opacity-50 font-mono normal-case" title={s.id}>
                        {s.id.slice(0, 8)}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-foreground/80 line-clamp-2">
                      {(s.firstAssistantText ?? stripLogin(s.firstMessage)) || <span className="italic opacity-60">no preview</span>}
                    </div>
                  </div>
                </div>
              </button>
              {expanded && (
                <SessionDetailView
                  agentName={agentName}
                  sessionId={s.id}
                  session={s}
                  onViewLogs={onViewLogs}
                  scrollToMsgUuid={targetMsgUuid ?? undefined}
                  onCostComputed={handleCostComputed}
                />
              )}
            </div>
          );
        });
        })()}
      </div>

      <div className="flex justify-center">
        {hasMore && (
          <button
            onClick={() => loadPage(cursor, false)}
            disabled={loading}
            className="text-xs text-muted-foreground hover:text-foreground border border-border px-4 py-1.5 transition-colors disabled:opacity-40"
          >
            {loading ? (
              <span className="flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin" /> Loading…
              </span>
            ) : (
              "Load more"
            )}
          </button>
        )}
        {!hasMore && sessions.length > 0 && (
          <span className="text-[10px] text-muted-foreground italic">end of list</span>
        )}
      </div>
    </div>
  );
}
