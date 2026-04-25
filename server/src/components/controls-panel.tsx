"use client";

import { useState, useEffect, useCallback } from "react";
import { Trash2, Plus, Send, AlertCircle, Loader2, Shield } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";
import { formatDate } from "@/lib/time";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DirectivePriority = "low" | "normal" | "high" | "critical";

interface Directive {
  id: number;
  agent_name: string;
  directive: string;
  priority: DirectivePriority;
  active: number;
  created_at: string;
  expires_at: string | null;
}

interface NudgeState {
  state: string;
  nudge_context: {
    level: number;
    attempt_count: number;
  };
}

interface DirectivesResponse {
  directives: Directive[];
  nudgeState: NudgeState | null;
}

// ---------------------------------------------------------------------------
// Priority badge
// ---------------------------------------------------------------------------

const PRIORITY_STYLES: Record<DirectivePriority, string> = {
  critical: "bg-error/20 text-error border-error/40",
  high: "bg-warning/20 text-warning border-warning/40",
  normal: "bg-primary/10 text-primary border-primary/20",
  low: "bg-secondary/50 text-muted-foreground border-border",
};

function PriorityBadge({ priority }: { priority: DirectivePriority }) {
  return (
    <span
      className={cn(
        "text-[9px] uppercase tracking-wider px-1.5 py-0.5 border font-bold",
        PRIORITY_STYLES[priority],
      )}
    >
      {priority}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Nudge state indicator
// ---------------------------------------------------------------------------

function NudgeStateIndicator({ nudgeState }: { nudgeState: NudgeState | null }) {
  if (!nudgeState) {
    return (
      <div className="text-[10px] text-muted-foreground italic">
        Nudge system inactive
      </div>
    );
  }

  const stateColors: Record<string, string> = {
    RUNNING: "text-success",
    NUDGE_LEVEL_1: "text-warning",
    NUDGE_LEVEL_2: "text-orange-400",
    NUDGE_LEVEL_3: "text-error",
    IDLE: "text-muted-foreground",
  };

  return (
    <div className="flex items-center gap-2">
      <Shield className="w-3.5 h-3.5 text-muted-foreground" />
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
        Nudge:
      </span>
      <span className={cn("text-[10px] font-bold", stateColors[nudgeState.state] ?? "text-foreground")}>
        {nudgeState.state.replace(/_/g, " ")}
      </span>
      {nudgeState.nudge_context.level > 0 && (
        <span className="text-[10px] text-muted-foreground">
          (L{nudgeState.nudge_context.level}, {nudgeState.nudge_context.attempt_count} attempts)
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Controls panel
// ---------------------------------------------------------------------------

export function ControlsPanel({ agentName }: { agentName: string }) {
  const [directives, setDirectives] = useState<Directive[]>([]);
  const [nudgeState, setNudgeState] = useState<NudgeState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add directive form state
  const [addText, setAddText] = useState("");
  const [addPriority, setAddPriority] = useState<DirectivePriority>("normal");
  const [addExpiryMinutes, setAddExpiryMinutes] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Nudge form state
  const [nudgeText, setNudgeText] = useState("");
  const [nudgeBusy, setNudgeBusy] = useState(false);
  const [nudgeSuccess, setNudgeSuccess] = useState(false);
  const [nudgeError, setNudgeError] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    apiFetch<DirectivesResponse>(`/agents/${agentName}/directives`)
      .then((data) => {
        if (!cancelled) {
          setDirectives(data.directives);
          setNudgeState(data.nudgeState);
          setLoading(false);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message ?? "Failed to load directives");
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [agentName]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    return load();
  }, [load]);

  async function handleAddDirective() {
    if (!addText.trim()) return;
    setAddBusy(true);
    setAddError(null);
    try {
      const body: Record<string, unknown> = {
        text: addText.trim(),
        priority: addPriority,
      };
      const minutes = parseInt(addExpiryMinutes, 10);
      if (!isNaN(minutes) && minutes > 0) {
        body.expires_in_minutes = minutes;
      }
      await apiFetch(`/agents/${agentName}/directives`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setAddText("");
      setAddExpiryMinutes("");
      setAddPriority("normal");
      load();
    } catch (err) {
      setAddError((err as Error).message ?? "Failed to add directive");
    } finally {
      setAddBusy(false);
    }
  }

  async function handleDeleteDirective(id: number) {
    try {
      await apiFetch(`/agents/${agentName}/directives/${id}`, { method: "DELETE" });
      setDirectives((prev) => prev.filter((d) => d.id !== id));
    } catch (err) {
      setError((err as Error).message ?? "Failed to remove directive");
    }
  }

  async function handleSendNudge() {
    if (!nudgeText.trim()) return;
    setNudgeBusy(true);
    setNudgeSuccess(false);
    setNudgeError(null);
    try {
      await apiFetch(`/agents/${agentName}/nudge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: nudgeText.trim() }),
      });
      setNudgeText("");
      setNudgeSuccess(true);
      setTimeout(() => setNudgeSuccess(false), 3000);
    } catch (err) {
      setNudgeError((err as Error).message ?? "Failed to send nudge");
    } finally {
      setNudgeBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="py-16 text-center text-muted-foreground text-sm">Loading…</div>
    );
  }

  if (error) {
    return (
      <div className="py-8 flex items-center justify-center gap-2 text-error text-sm">
        <AlertCircle className="w-4 h-4" />
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Nudge state */}
      <div className="bg-card border border-border p-4">
        <div className="flex items-center justify-between border-b border-border pb-2 mb-3">
          <h3 className="text-[10px] uppercase tracking-wider text-foreground/70">
            Agent Status
          </h3>
        </div>
        <NudgeStateIndicator nudgeState={nudgeState} />
      </div>

      {/* Standing orders (directives) */}
      <div className="bg-card border border-border p-4 space-y-4">
        <div className="flex items-center justify-between border-b border-border pb-2">
          <h3 className="text-[10px] uppercase tracking-wider text-foreground/70">
            Standing Orders
          </h3>
          <span className="text-[10px] text-muted-foreground">
            {directives.length} active
          </span>
        </div>

        {directives.length === 0 ? (
          <div className="text-[11px] text-muted-foreground italic py-2">
            No standing orders. Add one below.
          </div>
        ) : (
          <ul className="space-y-2">
            {directives.map((d) => (
              <li
                key={d.id}
                className="flex items-start gap-2 bg-secondary/30 border border-border/50 px-3 py-2"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <PriorityBadge priority={d.priority} />
                    {d.expires_at && (
                      <span className="text-[9px] text-muted-foreground">
                        expires {formatDate(d.expires_at)}
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-foreground leading-snug">
                    {d.directive}
                  </div>
                </div>
                <button
                  onClick={() => handleDeleteDirective(d.id)}
                  className="shrink-0 p-1 text-muted-foreground hover:text-error hover:bg-error/10 transition-colors"
                  title="Remove directive"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* Add directive form */}
        <div className="border-t border-border pt-3 space-y-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
            Add Standing Order
          </div>
          <textarea
            value={addText}
            onChange={(e) => setAddText(e.target.value)}
            placeholder="Enter directive text…"
            rows={2}
            className="w-full bg-background border border-border text-xs px-2 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-primary resize-none"
          />
          <div className="flex items-center gap-2">
            <select
              value={addPriority}
              onChange={(e) => setAddPriority(e.target.value as DirectivePriority)}
              className="bg-background border border-border text-xs px-2 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
            <input
              type="number"
              value={addExpiryMinutes}
              onChange={(e) => setAddExpiryMinutes(e.target.value)}
              placeholder="Expires in (min)"
              min={1}
              className="w-36 bg-background border border-border text-xs px-2 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <button
              onClick={handleAddDirective}
              disabled={addBusy || !addText.trim()}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground text-[10px] uppercase tracking-wider hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {addBusy ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Plus className="w-3 h-3" />
              )}
              Add
            </button>
          </div>
          {addError && (
            <div className="text-[11px] text-error">{addError}</div>
          )}
        </div>
      </div>

      {/* One-shot nudge */}
      <div className="bg-card border border-border p-4 space-y-3">
        <div className="border-b border-border pb-2">
          <h3 className="text-[10px] uppercase tracking-wider text-foreground/70">
            Send One-Time Message
          </h3>
          <p className="text-[10px] text-muted-foreground mt-1">
            Delivers a single message on the agent&apos;s next tool call, then discards it.
          </p>
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={nudgeText}
            onChange={(e) => setNudgeText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSendNudge()}
            placeholder="Message to agent…"
            className="flex-1 bg-background border border-border text-xs px-2 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            onClick={handleSendNudge}
            disabled={nudgeBusy || !nudgeText.trim()}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground text-[10px] uppercase tracking-wider hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {nudgeBusy ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Send className="w-3 h-3" />
            )}
            Send
          </button>
        </div>
        {nudgeSuccess && (
          <div className="text-[11px] text-success">Message queued for delivery.</div>
        )}
        {nudgeError && (
          <div className="text-[11px] text-error">{nudgeError}</div>
        )}
      </div>
    </div>
  );
}
