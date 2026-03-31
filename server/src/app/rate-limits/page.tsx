"use client";

import { Timer } from "lucide-react";
import { useRateLimits } from "@/hooks/use-rate-limits";
import { getAgentColor, relativeTime } from "@/lib/utils";
import { cn } from "@/lib/utils";
import type { IpStats } from "@/hooks/use-rate-limits";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GAME_LIMIT = 30;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rpmColor(rpm: number): string {
  if (rpm > 25) return "text-error";
  if (rpm > 20) return "text-warning";
  return "text-success";
}

function barColor(rpm: number): string {
  if (rpm > 25) return "bg-error";
  if (rpm > 20) return "bg-warning";
  return "bg-success";
}

// ---------------------------------------------------------------------------
// Sparkline (inline SVG, no chart library)
// ---------------------------------------------------------------------------

function Sparkline({ data, limit }: { data: number[]; limit: number }) {
  if (!data || data.length === 0) return null;

  const width = 120;
  const height = 32;
  const padX = 2;
  const padY = 2;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;

  // Scale to limit (game limit) so bars are comparable across IPs
  const maxVal = Math.max(limit, ...data);

  const barWidth = innerW / data.length;
  const bars = data.map((val, i) => {
    const barH = maxVal > 0 ? (val / maxVal) * innerH : 0;
    const x = padX + i * barWidth;
    const y = padY + innerH - barH;

    let fill = "#a3be8c"; // success green
    if (val > 25) fill = "#bf616a"; // error red
    else if (val > 20) fill = "#ebcb8b"; // warning yellow

    return (
      <rect
        key={i}
        x={x + 1}
        y={y}
        width={Math.max(barWidth - 2, 1)}
        height={Math.max(barH, 0)}
        fill={fill}
        opacity={i === data.length - 1 ? 1 : 0.6}
      />
    );
  });

  // Limit line at 30 rpm
  const limitY = padY + innerH - (limit / maxVal) * innerH;

  return (
    <svg width={width} height={height} className="block">
      {bars}
      <line
        x1={padX}
        y1={limitY}
        x2={width - padX}
        y2={limitY}
        stroke="#bf616a"
        strokeWidth={0.5}
        strokeDasharray="3 2"
        opacity={0.6}
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Per-IP Card
// ---------------------------------------------------------------------------

function IpCard({ label, stats }: { label: string; stats: IpStats }) {
  const { agents, rpm, history } = stats;
  const pct = Math.round((rpm / GAME_LIMIT) * 100);

  return (
    <div className="bg-card border border-border p-4 rounded-sm space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-mono text-sm text-foreground font-semibold">{label}</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {agents.join(", ")}
          </div>
        </div>
        <div className={cn("text-xl font-bold font-mono tabular-nums", rpmColor(rpm))}>
          {rpm}
          <span className="text-xs text-muted-foreground font-normal ml-1">rpm</span>
        </div>
      </div>

      {/* Usage bar */}
      <div>
        <div className="flex justify-between text-xs text-muted-foreground mb-1">
          <span>{rpm} / {GAME_LIMIT} req/min</span>
          <span>{pct}%</span>
        </div>
        <div className="h-2 bg-secondary rounded-full overflow-hidden">
          <div
            className={cn("h-full rounded-full transition-all", barColor(rpm))}
            style={{ width: `${Math.min(pct, 100)}%` }}
          />
        </div>
      </div>

      {/* Agent dots */}
      <div className="flex flex-wrap gap-1.5">
        {agents.map((agent) => (
          <span
            key={agent}
            className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-sm bg-secondary font-mono"
          >
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: getAgentColor(agent) }}
            />
            {agent}
          </span>
        ))}
      </div>

      {/* Sparkline */}
      <div>
        <div className="text-xs text-muted-foreground/60 mb-1">Last 10 minutes</div>
        <Sparkline data={history} limit={GAME_LIMIT} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function RateLimitsPage() {
  const { data, loading, error } = useRateLimits();

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Timer className="w-5 h-5 text-primary" />
        <h1 className="text-lg font-semibold text-primary uppercase tracking-wider">
          Rate Limits
        </h1>
        <span className="text-xs text-muted-foreground ml-2">
          Game limit: {GAME_LIMIT} req/min/IP · 5 agents · 3 exit IPs
        </span>
      </div>

      {loading && !data && (
        <div className="text-muted-foreground text-sm">Loading rate limit data...</div>
      )}

      {error && (
        <div className="bg-card border border-error/40 p-3 rounded-sm text-error text-sm">
          Failed to load: {error}
        </div>
      )}

      {data && (
        <>
          {/* Per-IP Cards */}
          <section className="space-y-2">
            <h2 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground/70">
              By Exit IP
            </h2>
            {Object.keys(data.by_ip).length === 0 ? (
              <div className="bg-card border border-border p-4 rounded-sm text-muted-foreground text-sm">
                No activity recorded yet — waiting for agent API calls.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {Object.entries(data.by_ip).map(([label, stats]) => (
                  <IpCard key={label} label={label} stats={stats} />
                ))}
              </div>
            )}
          </section>

          {/* Per-Agent Table */}
          <section className="space-y-2">
            <h2 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground/70">
              By Agent
            </h2>
            {Object.keys(data.by_agent).length === 0 ? (
              <div className="bg-card border border-border p-4 rounded-sm text-muted-foreground text-sm">
                No agent activity recorded yet.
              </div>
            ) : (
              <div className="bg-card border border-border rounded-sm overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground/70 text-left">
                      <th className="px-4 py-2 font-medium">Agent</th>
                      <th className="px-4 py-2 font-medium">RPM</th>
                      <th className="px-4 py-2 font-medium">429s (window)</th>
                      <th className="px-4 py-2 font-medium">Last 429</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(data.by_agent).map(([agent, stats]) => (
                      <tr key={agent} className="border-b border-border/30 last:border-0">
                        <td className="px-4 py-2">
                          <span className="inline-flex items-center gap-1.5 font-mono">
                            <span
                              className="w-2 h-2 rounded-full shrink-0"
                              style={{ backgroundColor: getAgentColor(agent) }}
                            />
                            {agent}
                          </span>
                        </td>
                        <td className={cn("px-4 py-2 font-mono font-semibold tabular-nums", rpmColor(stats.rpm))}>
                          {stats.rpm}
                        </td>
                        <td className={cn(
                          "px-4 py-2 font-mono tabular-nums",
                          stats.rate_limited > 0 ? "text-error font-semibold" : "text-muted-foreground"
                        )}>
                          {stats.rate_limited}
                        </td>
                        <td className="px-4 py-2 font-mono text-muted-foreground">
                          {stats.last_429 ? relativeTime(stats.last_429) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Recent 429 Events */}
          <section className="space-y-2">
            <h2 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground/70">
              Recent 429 Events
            </h2>
            {data.recent_429s.length === 0 ? (
              <div className="bg-card border border-border p-4 rounded-sm text-muted-foreground text-sm">
                No rate limit events — fleet is within limits.
              </div>
            ) : (
              <div className="bg-card border border-border rounded-sm overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground/70 text-left">
                      <th className="px-4 py-2 font-medium">Agent</th>
                      <th className="px-4 py-2 font-medium">Tool</th>
                      <th className="px-4 py-2 font-medium">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent_429s.map((ev, i) => (
                      <tr key={i} className="border-b border-border/30 last:border-0">
                        <td className="px-4 py-2">
                          <span className="inline-flex items-center gap-1.5 font-mono">
                            <span
                              className="w-2 h-2 rounded-full shrink-0"
                              style={{ backgroundColor: getAgentColor(ev.agent) }}
                            />
                            {ev.agent}
                          </span>
                        </td>
                        <td className="px-4 py-2 font-mono text-foreground">{ev.tool}</td>
                        <td className="px-4 py-2 font-mono text-muted-foreground">
                          {relativeTime(ev.timestamp)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
