"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LifetimeStats } from "@/hooks/use-game-state";

// ---------------------------------------------------------------------------
// Stat category definitions
// ---------------------------------------------------------------------------

interface StatCategory {
  label: string;
  color: string;
  keys: string[];
  keyPatterns?: RegExp[];
}

const STAT_CATEGORIES: StatCategory[] = [
  {
    label: "Combat",
    color: "text-error",
    keys: [
      "kills", "deaths", "pvp_kills", "npc_kills", "deaths_total",
      "damage_dealt", "damage_taken", "shots_fired", "shots_hit",
      "battles_won", "battles_lost", "battles_total",
      "kill_streak_best", "survived_battles",
    ],
    keyPatterns: [/kill|death|damage|battle|combat|attack|shot/i],
  },
  {
    label: "Navigation",
    color: "text-info",
    keys: [
      "jumps_total", "jumps", "distance_traveled", "systems_visited",
      "unique_systems", "wormholes_used", "hyperspace_entries",
    ],
    keyPatterns: [/jump|travel|distance|system|nav|hyperspac|wormhole/i],
  },
  {
    label: "Economy",
    color: "text-success",
    keys: [
      "credits_earned", "credits_spent", "credits_lost", "total_earnings",
      "trades_completed", "items_sold", "items_bought",
      "ore_mined", "cargo_delivered",
    ],
    keyPatterns: [/credit|trade|earn|spend|sold|bought|mine|cargo|market|profit/i],
  },
  {
    label: "Missions",
    color: "text-warning",
    keys: [
      "missions_completed", "missions_failed", "missions_accepted",
      "missions_abandoned", "mission_rewards_total",
    ],
    keyPatterns: [/mission/i],
  },
];

// Stats that don't match any category end up in "Other"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function categorize(stats: LifetimeStats): Map<string, Record<string, number | string>> {
  const result = new Map<string, Record<string, number | string>>();
  const claimed = new Set<string>();

  for (const cat of STAT_CATEGORIES) {
    const bucket: Record<string, number | string> = {};
    for (const [key, val] of Object.entries(stats)) {
      if (val === undefined || val === null) continue;
      const inKeys = cat.keys.includes(key);
      const inPatterns = cat.keyPatterns?.some((p) => p.test(key));
      if (inKeys || inPatterns) {
        bucket[key] = val;
        claimed.add(key);
      }
    }
    if (Object.keys(bucket).length > 0) {
      result.set(cat.label, bucket);
    }
  }

  // Remaining keys go into "Other"
  const other: Record<string, number | string> = {};
  for (const [key, val] of Object.entries(stats)) {
    if (!claimed.has(key) && val !== undefined && val !== null) {
      other[key] = val as number | string;
    }
  }
  if (Object.keys(other).length > 0) {
    result.set("Other", other);
  }

  return result;
}

function formatKey(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatValue(val: number | string): string {
  if (typeof val === "number") {
    if (Number.isInteger(val)) return val.toLocaleString();
    return val.toFixed(2);
  }
  return String(val);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatGrid({ bucket }: { bucket: Record<string, number | string> }) {
  const entries = Object.entries(bucket);
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
      {entries.map(([key, val]) => (
        <div key={key} className="bg-secondary/40 border border-border/50 px-3 py-2">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground mb-0.5">
            {formatKey(key)}
          </div>
          <div className="text-sm font-mono font-semibold text-foreground tabular-nums">
            {formatValue(val)}
          </div>
        </div>
      ))}
    </div>
  );
}

interface CollapsibleCategoryProps {
  label: string;
  color: string;
  bucket: Record<string, number | string>;
  defaultOpen?: boolean;
}

function CollapsibleCategory({ label, color, bucket, defaultOpen = true }: CollapsibleCategoryProps) {
  const [open, setOpen] = useState(defaultOpen);
  const count = Object.keys(bucket).length;

  return (
    <div className="bg-card border border-border">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-2.5 border-b border-border bg-secondary/30 hover:bg-secondary/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <ChevronRight
            className={cn("w-3.5 h-3.5 transition-transform text-muted-foreground", open && "rotate-90")}
          />
          <span className={cn("text-[10px] uppercase tracking-wider font-semibold", color)}>
            {label}
          </span>
        </div>
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {count} stat{count !== 1 ? "s" : ""}
        </span>
      </button>
      {open && (
        <div className="p-3">
          <StatGrid bucket={bucket} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

interface LifetimeStatsProps {
  stats: LifetimeStats;
}

export function LifetimeStatsPanel({ stats }: LifetimeStatsProps) {
  const totalStats = Object.keys(stats).length;
  if (totalStats === 0) {
    return (
      <div className="text-muted-foreground text-sm italic py-8 text-center">
        No lifetime stats available.
      </div>
    );
  }

  const categorized = categorize(stats);

  return (
    <div className="space-y-4">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {totalStats} metrics tracked
      </div>
      {Array.from(categorized.entries()).map(([label, bucket]) => {
        const catDef = STAT_CATEGORIES.find((c) => c.label === label);
        return (
          <CollapsibleCategory
            key={label}
            label={label}
            color={catDef?.color ?? "text-foreground"}
            bucket={bucket}
            defaultOpen={label !== "Other"}
          />
        );
      })}
    </div>
  );
}
