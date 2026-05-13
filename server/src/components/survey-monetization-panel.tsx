"use client";

/**
 * Per-agent survey-monetization adoption panel.
 *
 * Renders only for the two scout agents whose prompts pin a tagged-note
 * income channel (drifter-gale → INTEL-*, lumen-shoal → BELT-REPORT-*).
 * For every other agent it returns null so the parent can drop it in
 * without a guard.
 *
 * Read-only — pulls /api/survey-monetization?agent=<name> and shows:
 *   - notesPosted (24h headline + window total)
 *   - sell-through %
 *   - credits earned
 *   - last-posted timestamp
 *
 * If notesPosted is zero we say so loudly. The whole point of this panel
 * is to make a 0 visible to the operator.
 */

import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { relativeTime } from "@/lib/time";

const SUPPORTED_AGENTS = new Set(["drifter-gale", "lumen-shoal"]);

interface AgentSummary {
  agent: string;
  prefix: string;
  targetPrice: number;
  notesPosted: number;
  notesPostedSuccessful: number;
  notesPosted24h: number;
  sellThroughRate: number | null;
  totalCreditsEarned: number;
  lastPostedAt: string | null;
}

interface RecentNote {
  id: number;
  recordedAgent: string;
  prefix: string;
  taggedFor: string | null;
  region: string | null;
  tagDate: string | null;
  title: string;
  price: number | null;
  postedAt: string;
  success: boolean;
  errorCode: string | null;
  sold: boolean | null;
  salePrice: number | null;
}

interface ApiResponse {
  hours: number;
  agents: AgentSummary[];
  recent: RecentNote[];
}

type Window = 24 | 168;

function formatPct(ratio: number | null): string {
  if (ratio === null) return "—";
  return `${(ratio * 100).toFixed(0)}%`;
}

function adoptionTone(notesPosted: number): string {
  if (notesPosted >= 5) return "text-success";
  if (notesPosted > 0)  return "text-warning";
  return "text-error";
}

function sellThroughTone(rate: number | null): string {
  if (rate === null)  return "text-muted-foreground";
  if (rate >= 0.5)    return "text-success";
  if (rate > 0)       return "text-warning";
  return "text-error";
}

interface Props {
  agentName: string;
}

/**
 * Top-level panel. Renders nothing for non-survey agents so the host page
 * doesn't need to know which agents are surveyors.
 */
export function SurveyMonetizationPanel({ agentName }: Props) {
  if (!SUPPORTED_AGENTS.has(agentName)) return null;

  const [data, setData] = useState<ApiResponse | null>(null);
  const [hours, setHours] = useState<Window>(24);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/survey-monetization?agent=${encodeURIComponent(agentName)}&hours=${hours}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as ApiResponse;
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [agentName, hours]);

  useEffect(() => { load(); }, [load]);

  const summary = (data && Array.isArray(data.agents))
    ? data.agents.find((a) => a.agent === agentName) ?? null
    : null;
  const recent = (data && Array.isArray(data.recent)) ? data.recent : [];

  return (
    <div className="bg-card border border-border p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 border-b border-border pb-2">
        <h3 className="text-[10px] uppercase tracking-wider text-foreground/70">
          Survey Monetization
        </h3>
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
      </div>

      {error && (
        <div className="text-[11px] text-error">Error: {error}</div>
      )}

      {loading && !data ? (
        <p className="text-[11px] text-muted-foreground italic">Loading…</p>
      ) : !summary ? (
        <p className="text-[11px] text-muted-foreground italic">No data</p>
      ) : (
        <>
          {/* Tag spec */}
          <div className="text-[11px] text-muted-foreground">
            Target tag: <span className="font-mono text-foreground">{summary.prefix}*</span>
            {" · "}
            target price: <span className="font-mono text-foreground">{summary.targetPrice}cr</span>
          </div>

          {/* Headline metrics — 4-up grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div className="space-y-0.5">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Posted 24h
              </div>
              <div className={cn("font-mono text-sm", adoptionTone(summary.notesPosted24h))}>
                {summary.notesPosted24h}
              </div>
            </div>

            <div className="space-y-0.5">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Posted ({hours === 24 ? "24h" : "7d"})
              </div>
              <div className="font-mono text-sm text-foreground">
                {summary.notesPosted}
                {summary.notesPostedSuccessful !== summary.notesPosted && (
                  <span className="ml-1 text-[10px] text-warning">
                    ({summary.notesPostedSuccessful} ok)
                  </span>
                )}
              </div>
            </div>

            <div className="space-y-0.5">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Sell-through
              </div>
              <div className={cn("font-mono text-sm", sellThroughTone(summary.sellThroughRate))}>
                {formatPct(summary.sellThroughRate)}
              </div>
            </div>

            <div className="space-y-0.5">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Earned
              </div>
              <div className="font-mono text-sm text-foreground">
                {summary.totalCreditsEarned > 0
                  ? `${summary.totalCreditsEarned.toLocaleString()}cr`
                  : "—"}
              </div>
            </div>
          </div>

          {/* Last posted line */}
          <div className="text-[11px] text-muted-foreground border-t border-border/40 pt-2">
            {summary.lastPostedAt
              ? <>Last note: <span className="text-foreground">{relativeTime(summary.lastPostedAt)}</span></>
              : <span className="italic">No notes posted in this window. Prompt instructs ≥1/session.</span>}
          </div>

          {/* Recent notes table — collapsed if zero */}
          {recent.length > 0 && (
            <div className="overflow-x-auto pt-1">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-border/60 text-muted-foreground">
                    <th className="text-left font-normal uppercase tracking-wider text-[10px] py-1 pr-3">When</th>
                    <th className="text-left font-normal uppercase tracking-wider text-[10px] py-1 pr-3">Title</th>
                    <th className="text-right font-normal uppercase tracking-wider text-[10px] py-1 pr-3">Price</th>
                    <th className="text-right font-normal uppercase tracking-wider text-[10px] py-1 pl-2">Sold</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.slice(0, 10).map((n) => (
                    <tr key={n.id} className="border-b border-border/20 last:border-b-0">
                      <td className="py-1.5 pr-3 text-muted-foreground font-mono whitespace-nowrap">
                        {relativeTime(n.postedAt)}
                      </td>
                      <td className="py-1.5 pr-3 font-mono text-foreground/90 truncate max-w-[200px]" title={n.title}>
                        {n.title}
                        {n.taggedFor && n.taggedFor !== n.recordedAgent && (
                          <span className="ml-1.5 text-[9px] text-warning">misuse</span>
                        )}
                      </td>
                      <td className="py-1.5 pr-3 text-right font-mono text-muted-foreground">
                        {n.price !== null ? `${n.price}cr` : "—"}
                      </td>
                      <td className={cn(
                        "py-1.5 pl-2 text-right font-mono",
                        n.sold === true ? "text-success" : n.sold === false ? "text-warning" : "text-muted-foreground",
                      )}>
                        {n.sold === true ? "yes" : n.sold === false ? "no" : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Test exports — keep helpers reachable for unit tests.
export const __test__ = { SUPPORTED_AGENTS, formatPct, adoptionTone, sellThroughTone };
