"use client";

import { useState } from "react";
import { Factory, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Extracted from ./page.tsx: Next.js App Router only permits a page module to
// export a default component (plus its reserved config fields), so exporting
// FacilityRow/FacilityRecord for the unit tests broke `next build`. Keep
// presentational pieces that tests need to import in their own module.
// ---------------------------------------------------------------------------

export interface FacilityRecord {
  id?: string;
  name?: string;
  type?: string;
  level?: number;
  system?: string;
  poi?: string;
  owner?: string;
  /** Only populated for faction-tab entries (live-spec FacilityFactionEntry:
   *  "under_construction" | "damaged" | "active"). Station/owned/build-tab
   *  entries come from FacilityEntry, which has no `status` property at all —
   *  on those tabs this stays undefined and the status badge below simply
   *  doesn't render; `damaged` is the only signal available there. */
  status?: string;
  /** v0.551.1: true for faction facilities knocked out in battle — damaged
   *  facilities produce nothing even though they still show up in listings.
   *  Present on both FacilityEntry and FacilityFactionEntry. */
  damaged?: boolean;
  /** v0.550.0 upkeep rework: stock-on-hand level, not a consumption rate. */
  maintenanceLevel?: unknown;
  /** v0.550.0: rent tracks real, live station costs. */
  rentPerCycle?: unknown;
  production?: unknown;
  upgrades?: unknown;
  raw?: unknown;
}

// ---------------------------------------------------------------------------
// Facility row
// ---------------------------------------------------------------------------

export function FacilityRow({ facility }: { facility: FacilityRecord }) {
  const [expanded, setExpanded] = useState(false);
  const name = facility.name ?? facility.id ?? "Unknown Facility";
  // v0.551.1: a facility can be reported damaged either via status === "damaged"
  // or the separate boolean flag — treat either as knocked out, not working.
  const isDamaged = facility.damaged === true || facility.status === "damaged";
  const hasExtra = facility.production != null || facility.upgrades != null || facility.rentPerCycle != null;

  return (
    <div className="border border-border/50 bg-secondary/20 hover:bg-secondary/40 transition-colors">
      <div className="flex items-center gap-3 px-3 py-2">
        <Factory className="w-3.5 h-3.5 text-primary/60 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-foreground truncate">{name}</span>
            {facility.type && (
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground bg-secondary px-1.5 py-0.5 shrink-0">
                {facility.type}
              </span>
            )}
            {facility.level != null && (
              <span className="text-[10px] text-primary/70 font-mono shrink-0">
                Lv {facility.level}
              </span>
            )}
            {/* `status` (FacilityFactionEntry only — see the field comment above)
                gets three distinct treatments, not two: "active" (success),
                "damaged" (destructive), and "under_construction" (warning) are
                all expected-but-different states. under_construction is
                normal, not-yet-producing — it must NOT share the same neutral
                styling as a plain unknown/idle status, or an operator can't
                tell "still building" from "something's wrong but unlabeled". */}
            {facility.status && (
              <span
                className={cn(
                  "text-[10px] uppercase tracking-wider px-1.5 py-0.5 shrink-0",
                  facility.status === "active"
                    ? "text-success bg-success/10"
                    : facility.status === "under_construction"
                    ? "text-warning bg-warning/10"
                    : isDamaged
                    ? "text-destructive bg-destructive/10"
                    : "text-muted-foreground bg-secondary"
                )}
              >
                {facility.status}
              </span>
            )}
            {/* v0.551.1: surface the damaged flag even if status wasn't reported as
                "damaged" (e.g. an older/aliased status string), so a knocked-out
                facility is never mistaken for a working one. */}
            {isDamaged && facility.status !== "damaged" && (
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 shrink-0 text-destructive bg-destructive/10">
                Damaged
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-0.5 text-[11px] text-muted-foreground">
            {facility.system && <span>{facility.system}</span>}
            {facility.poi && <span className="truncate">{facility.poi}</span>}
            {facility.owner && <span>Owner: {facility.owner}</span>}
          </div>
        </div>
        {hasExtra && (
          <button
            onClick={() => setExpanded((e) => !e)}
            className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            <ChevronDown
              className={cn("w-3.5 h-3.5 transition-transform", expanded && "rotate-180")}
            />
          </button>
        )}
      </div>
      {expanded && hasExtra && (
        <div className="px-3 pb-2 text-[11px] text-muted-foreground font-mono border-t border-border/30 pt-2 space-y-1">
          {facility.production != null && (
            <div>
              <span className="text-foreground/50">Production: </span>
              {JSON.stringify(facility.production)}
            </div>
          )}
          {facility.upgrades != null && (
            <div>
              <span className="text-foreground/50">Upgrades: </span>
              {JSON.stringify(facility.upgrades)}
            </div>
          )}
          {facility.rentPerCycle != null && (
            <div>
              <span className="text-foreground/50">Rent per cycle: </span>
              {JSON.stringify(facility.rentPerCycle)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
