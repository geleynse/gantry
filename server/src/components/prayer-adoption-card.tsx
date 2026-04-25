"use client";

/**
 * Fleet-wide prayer adoption card for the diagnostics page.
 *
 * Pulls /api/prayer/adoption with a 24h/7d window toggle. Renders a single
 * table row per agent with: adoption ratio, prayer/turn counts, success
 * rate, avg steps, error count, last prayer.
 */

import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";
import { Sparkles, RefreshCw } from "lucide-react";
import { formatAbsolute, relativeTime } from "@/lib/time";

interface AgentAdoption {
  agent: string;
  prayEnabled: boolean;
  prayerCount: number;
  turnCount: number;
  adoptionRatio: number;
  avgStepsExecuted: number | null;
  successRate: number | null;
  completedCount: number;
  errorCount: number;
  lastPrayerAt: string | null;
}

type Window = 24 | 168;

function formatPct(ratio: number | null): string {
  if (ratio === null) return "—";
  return `${(ratio * 100).toFixed(0)}%`;
}

function formatAvg(n: number | null): string {
  if (n === null) return "—";
  return n.toFixed(1);
}

function adoptionTone(ratio: number): string {
  if (ratio >= 0.2) return "text-success";
  if (ratio > 0)    return "text-warning";
  return "text-muted-foreground";
}

function successTone(rate: number | null): string {
  if (rate === null) return "text-muted-foreground";
  if (rate >= 0.9)   return "text-success";
  if (rate >= 0.6)   return "text-warning";
  return "text-error";
}

export function PrayerAdoptionCard() {
  const [adoption, setAdoption] = useState<AgentAdoption[]>([]);
  const [hours, setHours] = useState<Window>(24);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ hours: number; adoption: AgentAdoption[] }>(`/prayer/adoption?hours=${hours}`);
      setAdoption(res.adoption);
    } catch (err) {
      setError((err as Error).message ?? "Failed to load prayer adoption");
    } finally {
      setLoading(false);
    }
  }, [hours]);

  useEffect(() => { load(); }, [load]);

  const totals = adoption.reduce((acc, row) => {
    acc.prayerCount += row.prayerCount;
    acc.turnCount += row.turnCount;
    acc.completed += row.completedCount;
    acc.errors += row.errorCount;
    return acc;
  }, { prayerCount: 0, turnCount: 0, completed: 0, errors: 0 });

  const enabledAgents = adoption.filter((r) => r.prayEnabled);

  return (
    <div className="bg-card border border-border p-4 space-y-3 rounded-sm">
      <div className="flex items-center justify-between gap-2 border-b border-border pb-2">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-violet-400" />
          <h3 className="text-xs uppercase tracking-wider font-semibold text-foreground/80">
            Prayer Adoption
          </h3>
          <span className="text-[10px] text-muted-foreground">
            {enabledAgents.length}/{adoption.length} agents prayer-enabled
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* Window toggle */}
          <div className="flex items-center gap-0 border border-border overflow-hidden">
            {([24, 168] as const).map((h) => (
              <button
                key={h}
                onClick={() => setHours(h)}
                className={cn(
                  "px-2 py-0.5 text-[10px] uppercase tracking-wider transition-colors",
                  hours === h
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {h === 24 ? "24h" : "7d"}
              </button>
            ))}
          </div>

          <button
            onClick={load}
            disabled={loading}
            className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors"
            title="Refresh"
          >
            <RefreshCw className={cn("w-3 h-3", loading && "animate-spin")} />
          </button>
        </div>
      </div>

      {error && (
        <div className="text-[11px] text-error">{error}</div>
      )}

      {loading && adoption.length === 0 ? (
        <div className="text-[11px] text-muted-foreground italic py-2">Loading…</div>
      ) : adoption.length === 0 ? (
        <div className="text-[11px] text-muted-foreground italic py-2">No agents configured</div>
      ) : (
        <>
          {/* Summary totals */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div className="space-y-0.5">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Fleet prayers</div>
              <div className="font-mono text-sm text-foreground">{totals.prayerCount}</div>
            </div>
            <div className="space-y-0.5">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Fleet turns</div>
              <div className="font-mono text-sm text-foreground">{totals.turnCount}</div>
            </div>
            <div className="space-y-0.5">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Completed</div>
              <div className="font-mono text-sm text-success">{totals.completed}</div>
            </div>
            <div className="space-y-0.5">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Errors</div>
              <div className={cn("font-mono text-sm", totals.errors > 0 ? "text-error" : "text-muted-foreground")}>
                {totals.errors}
              </div>
            </div>
          </div>

          {/* Per-agent table */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border/60 text-muted-foreground">
                  <th className="text-left font-sans font-normal uppercase tracking-wider text-[10px] py-1 pr-3">Agent</th>
                  <th className="text-right font-sans font-normal uppercase tracking-wider text-[10px] py-1 px-2">Adoption</th>
                  <th className="text-right font-sans font-normal uppercase tracking-wider text-[10px] py-1 px-2">Prayers</th>
                  <th className="text-right font-sans font-normal uppercase tracking-wider text-[10px] py-1 px-2">Turns</th>
                  <th className="text-right font-sans font-normal uppercase tracking-wider text-[10px] py-1 px-2">Success</th>
                  <th className="text-right font-sans font-normal uppercase tracking-wider text-[10px] py-1 px-2">Avg steps</th>
                  <th className="text-right font-sans font-normal uppercase tracking-wider text-[10px] py-1 px-2">Errors</th>
                  <th className="text-right font-sans font-normal uppercase tracking-wider text-[10px] py-1 pl-2">Last</th>
                </tr>
              </thead>
              <tbody>
                {adoption.map((row) => (
                  <tr
                    key={row.agent}
                    className={cn(
                      "border-b border-border/30 last:border-b-0",
                      !row.prayEnabled && "opacity-50",
                    )}
                  >
                    <td className="py-1.5 pr-3 text-foreground font-medium">
                      {row.agent}
                      {!row.prayEnabled && (
                        <span className="ml-1.5 text-[9px] uppercase tracking-wider text-muted-foreground">disabled</span>
                      )}
                    </td>
                    <td className={cn("py-1.5 px-2 text-right font-mono", adoptionTone(row.adoptionRatio))}>
                      {formatPct(row.adoptionRatio)}
                    </td>
                    <td className="py-1.5 px-2 text-right font-mono text-foreground">{row.prayerCount}</td>
                    <td className="py-1.5 px-2 text-right font-mono text-muted-foreground">{row.turnCount}</td>
                    <td className={cn("py-1.5 px-2 text-right font-mono", successTone(row.successRate))}>
                      {formatPct(row.successRate)}
                    </td>
                    <td className="py-1.5 px-2 text-right font-mono text-muted-foreground">
                      {formatAvg(row.avgStepsExecuted)}
                    </td>
                    <td className={cn("py-1.5 px-2 text-right font-mono", row.errorCount > 0 ? "text-error" : "text-muted-foreground")}>
                      {row.errorCount}
                    </td>
                    <td
                      className="py-1.5 pl-2 text-right font-mono text-[10px] text-muted-foreground"
                      title={row.lastPrayerAt ? relativeTime(row.lastPrayerAt) : undefined}
                    >
                      {row.lastPrayerAt ? formatAbsolute(row.lastPrayerAt) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

export const __test__ = { formatPct, formatAvg, adoptionTone, successTone };
