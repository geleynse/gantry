"use client";

import { cn } from "@/lib/utils";
import type { Standings, EmpireStanding } from "@/hooks/use-game-state";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True when any standing field has a notable (non-zero) value to display. */
function hasNotableStanding(standing: EmpireStanding): boolean {
  return (
    (typeof standing.reputation === "number" && standing.reputation !== 0) ||
    (typeof standing.bounty === "number" && standing.bounty !== 0)
  );
}

/**
 * Colour class for the reputation value.
 * Police attack on sight at reputation ≤ −20 (v0.280 mechanic).
 * Bounty > 0 means docking triggers 24 h detention if unpaid.
 */
function reputationClass(reputation: number): string {
  if (reputation <= -20) return "text-red-400 font-semibold";
  if (reputation < 0) return "text-orange-400";
  if (reputation >= 25) return "text-green-400";
  return "text-foreground/80";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface StandingsPanelProps {
  standings?: Standings | null;
}

const EMPTY_PANEL = (
  <div className="border-t border-border pt-2 mt-2">
    <div className="text-[10px] uppercase tracking-widest text-muted-foreground/70 mb-1">
      Standings
    </div>
    <div className="text-[9px] text-muted-foreground/50 italic">—</div>
  </div>
);

export function StandingsPanel({ standings }: StandingsPanelProps) {
  if (!standings || typeof standings !== "object") return EMPTY_PANEL;

  const entries = Object.entries(standings).filter(
    ([_, s]) => s && typeof s === "object" && hasNotableStanding(s)
  );

  if (entries.length === 0) return EMPTY_PANEL;

  return (
    <div className="border-t border-border pt-2 mt-2">
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground/70 mb-1">
        Standings
      </div>
      <div className="space-y-0.5">
        {entries.map(([empire, standing]) => {
          const rep = standing.reputation ?? 0;
          const bounty = standing.bounty ?? 0;
          const isPirates = empire.toLowerCase() === "pirates";

          return (
            <div key={empire} className="text-[9px] flex items-start gap-1.5">
              <span
                className={cn(
                  "shrink-0 font-mono text-muted-foreground/70 w-16 truncate",
                  isPirates && "text-red-400/70"
                )}
                title={empire}
              >
                {empire}:
              </span>
              <div className="flex flex-wrap gap-x-1.5 gap-y-0.5">
                <span
                  className={cn("whitespace-nowrap", reputationClass(rep))}
                  title={`reputation: ${rep}`}
                >
                  rep&nbsp;{rep}
                </span>
                {bounty > 0 && (
                  <span
                    className="whitespace-nowrap text-red-400/80"
                    title={`bounty: ${bounty.toLocaleString()}cr`}
                  >
                    bounty&nbsp;{bounty.toLocaleString()}cr
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
