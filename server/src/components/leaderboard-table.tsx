"use client";

import { AGENT_NAMES, AGENT_COLORS } from "@/lib/utils";
import type { LeaderboardEntry } from "@/hooks/use-leaderboard";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert "My Agent" → "drifter-gale" for fleet detection */
function displayNameToSlug(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-");
}

function isFleetAgent(username: string): boolean {
  const slug = displayNameToSlug(username);
  return (AGENT_NAMES as readonly string[]).includes(slug);
}

function getAgentColor(username: string): string | undefined {
  const slug = displayNameToSlug(username);
  return AGENT_COLORS[slug];
}

function RankBadge({ rank }: { rank: number }) {
  if (rank === 1) {
    return (
      <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-yellow-500/20 text-yellow-400 font-bold text-xs font-mono">
        1
      </span>
    );
  }
  if (rank === 2) {
    return (
      <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-slate-400/20 text-slate-300 font-bold text-xs font-mono">
        2
      </span>
    );
  }
  if (rank === 3) {
    return (
      <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-orange-700/20 text-orange-400 font-bold text-xs font-mono">
        3
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-center w-6 h-6 text-muted-foreground font-mono text-xs">
      {rank}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

export function LeaderboardSkeleton({ rows = 10 }: { rows?: number }) {
  return (
    <div className="bg-card border border-border overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-xs text-muted-foreground uppercase tracking-wider">
            <th className="text-center px-3 py-2 w-12">#</th>
            <th className="text-left px-3 py-2">Player</th>
            <th className="text-right px-3 py-2">Value</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }).map((_, i) => (
            <tr key={i} className="border-b border-border/50">
              <td className="px-3 py-2 text-center">
                <div className="w-6 h-4 bg-muted/30 rounded animate-pulse mx-auto" />
              </td>
              <td className="px-3 py-2">
                <div className="w-32 h-4 bg-muted/30 rounded animate-pulse" />
              </td>
              <td className="px-3 py-2">
                <div className="w-20 h-4 bg-muted/30 rounded animate-pulse ml-auto" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main table
// ---------------------------------------------------------------------------

interface LeaderboardTableProps {
  entries: LeaderboardEntry[];
  statKey: string;
  statLabel: string;
  loading?: boolean;
  nameKey?: string;
}

export function LeaderboardTable({
  entries,
  statKey,
  statLabel,
  loading = false,
  nameKey = "username",
}: LeaderboardTableProps) {
  if (loading && entries.length === 0) {
    return <LeaderboardSkeleton />;
  }

  return (
    <div className="bg-card border border-border overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-xs text-muted-foreground uppercase tracking-wider">
            <th className="text-center px-3 py-2 w-12">#</th>
            <th className="text-left px-3 py-2">Name</th>
            <th className="text-right px-3 py-2">{statLabel}</th>
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 ? (
            <tr>
              <td colSpan={3} className="px-3 py-6 text-center text-muted-foreground text-xs">
                {loading ? "Loading..." : "No data available"}
              </td>
            </tr>
          ) : (
            entries.map((entry, idx) => {
              const displayName = String(entry[nameKey as keyof LeaderboardEntry] ?? "");
              const fleet = isFleetAgent(displayName);
              const agentColor = fleet ? getAgentColor(displayName) : undefined;
              const rank = entry.rank ?? idx + 1;
              const value = entry[statKey as keyof LeaderboardEntry];
              const formattedValue =
                typeof value === "number"
                  ? value.toLocaleString()
                  : value != null
                  ? String(value)
                  : "—";

              return (
                <tr
                  key={`${displayName}-${rank}`}
                  className={`border-b border-border/50 transition-colors ${
                    fleet ? "bg-primary/5 hover:bg-primary/10" : "hover:bg-secondary/30"
                  }`}
                  style={fleet && agentColor ? { borderLeft: `3px solid ${agentColor}` } : undefined}
                >
                  <td className="px-3 py-2 text-center">
                    <RankBadge rank={rank} />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span
                        className="font-mono text-xs"
                        style={agentColor ? { color: agentColor } : undefined}
                      >
                        {displayName}
                      </span>
                      {fleet && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-primary/30 text-primary/70 leading-none">
                          fleet
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground">
                    {formattedValue}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
