"use client";

import { useState, useEffect } from "react";
import { Play, Square, Eye, RotateCw, List, LayoutGrid } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import { useFleetStatus } from "@/hooks/use-fleet-status";
import { useGameState } from "@/hooks/use-game-state";
import { AgentCard } from "@/components/agent-card";
import { FleetStatusSummary } from "@/components/fleet-status-summary";
import { useAgentNames } from "@/hooks/use-agent-names";
import { useOverseerStatus } from "@/hooks/use-overseer";

function OverseerBanner() {
  const { data: overseer } = useOverseerStatus();
  const { data: fleetStatus } = useFleetStatus();
  const { isAdmin } = useAuth();
  const overseerAgent = fleetStatus?.agents.find((a) => a.name === "overseer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => setError(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [error]);

  if (!overseerAgent) return null;

  const isRunning = overseerAgent.llmRunning;

  async function handleControl(action: "start" | "stop" | "restart", e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/agents/overseer/${action}`, { method: "POST" });
      if (!response.ok) throw new Error(`Failed to ${action} overseer: ${response.statusText}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center border border-border bg-card mb-4">
      <Link
        href="/overseer"
        className="flex items-center gap-4 flex-1 min-w-0 px-4 py-3 hover:bg-secondary/30 transition-colors"
      >
        <Eye className="w-5 h-5 text-primary shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm text-foreground">Overseer</span>
            <span className={cn(
              "text-[10px] font-mono px-1.5 py-0.5 border",
              isRunning
                ? "text-success border-success/30 bg-success/10"
                : "text-muted-foreground border-border"
            )}>
              {isRunning ? "ACTIVE" : "IDLE"}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-6 text-xs font-mono text-muted-foreground shrink-0">
          {overseerAgent.model && (
            <div>
              <span className="text-[10px] uppercase tracking-wider block">Model</span>
              <span className="text-foreground">{overseerAgent.model}</span>
            </div>
          )}
          <div>
            <span className="text-[10px] uppercase tracking-wider block">Decisions</span>
            <span className="text-foreground">{overseer?.decisionsToday ?? "—"}</span>
          </div>
          <div>
            <span className="text-[10px] uppercase tracking-wider block">Cost Today</span>
            <span className="text-foreground">
              {overseer?.costToday != null ? `$${overseer.costToday.toFixed(4)}` : "—"}
            </span>
          </div>
        </div>
      </Link>
      {isAdmin && (
        <div className="flex flex-col items-end gap-1 px-3 border-l border-border py-3 shrink-0">
          <div className="flex items-center gap-1">
            {!isRunning ? (
              <button
                onClick={(e) => handleControl("start", e)}
                disabled={busy}
                className="p-1.5 text-success hover:bg-success/10 border border-success/30 rounded transition-colors disabled:opacity-50"
                title="Start overseer"
              >
                <Play className="w-3.5 h-3.5" />
              </button>
            ) : (
              <button
                onClick={(e) => handleControl("stop", e)}
                disabled={busy}
                className="p-1.5 text-error hover:bg-error/10 border border-error/30 rounded transition-colors disabled:opacity-50"
                title="Stop overseer (Shift+Click for force kill)"
              >
                <Square className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              onClick={(e) => handleControl("restart", e)}
              disabled={busy}
              className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary border border-border rounded transition-colors disabled:opacity-50"
              title="Restart overseer"
            >
              <RotateCw className="w-3.5 h-3.5" />
            </button>
          </div>
          {error && (
            <div className="text-xs text-destructive bg-destructive/10 rounded px-2 py-1">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function DashboardPage() {
  const { isAdmin } = useAuth();
  const { data: fleetStatus, connected, error: sseError } = useFleetStatus();
  const { data: gameStates, loading: gameLoading } = useGameState();
  const agentNames = useAgentNames();
  const [fleetBusy, setFleetBusy] = useState(false);
  const [compactView, setCompactView] = useState(false);

  async function fleetAction(action: "start-all" | "stop-all") {
    setFleetBusy(true);
    try {
      await apiFetch(`/agents/${action}`, { method: "POST" });
    } catch (err) {
      console.error(`Fleet ${action} failed:`, err);
    } finally {
      setFleetBusy(false);
    }
  }

  // Derived summary stats
  const totalCredits =
    gameStates != null
      ? Object.values(gameStates).reduce((sum, gs) => sum + (gs.credits ?? 0), 0)
      : null;

  const proxyHealthy = fleetStatus?.actionProxy?.healthy ?? null;

  const isConnecting = !fleetStatus && !sseError;

  return (
    <div className="space-y-6">
      {/* Summary strip */}
      <div className="flex flex-wrap items-center gap-3 md:gap-6 border-b border-primary/20 pb-4">
        <h1 className="text-lg font-semibold text-primary uppercase tracking-wider mr-2 w-full sm:w-auto">
          {fleetStatus?.fleetName ?? "Dashboard"}
        </h1>

        <div className="flex flex-wrap items-center gap-3 md:gap-6 text-xs">
          {/* Total credits */}
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground uppercase tracking-wider text-[10px]">
              Fleet Credits
            </span>
            <span className="font-mono text-foreground">
              {totalCredits !== null ? totalCredits.toLocaleString() + " cr" : "—"}
            </span>
          </div>

          {/* Total cost placeholder */}
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground uppercase tracking-wider text-[10px]">
              Session Cost
            </span>
            <span className="font-mono text-muted-foreground">$0.00</span>
          </div>

          {/* Agent state summary */}
          {fleetStatus && (
            <FleetStatusSummary agents={fleetStatus.agents} />
          )}
          {isConnecting && (
            <span className="text-muted-foreground font-mono text-[10px]">—</span>
          )}

          {/* Proxy status */}
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground uppercase tracking-wider text-[10px]">
              Proxy
            </span>
            <span
              className={cn(
                "inline-block w-2.5 h-2.5 rounded-full",
                proxyHealthy === true && "bg-success",
                proxyHealthy === false && "bg-error",
                proxyHealthy === null && "bg-muted-foreground opacity-50"
              )}
              title={
                proxyHealthy === true
                  ? "Proxy online"
                  : proxyHealthy === false
                  ? "Proxy offline"
                  : "Unknown"
              }
            />
          </div>

          {/* SSE connection indicator */}
          {sseError && (
            <span className="text-error text-[10px]">{sseError}</span>
          )}
          {!connected && !sseError && !isConnecting && (
            <span className="text-warning text-[10px]">Reconnecting…</span>
          )}
        </div>

        {/* Fleet controls */}
        <div className="flex items-center gap-1.5 ml-auto w-full sm:w-auto mt-2 sm:mt-0">
          <button
            onClick={() => setCompactView((v) => !v)}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground hover:bg-secondary border border-border transition-colors"
            title={compactView ? "Grid view" : "Compact view"}
          >
            {compactView ? <LayoutGrid className="w-3 h-3" /> : <List className="w-3 h-3" />}
            {compactView ? "Grid" : "Compact"}
          </button>
          {isAdmin && (
            <>
              <button
                onClick={() => fleetAction("start-all")}
                disabled={fleetBusy}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-success hover:bg-success/10 border border-success/30 transition-colors disabled:opacity-50"
                title="Start all agents"
              >
                <Play className="w-3 h-3" /> Start All
              </button>
              <button
                onClick={() => fleetAction("stop-all")}
                disabled={fleetBusy}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-error hover:bg-error/10 border border-error/30 transition-colors disabled:opacity-50"
                title="Stop all agents"
              >
                <Square className="w-3 h-3" /> Stop All
              </button>
            </>
          )}
        </div>
      </div>

      {/* Agent grid — show connecting indicator until first SSE event arrives */}
      {isConnecting ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20">
          <div className="flex gap-1.5">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="w-2 h-2 rounded-full bg-primary/60 animate-bounce"
                style={{ animationDelay: `${-0.3 + i * 0.15}s` }}
              />
            ))}
          </div>
          <p className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground">
            Connecting to fleet…
          </p>
        </div>
      ) : agentNames.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
          <p className="text-sm text-muted-foreground">No agents configured yet.</p>
          <p className="text-xs text-muted-foreground/70">
            Go to{" "}
            <a href="/fleet" className="text-primary hover:underline">
              Fleet
            </a>{" "}
            to enroll your first agent.
          </p>
        </div>
      ) : (
        <>
        <OverseerBanner />
        <div className={compactView ? "space-y-1" : "grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4"}>
          {agentNames.map((name) => {
            const agent = fleetStatus?.agents.find((a) => a.name === name) ?? null;
            const gs = gameStates?.[name] ?? null;

            return (
              <AgentCard
                key={name}
                agent={gameLoading ? null : agent}
                gameState={gs}
                name={name}
                compact={compactView}
              />
            );
          })}
        </div>
        </>
      )}
    </div>
  );
}
