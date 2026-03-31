"use client";

/**
 * ShipComparison — shows stat deltas between two ships.
 *
 * Usage:
 *   <ShipComparison current={currentShipStats} target={targetShipStats} />
 *
 * Deltas:
 *   - Green  = improvement  (target > current for positive stats)
 *   - Red    = downgrade    (target < current)
 *   - Gray   = unchanged
 *   - Italic = no data for one side
 *
 * Format: "Hull: 500 (+200)" or "Speed: 3 (-1)"
 */

import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShipStats {
  /** Display name of the ship */
  name?: string;
  /** Ship class identifier */
  class_id?: string;
  /** Max hull points */
  hull?: number | null;
  /** Max cargo capacity */
  cargo_capacity?: number | null;
  /** Max fuel */
  fuel?: number | null;
  /** Max speed / warp rating (if available) */
  speed?: number | null;
  /** Number of weapon slots */
  weapon_slots?: number | null;
  /** Number of module slots total */
  module_slots?: number | null;
}

interface StatDelta {
  key: string;
  label: string;
  current: number | null;
  target: number | null;
  delta: number | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STAT_DEFS: Array<{ key: keyof ShipStats; label: string }> = [
  { key: "hull", label: "Hull" },
  { key: "cargo_capacity", label: "Cargo" },
  { key: "fuel", label: "Fuel" },
  { key: "speed", label: "Speed" },
  { key: "weapon_slots", label: "Weapon Slots" },
  { key: "module_slots", label: "Module Slots" },
];

function computeDeltas(current: ShipStats, target: ShipStats): StatDelta[] {
  return STAT_DEFS
    .map(({ key, label }) => {
      const cur = current[key] as number | null | undefined ?? null;
      const tgt = target[key] as number | null | undefined ?? null;
      const delta = cur != null && tgt != null ? tgt - cur : null;
      return { key, label, current: cur, target: tgt, delta };
    })
    .filter(({ current, target }) => current != null || target != null);
}

// ---------------------------------------------------------------------------
// Delta row
// ---------------------------------------------------------------------------

function DeltaRow({ stat }: { stat: StatDelta }) {
  const hasData = stat.current != null || stat.target != null;
  if (!hasData) return null;

  const improved = stat.delta != null && stat.delta > 0;
  const downgrade = stat.delta != null && stat.delta < 0;

  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <span className="text-[11px] text-muted-foreground shrink-0">{stat.label}</span>
      <div className="flex items-center gap-1.5 font-mono text-[11px]">
        {/* Current value */}
        <span className="text-foreground/70">
          {stat.current != null ? stat.current.toLocaleString() : "—"}
        </span>

        {/* Arrow + target */}
        {stat.target != null && (
          <>
            <span className="text-muted-foreground/50">→</span>
            <span className="text-foreground">
              {stat.target.toLocaleString()}
            </span>
          </>
        )}

        {/* Delta badge */}
        {stat.delta != null && stat.delta !== 0 && (
          <span
            className={cn(
              "px-1 py-0.5 text-[10px] font-bold",
              improved && "text-success bg-success/10",
              downgrade && "text-destructive bg-destructive/10",
            )}
          >
            {improved ? "+" : ""}{stat.delta.toLocaleString()}
          </span>
        )}
        {stat.delta === 0 && (
          <span className="px-1 py-0.5 text-[10px] text-muted-foreground/50">
            =
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ShipComparison component
// ---------------------------------------------------------------------------

export interface ShipComparisonProps {
  current: ShipStats;
  target: ShipStats;
  /** If true, render as a compact inline summary instead of a full panel */
  compact?: boolean;
  className?: string;
}

export function ShipComparison({ current, target, compact = false, className }: ShipComparisonProps) {
  const deltas = computeDeltas(current, target);

  if (compact) {
    // Single-line summary: "Hull: 300 (+100), Cargo: 200 (=), Fuel: 80 (-20)"
    const parts = deltas
      .filter(d => d.current != null && d.target != null)
      .map(d => {
        const sign = d.delta != null && d.delta > 0 ? "+" : "";
        const deltaStr = d.delta != null ? ` (${sign}${d.delta})` : "";
        return `${d.label}: ${d.target}${deltaStr}`;
      });

    if (parts.length === 0) return null;

    return (
      <span className={cn("text-[11px] text-muted-foreground font-mono", className)}>
        {parts.join(" · ")}
      </span>
    );
  }

  return (
    <div className={cn("bg-card border border-border p-3 space-y-1", className)}>
      {/* Ship names */}
      <div className="flex items-center justify-between mb-2 pb-2 border-b border-border/30">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {current.name ?? current.class_id ?? "Current"}
        </div>
        <div className="text-[10px] uppercase tracking-wider text-primary/80">
          {target.name ?? target.class_id ?? "Target"}
        </div>
      </div>

      {/* Stat rows */}
      {deltas.length === 0 ? (
        <div className="text-[11px] text-muted-foreground italic">
          No comparable stats available.
        </div>
      ) : (
        deltas.map((stat) => <DeltaRow key={stat.key} stat={stat} />)
      )}

      {/* Overall verdict */}
      {deltas.some(d => d.delta != null) && (() => {
        const improvements = deltas.filter(d => d.delta != null && d.delta > 0).length;
        const downgrades = deltas.filter(d => d.delta != null && d.delta < 0).length;
        const verdict =
          improvements > downgrades ? "Overall upgrade"
          : downgrades > improvements ? "Overall downgrade"
          : "Mixed — evaluate by priority";

        return (
          <div className={cn(
            "text-[10px] uppercase tracking-wider pt-2 mt-1 border-t border-border/30",
            improvements > downgrades ? "text-success" : downgrades > improvements ? "text-destructive" : "text-muted-foreground"
          )}>
            {verdict}
          </div>
        );
      })()}
    </div>
  );
}
