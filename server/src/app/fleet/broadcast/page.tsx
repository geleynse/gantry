"use client";

import { useState, useEffect } from "react";
import { Radio, Send, CheckCircle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import { useAgentNames } from "@/hooks/use-agent-names";
import { formatAbsolute, relativeTime } from "@/lib/time";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BroadcastResult {
  ok: boolean;
  id: string;
  sent: string[];
  failed: string[];
}

interface BroadcastRecord {
  id: string;
  message: string;
  targets: string[];
  sent: string[];
  failed: string[];
  timestamp: string;
}

interface HistoryResponse {
  history: BroadcastRecord[];
}

type Priority = "normal" | "high" | "urgent";

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function BroadcastPage() {
  const { isAdmin } = useAuth();
  // Use the same agent source as the rest of the UI so target counts match
  // Comms, the top-bar agent counter, and the Dashboard grid. This hook
  // already filters out "overseer" (has its own page; not a broadcast target).
  const agentList = useAgentNames();
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [priority, setPriority] = useState<Priority>("normal");
  const [isSending, setIsSending] = useState(false);
  const [result, setResult] = useState<BroadcastResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<BroadcastRecord[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // When the agent list first loads, default to all selected. After that,
  // respect whatever the user has (de)selected even if the fleet roster
  // changes mid-session.
  const [selectionInitialized, setSelectionInitialized] = useState(false);
  useEffect(() => {
    if (!selectionInitialized && agentList.length > 0) {
      setSelectedAgents(new Set(agentList));
      setSelectionInitialized(true);
    }
  }, [agentList, selectionInitialized]);

  // Fetch history on mount
  useEffect(() => {
    loadHistory();
  }, []);

  async function loadHistory() {
    setIsLoadingHistory(true);
    try {
      const res = await apiFetch<HistoryResponse>("/fleet/broadcast/history");
      setHistory(res.history);
    } catch {
      // Ignore history load errors
    } finally {
      setIsLoadingHistory(false);
    }
  }

  function toggleAgent(name: string) {
    setSelectedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }

  function toggleAll() {
    if (selectedAgents.size === agentList.length) {
      setSelectedAgents(new Set());
    } else {
      setSelectedAgents(new Set(agentList));
    }
  }

  async function handleSend() {
    if (!message.trim()) return;
    if (selectedAgents.size === 0) {
      setError("Select at least one agent");
      return;
    }

    // Confirmation for Urgent fleet-wide broadcasts — protects against
    // accidental mass "wake up now" pings. Show the count so the operator
    // knows what they're about to do.
    if (priority === "urgent" && !confirmOpen) {
      setConfirmOpen(true);
      return;
    }
    setConfirmOpen(false);

    setIsSending(true);
    setResult(null);
    setError(null);

    const targets =
      selectedAgents.size === agentList.length
        ? undefined // all agents — omit targets param
        : Array.from(selectedAgents);

    try {
      const res = await apiFetch<BroadcastResult>("/fleet/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: message.trim(), targets, priority }),
      });
      setResult(res);
      setMessage("");
      // Refresh history
      await loadHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Broadcast failed");
    } finally {
      setIsSending(false);
    }
  }

  const allSelected = agentList.length > 0 && selectedAgents.size === agentList.length;
  const noneSelected = selectedAgents.size === 0;

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Header */}
      <div className="border-b border-primary/20 pb-4">
        <h1 className="text-lg font-semibold text-primary uppercase tracking-wider flex items-center gap-2">
          <Radio className="w-5 h-5" />
          Swarm Broadcast
        </h1>
        <p className="text-xs text-muted-foreground mt-1">
          Send a directive to all agents simultaneously. Messages are delivered as fleet orders.
        </p>
      </div>

      {!isAdmin && (
        <div className="bg-warning/10 border border-warning/30 text-warning text-xs p-3">
          Admin access required to send broadcasts.
        </div>
      )}

      {/* Compose */}
      <div className="bg-card border border-border p-4 space-y-4">
        <div className="text-[10px] uppercase tracking-wider font-semibold text-foreground/70">
          Compose Message
        </div>

        {/* Message input */}
        <div>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Enter directive for agents..."
            rows={4}
            disabled={!isAdmin}
            className={cn(
              "w-full bg-background border border-border text-foreground text-xs font-mono p-3 resize-y",
              "placeholder:text-muted-foreground",
              "focus:outline-none focus:border-primary/50",
              (!isAdmin) && "opacity-50 cursor-not-allowed"
            )}
          />
          <div className="text-right text-[10px] text-muted-foreground mt-1">
            {message.length} chars
          </div>
        </div>

        {/* Priority selector — aligned with Comms (normal / high / urgent) */}
        <div className="flex items-center gap-3">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground shrink-0">
            Priority
          </span>
          <div className="flex gap-2">
            {(["normal", "high", "urgent"] as Priority[]).map((p) => (
              <button
                key={p}
                onClick={() => setPriority(p)}
                disabled={!isAdmin}
                className={cn(
                  "px-3 py-1 text-[10px] uppercase tracking-wider transition-colors",
                  priority === p
                    ? p === "urgent"
                      ? "bg-error text-error-content"
                      : p === "high"
                      ? "bg-warning text-warning-content"
                      : "bg-primary text-primary-foreground"
                    : "bg-secondary text-muted-foreground hover:text-foreground",
                  (!isAdmin) && "cursor-not-allowed opacity-50"
                )}
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        {/* Agent selector */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Targets ({selectedAgents.size} / {agentList.length})
            </span>
            <button
              onClick={toggleAll}
              disabled={!isAdmin}
              className="text-[10px] uppercase tracking-wider text-primary hover:opacity-80 transition-opacity"
            >
              {allSelected ? "Deselect All" : "Select All"}
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {agentList.map((name) => (
              <button
                key={name}
                onClick={() => toggleAgent(name)}
                disabled={!isAdmin}
                className={cn(
                  "px-2.5 py-1 text-xs font-mono transition-colors border",
                  selectedAgents.has(name)
                    ? "bg-primary/10 text-primary border-primary/40"
                    : "bg-secondary text-muted-foreground border-border hover:border-border/80",
                  (!isAdmin) && "cursor-not-allowed opacity-50"
                )}
              >
                {name}
              </button>
            ))}
            {agentList.length === 0 && (
              <span className="text-xs text-muted-foreground italic">Loading agents...</span>
            )}
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="bg-error/10 border border-error/30 text-error text-xs p-2.5">
            {error}
          </div>
        )}

        {/* Result */}
        {result && (
          <div className="bg-card border border-border p-3 space-y-1.5">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Broadcast Result
            </div>
            {result.sent.length > 0 && (
              <div className="flex items-start gap-2 text-xs">
                <CheckCircle className="w-3.5 h-3.5 text-success shrink-0 mt-0.5" />
                <span className="text-success">
                  Sent to: {result.sent.join(", ")}
                </span>
              </div>
            )}
            {result.failed.length > 0 && (
              <div className="flex items-start gap-2 text-xs">
                <XCircle className="w-3.5 h-3.5 text-error shrink-0 mt-0.5" />
                <span className="text-error">
                  Failed: {result.failed.join(", ")}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Send button */}
        {isAdmin && (
          <div className="flex justify-end">
            <button
              onClick={handleSend}
              disabled={isSending || !message.trim() || noneSelected}
              className={cn(
                "flex items-center gap-2 px-4 py-2 text-[10px] uppercase tracking-wider font-bold transition-opacity",
                "bg-primary text-primary-foreground",
                (isSending || !message.trim() || noneSelected) && "opacity-40 cursor-not-allowed"
              )}
            >
              <Send className="w-3.5 h-3.5" />
              {isSending ? "Sending..." : "Broadcast"}
            </button>
          </div>
        )}
      </div>

      {/* Urgent-broadcast confirmation modal */}
      {confirmOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          role="dialog"
          aria-modal="true"
          aria-labelledby="broadcast-confirm-title"
        >
          <div className="bg-card border border-error/50 max-w-md w-full mx-4 p-5 space-y-4">
            <h2
              id="broadcast-confirm-title"
              className="text-sm font-bold uppercase tracking-wider text-error flex items-center gap-2"
            >
              <Radio className="w-4 h-4" /> Confirm Urgent Broadcast
            </h2>
            <p className="text-xs text-foreground">
              You are about to send an <span className="font-bold text-error">URGENT</span>{" "}
              broadcast to <span className="font-bold">{selectedAgents.size}</span>{" "}
              agent{selectedAgents.size === 1 ? "" : "s"}
              {selectedAgents.size === agentList.length && agentList.length > 0
                ? " (entire fleet)"
                : ""}.
            </p>
            {message.trim() && (
              <div className="text-[11px] font-mono bg-secondary/40 border border-border p-2 max-h-32 overflow-auto whitespace-pre-wrap break-words">
                {message.trim()}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmOpen(false)}
                className="px-3 py-1.5 text-[10px] uppercase tracking-wider border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSend}
                className="px-3 py-1.5 text-[10px] uppercase tracking-wider bg-error text-error-content font-bold hover:opacity-90 transition-opacity"
              >
                Send Urgent
              </button>
            </div>
          </div>
        </div>
      )}

      {/* History */}
      <div className="bg-card border border-border">
        <div className="px-4 py-2.5 border-b border-border bg-secondary/30 text-[10px] uppercase tracking-wider font-semibold text-foreground">
          Recent Broadcasts
        </div>
        {isLoadingHistory ? (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground">
            Loading...
          </div>
        ) : history.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground italic">
            No broadcasts sent yet
          </div>
        ) : (
          <div className="divide-y divide-border/50">
            {history.map((record) => (
              <div key={record.id} className="px-4 py-3 space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-xs text-foreground font-mono leading-relaxed flex-1">
                    {record.message}
                  </p>
                  <span
                    className="text-[10px] text-muted-foreground shrink-0 tabular-nums"
                    title={relativeTime(record.timestamp)}
                  >
                    {formatAbsolute(record.timestamp)}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-[10px]">
                  {record.sent.length > 0 && (
                    <span className="text-success flex items-center gap-1">
                      <CheckCircle className="w-3 h-3" />
                      {record.sent.join(", ")}
                    </span>
                  )}
                  {record.failed.length > 0 && (
                    <span className="text-error flex items-center gap-1">
                      <XCircle className="w-3 h-3" />
                      {record.failed.join(", ")}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
