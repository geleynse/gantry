"use client";

import { useState, useEffect } from "react";
import { Play, Square, RotateCw, Power, Send, Loader2, CheckCircle, AlertCircle, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";
import type { AgentStatus } from "@/hooks/use-fleet-status";

// ---------------------------------------------------------------------------
// Process Controls
// ---------------------------------------------------------------------------

function ProcessControls({ agentName, agent }: { agentName: string; agent: AgentStatus | null }) {
  const [busy, setBusy] = useState<string | null>(null);

  const isRunning = agent?.llmRunning ?? false;
  const shutdownState = agent?.shutdownState ?? "none";

  async function doAction(action: string, body?: unknown) {
    setBusy(action);
    try {
      await apiFetch(`/agents/${agentName}/${action}`, {
        method: "POST",
        ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      console.error(`Failed to ${action}:`, err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="bg-card border border-border p-4 space-y-3">
      <div className="border-b border-border pb-2">
        <h3 className="text-[10px] uppercase tracking-wider text-foreground/70">
          Process Controls
        </h3>
        <div className="mt-1 flex items-center gap-2">
          <span
            className={cn(
              "inline-block w-2 h-2 rounded-full",
              isRunning ? "bg-success" : "bg-muted-foreground opacity-50"
            )}
          />
          <span className="text-[10px] text-muted-foreground">
            {isRunning
              ? shutdownState !== "none"
                ? "Shutting down…"
                : "Running"
              : "Stopped"}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {!isRunning ? (
          <button
            onClick={() => doAction("start")}
            disabled={busy !== null}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] uppercase tracking-wider bg-success/10 text-success border border-success/30 hover:bg-success/20 transition-colors disabled:opacity-50"
          >
            {busy === "start" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
            Start
          </button>
        ) : (
          <button
            onClick={() => doAction("stop")}
            disabled={busy !== null}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] uppercase tracking-wider bg-error/10 text-error border border-error/30 hover:bg-error/20 transition-colors disabled:opacity-50"
          >
            {busy === "stop" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Square className="w-3 h-3" />}
            Stop
          </button>
        )}

        <button
          onClick={() => doAction("restart")}
          disabled={busy !== null}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] uppercase tracking-wider bg-secondary text-muted-foreground border border-border hover:text-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50"
        >
          {busy === "restart" ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCw className="w-3 h-3" />}
          Restart
        </button>

        {shutdownState === "none" && isRunning && (
          <>
            <button
              onClick={() => doAction("stop-after-turn", { reason: "Operator requested" })}
              disabled={busy !== null}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] uppercase tracking-wider text-warning border border-warning/30 bg-warning/5 hover:bg-warning/15 transition-all disabled:opacity-50"
              title="Finish current turn, then stop cleanly"
            >
              {busy === "stop-after-turn" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Clock className="w-3 h-3" />}
              Stop After Turn
            </button>
            <button
              onClick={() => doAction("shutdown", { reason: "Operator requested" })}
              disabled={busy !== null}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] uppercase tracking-wider font-bold text-error border border-error/30 bg-error/5 hover:bg-error hover:text-white hover:border-error transition-all disabled:opacity-50"
            >
              {busy === "shutdown" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Power className="w-3 h-3" />}
              Shutdown
            </button>
          </>
        )}

        {shutdownState === "stop_after_turn" && isRunning && (
          <span className="inline-flex items-center gap-1.5 px-2 py-1 text-[10px] bg-warning/10 text-warning border border-warning/30">
            <Clock className="w-3 h-3" />
            Stopping after turn…
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Send Order
// ---------------------------------------------------------------------------

function SendOrderSection({ agentName }: { agentName: string }) {
  const [message, setMessage] = useState("");
  const [priority, setPriority] = useState<"normal" | "urgent">("normal");
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSend() {
    if (!message.trim()) return;
    setBusy(true);
    setSuccess(false);
    setError(null);
    try {
      await apiFetch(`/agents/${agentName}/order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: message.trim(), priority }),
      });
      setMessage("");
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError((err as Error).message ?? "Failed to send order");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-card border border-border p-4 space-y-3">
      <div className="border-b border-border pb-2">
        <h3 className="text-[10px] uppercase tracking-wider text-foreground/70">
          Send Fleet Order
        </h3>
        <p className="text-[10px] text-muted-foreground mt-1">
          Delivers a fleet order to this agent on its next cycle.
        </p>
      </div>

      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Enter order for this agent…"
        rows={2}
        className="w-full bg-background border border-border text-xs px-2 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-primary resize-none"
      />

      <div className="flex items-center gap-2">
        <select
          value={priority}
          onChange={(e) => setPriority(e.target.value as "normal" | "urgent")}
          className="bg-background border border-border text-xs px-2 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        >
          <option value="normal">Normal</option>
          <option value="urgent">Urgent</option>
        </select>

        <button
          onClick={handleSend}
          disabled={busy || !message.trim()}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground text-[10px] uppercase tracking-wider hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
          Send Order
        </button>
      </div>

      {success && (
        <div className="flex items-center gap-1.5 text-[11px] text-success">
          <CheckCircle className="w-3 h-3" />
          Order queued for delivery.
        </div>
      )}
      {error && (
        <div className="flex items-center gap-1.5 text-[11px] text-error">
          <AlertCircle className="w-3 h-3" />
          {error}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trigger Routine
// ---------------------------------------------------------------------------

function TriggerRoutineSection({ agentName }: { agentName: string }) {
  const [routines, setRoutines] = useState<string[]>([]);
  const [selected, setSelected] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [routineLoadFailed, setRoutineLoadFailed] = useState(false);

  useEffect(() => {
    apiFetch<{ routines: string[] }>("/routines")
      .then((data) => {
        setRoutines(data.routines);
        if (data.routines.length > 0) setSelected(data.routines[0]);
      })
      .catch(() => {
        setRoutineLoadFailed(true);
      });
  }, []);

  async function handleExecute() {
    if (!selected) return;
    setBusy(true);
    setConfirming(false);
    setSuccess(false);
    setError(null);
    try {
      await apiFetch(`/agents/${agentName}/routine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routine: selected }),
      });
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError((err as Error).message ?? "Failed to trigger routine");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-card border border-border p-4 space-y-3">
      <div className="border-b border-border pb-2">
        <h3 className="text-[10px] uppercase tracking-wider text-foreground/70">
          Trigger Routine
        </h3>
        <p className="text-[10px] text-muted-foreground mt-1">
          Queue a named routine for this agent to execute on its next cycle.
        </p>
      </div>

      {routineLoadFailed ? (
        <span className="text-xs text-muted-foreground">Routines unavailable</span>
      ) : routines.length === 0 ? (
        <span className="text-xs text-muted-foreground">Loading routines…</span>
      ) : (
        <>
          <select
            value={selected}
            onChange={(e) => { setSelected(e.target.value); setConfirming(false); }}
            className="w-full bg-background border border-border text-xs px-2 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          >
            {routines.map((r) => (
              <option key={r} value={r}>{r.replace(/_/g, " ")}</option>
            ))}
          </select>

          {!confirming ? (
            <button
              onClick={() => setConfirming(true)}
              disabled={!selected}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-warning/10 text-warning border border-warning/30 text-[10px] uppercase tracking-wider hover:bg-warning/20 transition-colors disabled:opacity-50"
            >
              Execute Routine
            </button>
          ) : (
            <div className="flex items-center gap-2 bg-warning/5 border border-warning/30 px-3 py-2">
              <span className="text-[11px] text-warning flex-1">
                Execute <strong>{selected.replace(/_/g, " ")}</strong> on {agentName}?
              </span>
              <button
                onClick={handleExecute}
                disabled={busy}
                className="flex items-center gap-1 px-2.5 py-1 bg-warning text-black text-[10px] uppercase tracking-wider font-bold hover:opacity-90 disabled:opacity-50"
              >
                {busy && <Loader2 className="w-3 h-3 animate-spin" />}
                Confirm
              </button>
              <button
                onClick={() => setConfirming(false)}
                className="px-2.5 py-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground border border-border hover:bg-secondary transition-colors"
              >
                Cancel
              </button>
            </div>
          )}
        </>
      )}

      {success && (
        <div className="flex items-center gap-1.5 text-[11px] text-success">
          <CheckCircle className="w-3 h-3" />
          Routine queued for execution.
        </div>
      )}
      {error && (
        <div className="flex items-center gap-1.5 text-[11px] text-error">
          <AlertCircle className="w-3 h-3" />
          {error}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function AgentControls({ agentName, agent }: { agentName: string; agent: AgentStatus | null }) {
  return (
    <div className="space-y-4">
      <ProcessControls agentName={agentName} agent={agent} />
      <SendOrderSection agentName={agentName} />
      <TriggerRoutineSection agentName={agentName} />
    </div>
  );
}
