"use client";

import { useEffect, useState } from "react";
import { Power, Play, Square, RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentStatus } from "@/hooks/use-fleet-status";

// ---------------------------------------------------------------------------
// Agent control action buttons
// ---------------------------------------------------------------------------

export interface AgentActionsProps {
  agent: AgentStatus;
  isAdmin: boolean;
}

export function AgentActions({ agent, isAdmin }: AgentActionsProps) {
  const name = agent.name;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => setError(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [error]);

  async function handleStart(e: React.MouseEvent<HTMLButtonElement>) {
    e.stopPropagation();
    if (!name) return;
    setError(null);
    try {
      const response = await fetch(`/api/agents/${name}/start`, { method: "POST" });
      if (!response.ok) throw new Error(`Failed to start agent: ${response.statusText}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleStop(e: React.MouseEvent<HTMLButtonElement>) {
    e.stopPropagation();
    if (!name) return;
    const force = e.shiftKey;
    setError(null);
    try {
      const response = await fetch(`/api/agents/${name}/stop${force ? "?force=true" : ""}`, { method: "POST" });
      if (!response.ok) throw new Error(`Failed to stop agent: ${response.statusText}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRestart(e: React.MouseEvent<HTMLButtonElement>) {
    e.stopPropagation();
    if (!name) return;
    const force = e.shiftKey;
    setError(null);
    try {
      const response = await fetch(`/api/agents/${name}/restart${force ? "?force=true" : ""}`, { method: "POST" });
      if (!response.ok) throw new Error(`Failed to restart agent: ${response.statusText}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleShutdown(e: React.MouseEvent<HTMLButtonElement>) {
    e.stopPropagation();
    if (!name) return;
    setError(null);
    try {
      const response = await fetch(`/api/agents/${name}/shutdown`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "User initiated" }),
      });
      if (!response.ok) throw new Error(`Failed to initiate shutdown: ${response.statusText}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!isAdmin) return null;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        {!agent.llmRunning ? (
          <button
            onClick={handleStart}
            className="p-1.5 text-success hover:bg-success/10 border border-success/30 rounded transition-colors"
            title="Start agent loop"
          >
            <Play className="w-3.5 h-3.5" />
          </button>
        ) : (
          <>
            <button
              onClick={handleStop}
              className="p-1.5 text-error hover:bg-error/10 border border-error/30 rounded transition-colors"
              title="Stop agent (Shift+Click for force kill)"
            >
              <Square className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleShutdown}
              disabled={agent.shutdownState !== "none" || agent.state === "stopped"}
              className={cn(
                "p-1.5 rounded border transition-all",
                agent.shutdownState !== "none" || agent.state === "stopped"
                  ? "bg-muted text-muted-foreground border-border cursor-not-allowed opacity-50"
                  : "bg-error/5 text-error border-error/30 hover:bg-error hover:text-white hover:border-error"
              )}
              title={agent.shutdownState !== "none" ? "Cannot shutdown in current state" : "Initiate graceful shutdown"}
            >
              <Power className="w-3.5 h-3.5" />
            </button>
          </>
        )}
        <button
          onClick={handleRestart}
          className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary border border-border rounded transition-colors"
          title="Restart agent (Shift+Click for force restart)"
        >
          <RotateCw className="w-3.5 h-3.5" />
        </button>
      </div>
      {error && (
        <div className="text-xs text-destructive bg-destructive/10 rounded px-2 py-1 mt-1">
          {error}
        </div>
      )}
    </div>
  );
}
