"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentWatchdogState {
  desiredState: string;
  consecutiveRestarts: number;
  nextRestartAfterMs: number;
  backoffRemainingSec: number;
}

interface HealthMonitorData {
  agents: Record<string, AgentWatchdogState>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBackoff(sec: number): string {
  if (sec <= 0) return "—";
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function restartsColor(count: number): string {
  if (count >= 3) return "text-error font-semibold";
  if (count >= 1) return "text-warning font-semibold";
  return "text-muted-foreground";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HealthMonitorPanel() {
  const [data, setData] = useState<HealthMonitorData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    async function load() {
      try {
        const res = await fetch("/api/diagnostics/health-monitor");
        if (!res.ok) throw new Error(`API ${res.status}`);
        const json = await res.json() as HealthMonitorData;
        if (mounted) {
          setData(json);
          setError(null);
        }
      } catch (err) {
        if (mounted) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();
    const interval = setInterval(load, 10_000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  const agentEntries = data ? Object.entries(data.agents) : [];

  return (
    <div className="bg-card border border-border p-4 rounded-sm space-y-3">
      <h2 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground/70">
        Fleet Health Watchdog
      </h2>

      {loading && (
        <div className="text-muted-foreground text-xs">Loading…</div>
      )}

      {error && (
        <div className="text-error text-xs">Failed to load: {error}</div>
      )}

      {data && agentEntries.length === 0 && (
        <div className="text-muted-foreground text-xs italic">
          No agents tracked yet — monitor initialises on first start/stop event.
        </div>
      )}

      {data && agentEntries.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-muted-foreground/70 text-left">
                <th className="pb-1 pr-4 font-medium">Agent</th>
                <th className="pb-1 pr-4 font-medium">Desired State</th>
                <th className="pb-1 pr-4 font-medium">Restarts</th>
                <th className="pb-1 font-medium">Backoff</th>
              </tr>
            </thead>
            <tbody>
              {agentEntries.map(([name, state]) => (
                <tr key={name} className="border-b border-border/30 last:border-0">
                  <td className="py-1 pr-4 font-mono text-foreground">{name}</td>
                  <td className="py-1 pr-4 font-mono">
                    <span
                      className={cn(
                        state.desiredState === "running"
                          ? "text-success"
                          : "text-muted-foreground",
                      )}
                    >
                      {state.desiredState}
                    </span>
                  </td>
                  <td className={cn("py-1 pr-4 font-mono", restartsColor(state.consecutiveRestarts))}>
                    {state.consecutiveRestarts}
                  </td>
                  <td className="py-1 font-mono text-muted-foreground">
                    {formatBackoff(state.backoffRemainingSec)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
