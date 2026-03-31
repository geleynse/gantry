"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { CheckCircle, XCircle, Clock, Filter, RefreshCw } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ReviewStatus = "pending" | "approved" | "rejected" | "auto_approved";
type OutboundChannel = "forum" | "discord" | "chat";

interface OutboundMessage {
  id: number;
  timestamp: string;
  agentName: string;
  channel: OutboundChannel;
  content: string;
  metadata: Record<string, unknown>;
  status: ReviewStatus;
  reviewedBy?: string;
  reviewedAt?: string;
}

// ---------------------------------------------------------------------------
// Pending count hook — used by Sidebar for the badge
// ---------------------------------------------------------------------------

export function useOutboundPendingCount(pollIntervalMs = 30_000): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const fetchCount = async () => {
      try {
        const data = await apiFetch<{ count: number }>("/outbound/pending/count");
        if (!cancelled) setCount(data.count);
      } catch {
        // Non-fatal: badge just stays at last known value
      }
    };
    fetchCount();
    const interval = setInterval(fetchCount, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [pollIntervalMs]);

  return count;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CHANNEL_LABELS: Record<OutboundChannel, string> = {
  forum: "Forum",
  discord: "Discord",
  chat: "Chat",
};

const CHANNEL_COLORS: Record<OutboundChannel, string> = {
  forum: "text-blue-400 bg-blue-900/30",
  discord: "text-purple-400 bg-purple-900/30",
  chat: "text-green-400 bg-green-900/30",
};

const STATUS_COLORS: Record<ReviewStatus, string> = {
  pending: "text-yellow-400",
  approved: "text-green-400",
  rejected: "text-red-400",
  auto_approved: "text-blue-400",
};

function formatTimestamp(ts: string): string {
  try {
    return new Date(ts + "Z").toLocaleString();
  } catch {
    return ts;
  }
}

// ---------------------------------------------------------------------------
// Message card
// ---------------------------------------------------------------------------

interface MessageCardProps {
  msg: OutboundMessage;
  onApprove: (id: number) => void;
  onReject: (id: number) => void;
  isPending: boolean;
}

function MessageCard({ msg, onApprove, onReject, isPending }: MessageCardProps) {
  const [expanded, setExpanded] = useState(false);
  const isLong = msg.content.length > 200;
  const preview = isLong && !expanded ? msg.content.slice(0, 200) + "…" : msg.content;

  return (
    <div className="border border-border rounded-lg p-4 bg-card space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-sm font-semibold text-foreground">{msg.agentName}</span>
          <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium", CHANNEL_COLORS[msg.channel])}>
            {CHANNEL_LABELS[msg.channel]}
          </span>
          <span className="text-xs text-foreground/50">{formatTimestamp(msg.timestamp)}</span>
        </div>
        <span className="text-xs text-foreground/50">#{msg.id}</span>
      </div>

      <div className="text-sm text-foreground/90 whitespace-pre-wrap break-words">
        {preview}
        {isLong && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="ml-1 text-primary text-xs hover:underline"
          >
            {expanded ? "show less" : "show more"}
          </button>
        )}
      </div>

      {/* Metadata (for admins who want to see the raw params) */}
      {expanded && Object.keys(msg.metadata).length > 0 && (
        <details className="text-xs text-foreground/50">
          <summary className="cursor-pointer hover:text-foreground/70">metadata</summary>
          <pre className="mt-1 p-2 bg-secondary rounded text-xs overflow-auto">
            {JSON.stringify(msg.metadata, null, 2)}
          </pre>
        </details>
      )}

      {isPending && (
        <div className="flex gap-2 pt-1">
          <button
            onClick={() => onApprove(msg.id)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-success/20 hover:bg-success/30 text-success border border-success/30 rounded text-xs font-medium transition-colors"
          >
            <CheckCircle size={12} /> Approve
          </button>
          <button
            onClick={() => onReject(msg.id)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-error/20 hover:bg-error/30 text-error border border-error/30 rounded text-xs font-medium transition-colors"
          >
            <XCircle size={12} /> Reject
          </button>
        </div>
      )}

      {!isPending && (
        <div className="flex items-center gap-2 text-xs">
          <span className={STATUS_COLORS[msg.status]}>{msg.status.replace("_", " ")}</span>
          {msg.reviewedBy && <span className="text-foreground/50">by {msg.reviewedBy}</span>}
          {msg.reviewedAt && <span className="text-foreground/40">{formatTimestamp(msg.reviewedAt)}</span>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function OutboundReviewPanel() {
  const { isAdmin } = useAuth();
  const [tab, setTab] = useState<"pending" | "history">("pending");
  const [channelFilter, setChannelFilter] = useState<OutboundChannel | "">("");
  const [agentFilter, setAgentFilter] = useState("");
  const [pending, setPending] = useState<OutboundMessage[]>([]);
  const [history, setHistory] = useState<OutboundMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const fetchPending = useCallback(async () => {
    try {
      const params = channelFilter ? `?channel=${channelFilter}` : "";
      const data = await apiFetch<OutboundMessage[]>(`/outbound/pending${params}`);
      setPending(data);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [channelFilter]);

  const fetchHistory = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      if (channelFilter) qs.set("channel", channelFilter);
      if (agentFilter) qs.set("agent", agentFilter);
      qs.set("limit", "50");
      const data = await apiFetch<OutboundMessage[]>(`/outbound/history?${qs}`);
      setHistory(data);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [channelFilter, agentFilter]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    if (tab === "pending") await fetchPending();
    else await fetchHistory();
    setLoading(false);
  }, [tab, fetchPending, fetchHistory]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleApprove = async (id: number) => {
    setActionLoading(true);
    try {
      await apiFetch(`/outbound/approve/${id}`, { method: "POST" });
      await fetchPending();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleReject = async (id: number) => {
    setActionLoading(true);
    try {
      await apiFetch(`/outbound/reject/${id}`, { method: "POST" });
      await fetchPending();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleApproveAll = async () => {
    if (!confirm("Approve all pending messages?")) return;
    setActionLoading(true);
    try {
      const params = channelFilter ? `?channel=${channelFilter}` : "";
      await apiFetch(`/outbound/approve-all${params}`, { method: "POST" });
      await fetchPending();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setActionLoading(false);
    }
  };

  if (!isAdmin) {
    return (
      <div className="p-8 text-center text-foreground/50">
        Admin access required to review outbound content.
      </div>
    );
  }

  const messages = tab === "pending" ? pending : history;

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Outbound Content Review</h2>
        <button
          onClick={fetchData}
          disabled={loading || actionLoading}
          className="p-1.5 rounded hover:bg-secondary text-foreground/60 hover:text-foreground transition-colors"
          title="Refresh"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {(["pending", "history"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "px-4 py-2 text-sm font-medium border-b-2 transition-colors",
              tab === t
                ? "border-primary text-primary"
                : "border-transparent text-foreground/60 hover:text-foreground",
            )}
          >
            {t === "pending" ? (
              <span className="flex items-center gap-1.5">
                <Clock size={13} /> Pending
                {pending.length > 0 && (
                  <span className="bg-warning text-warning-content text-xs px-1.5 py-0.5 rounded-full font-bold">
                    {pending.length}
                  </span>
                )}
              </span>
            ) : (
              "History"
            )}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex gap-3 items-center flex-wrap">
        <div className="flex items-center gap-1.5 text-sm text-foreground/60">
          <Filter size={13} /> Filter:
        </div>
        <select
          value={channelFilter}
          onChange={(e) => setChannelFilter(e.target.value as OutboundChannel | "")}
          className="text-sm bg-background border border-border rounded px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        >
          <option value="">All channels</option>
          <option value="forum">Forum</option>
          <option value="chat">Chat</option>
          <option value="discord">Discord</option>
        </select>
        {tab === "history" && (
          <input
            type="text"
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            placeholder="Filter by agent"
            className="text-sm bg-background border border-border rounded px-2 py-1 text-foreground w-36 focus:outline-none focus:ring-1 focus:ring-primary"
          />
        )}
        {tab === "pending" && pending.length > 0 && (
          <button
            onClick={handleApproveAll}
            disabled={actionLoading}
            className="ml-auto flex items-center gap-1.5 px-3 py-1.5 bg-success/20 hover:bg-success/30 text-success border border-success/30 rounded text-sm font-medium transition-colors disabled:opacity-50"
          >
            <CheckCircle size={14} /> Approve All
          </button>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="text-sm text-error bg-error/10 border border-error/20 rounded p-3">
          {error}
        </div>
      )}

      {/* Messages */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((n) => (
            <div key={n} className="h-24 rounded-lg bg-secondary animate-pulse" />
          ))}
        </div>
      ) : messages.length === 0 ? (
        <div className="py-12 text-center text-foreground/40 text-sm">
          {tab === "pending" ? "No pending messages" : "No history yet"}
        </div>
      ) : (
        <div className="space-y-3">
          {messages.map((msg) => (
            <MessageCard
              key={msg.id}
              msg={msg}
              isPending={tab === "pending"}
              onApprove={handleApprove}
              onReject={handleReject}
            />
          ))}
        </div>
      )}
    </div>
  );
}
