"use client";

import { cn } from "@/lib/utils";
import type { Standings, EmpireStanding } from "@/hooks/use-game-state";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reputation dimensions to display (in order). */
const REP_DIMS: Array<keyof EmpireStanding> = [
  "Fame",
  "Criminal",
  "CriminalEncounters",
  "Love",
  "Hate",
  "Fear",
  "Need",
];

function hasAnyNonZero(standing: EmpireStanding): boolean {
  return REP_DIMS.some((dim) => {
    const v = standing[dim];
    return typeof v === "number" && v !== 0;
  });
}

/** Colour class for a single standing value. */
function standingClass(dim: keyof EmpireStanding, value: number): string {
  if (dim === "Criminal" && value > 50) return "text-red-400 font-semibold";
  if (dim === "CriminalEncounters" && value > 50) return "text-red-400/80";
  if (dim === "Love" && value > 50) return "text-green-400 font-semibold";
  if (dim === "Fame" && value > 50) return "text-emerald-400";
  if (dim === "Hate" && value > 50) return "text-orange-400";
  if (dim === "Fear" && value > 50) return "text-yellow-400";
  return "text-foreground/80";
}

/** Compact label — shorten verbose dim names for pill display. */
function shortDimLabel(dim: keyof EmpireStanding): string {
  const labels: Partial<Record<keyof EmpireStanding, string>> = {
    CriminalEncounters: "Enc",
  };
  return labels[dim] ?? String(dim);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface StandingsPanelProps {
  standings?: Standings | null;
}

export function StandingsPanel({ standings }: StandingsPanelProps) {
  if (!standings || typeof standings !== "object") {
    return (
      <div className="border-t border-border pt-2 mt-2">
        <div className="text-[10px] uppercase tracking-widest text-muted-foreground/70 mb-1">
          Standings
        </div>
        <div className="text-[9px] text-muted-foreground/50 italic">—</div>
      </div>
    );
  }

  const entries = Object.entries(standings).filter(([_, standing]) =>
    standing && typeof standing === "object" && hasAnyNonZero(standing)
  );

  if (entries.length === 0) {
    return (
      <div className="border-t border-border pt-2 mt-2">
        <div className="text-[10px] uppercase tracking-widest text-muted-foreground/70 mb-1">
          Standings
        </div>
        <div className="text-[9px] text-muted-foreground/50 italic">—</div>
      </div>
    );
  }

  return (
    <div className="border-t border-border pt-2 mt-2">
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground/70 mb-1">
        Standings
      </div>
      <div className="space-y-0.5">
        {entries.map(([empire, standing]) => {
          const activeDims = REP_DIMS.filter(
            (dim) => typeof standing[dim] === "number" && standing[dim] !== 0
          );

          // Pirates row gets its own simple display
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
                {isPirates ? (
                  <span className="text-red-400/80">
                    {typeof (standing as Record<string, unknown>).standing === "number"
                      ? String((standing as Record<string, unknown>).standing)
                      : activeDims.map((dim) => `${shortDimLabel(dim)} ${standing[dim]}`).join(" / ")}
                  </span>
                ) : (
                  activeDims.map((dim) => {
                    const v = standing[dim] as number;
                    return (
                      <span
                        key={dim}
                        className={cn("whitespace-nowrap", standingClass(dim, v))}
                        title={`${dim}: ${v}`}
                      >
                        {shortDimLabel(dim)}&nbsp;{v}
                      </span>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
