"use client";

import { formatAbsolute, relativeTime } from "@/lib/time";

// ---------------------------------------------------------------------------
// EncounterCard — collapsed/expanded view of a combat encounter
// ---------------------------------------------------------------------------

export interface Encounter {
  id: number;
  agent: string;
  pirate_name: string | null;
  pirate_tier: string | null;
  system: string | null;
  started_at: string;
  ended_at: string | null;
  outcome: "survived" | "fled" | "died";
  total_damage: number;
  hull_start: number;
  hull_end: number;
  max_hull: number;
}

export interface CombatEvent {
  id: number;
  agent: string;
  event_type: "pirate_combat" | "pirate_warning" | "player_died";
  pirate_name: string | null;
  pirate_tier: string | null;
  damage: number | null;
  hull_after: number | null;
  max_hull: number | null;
  died: number;
  insurance_payout: number | null;
  system: string | null;
  created_at: string;
}

interface EncounterCardProps {
  encounter: Encounter;
  expanded: boolean;
  onToggle: () => void;
  events?: CombatEvent[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function tierBadge(tier: string | null) {
  if (!tier) return null;
  const colors: Record<string, string> = {
    small: "text-green-400",
    medium: "text-yellow-400",
    large: "text-orange-400",
    boss: "text-red-400",
  };
  return (
    <span className={`text-xs font-mono ${colors[tier] ?? "text-muted-foreground"}`}>
      [{tier}]
    </span>
  );
}

function outcomeBadge(outcome: Encounter["outcome"]) {
  if (outcome === "survived") {
    return (
      <span className="text-xs font-mono px-1.5 py-0.5 rounded-full bg-green-900/40 text-green-400 border border-green-700/40">
        survived
      </span>
    );
  }
  if (outcome === "fled") {
    return (
      <span className="text-xs font-mono px-1.5 py-0.5 rounded-full bg-yellow-900/40 text-yellow-400 border border-yellow-700/40">
        fled
      </span>
    );
  }
  return (
    <span className="text-xs font-mono px-1.5 py-0.5 rounded-full bg-red-900/40 text-red-400 border border-red-700/40">
      died
    </span>
  );
}

function eventTypeLabel(eventType: CombatEvent["event_type"]) {
  if (eventType === "pirate_warning") {
    return <span className="text-yellow-400 text-xs font-mono">warning</span>;
  }
  if (eventType === "pirate_combat") {
    return <span className="text-orange-400 text-xs font-mono">combat</span>;
  }
  return <span className="text-red-400 text-xs font-mono">died</span>;
}

// Combat events can fire several per second within a single encounter, so
// we keep seconds precision (formatAbsolute is HH:MM:SS-aware).
function formatTime(iso: string) {
  return formatAbsolute(iso);
}

function hullBarColor(pct: number): string {
  if (pct > 50) return "bg-green-500";
  if (pct > 20) return "bg-yellow-500";
  return "bg-red-500";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EncounterCard({ encounter, expanded, onToggle, events }: EncounterCardProps) {
  const hullPct = encounter.hull_start > 0
    ? Math.min(100, Math.max(0, (encounter.hull_end / encounter.hull_start) * 100))
    : 0;

  return (
    <div
      className="bg-card border border-border rounded-lg cursor-pointer hover:bg-secondary/10 transition-colors"
      onClick={onToggle}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onToggle()}
      aria-expanded={expanded}
    >
      {/* Collapsed row */}
      <div className="p-3 flex flex-wrap items-center gap-2">
        {/* Agent */}
        <span className="text-xs font-mono text-foreground w-28 shrink-0 truncate">
          {encounter.agent}
        </span>

        {/* Pirate + tier */}
        <span className="flex items-center gap-1 min-w-0 shrink-0">
          <span className="text-xs font-mono text-muted-foreground truncate">
            {encounter.pirate_name ?? "—"}
          </span>
          {tierBadge(encounter.pirate_tier)}
        </span>

        {/* System */}
        <span className="text-xs font-mono text-muted-foreground flex-1 min-w-0 truncate">
          {encounter.system ?? "—"}
        </span>

        {/* Timestamp */}
        <span
          className="text-xs font-mono text-muted-foreground shrink-0 whitespace-nowrap"
          title={relativeTime(encounter.started_at)}
        >
          {formatAbsolute(encounter.started_at)}
        </span>

        {/* Damage */}
        <span className="text-xs font-mono text-foreground shrink-0 w-16 text-right">
          {encounter.total_damage} dmg
        </span>

        {/* Outcome badge */}
        <span className="shrink-0">{outcomeBadge(encounter.outcome)}</span>

        {/* Hull bar */}
        <div className="flex items-center gap-1.5 shrink-0 w-40">
          <div className="flex-1 h-1.5 bg-background overflow-hidden rounded-full">
            <div
              data-testid="hull-bar"
              className={`h-full transition-all ${hullBarColor(hullPct)}`}
              style={{ width: `${hullPct}%` }}
            />
          </div>
          <span className="text-xs font-mono text-muted-foreground whitespace-nowrap">
            {encounter.hull_end}/{encounter.hull_start}
          </span>
        </div>

        {/* Expand indicator */}
        <span className="text-xs text-muted-foreground shrink-0 select-none">
          {expanded ? "▲" : "▼"}
        </span>
      </div>

      {/* Expanded event timeline */}
      {expanded && (
        <div
          className="border-t border-border/50 px-3 pb-3 space-y-1"
          onClick={(e) => e.stopPropagation()}
        >
          {!events ? (
            <div className="text-xs text-muted-foreground py-2">Loading...</div>
          ) : events.length === 0 ? (
            <div className="text-xs text-muted-foreground py-2">No events</div>
          ) : (
            <div className="pt-2 space-y-1">
              {events.map((evt) => (
                <div
                  key={evt.id}
                  className="flex items-center gap-3 text-xs font-mono"
                >
                  <span className="text-muted-foreground shrink-0 w-20">
                    {formatTime(evt.created_at)}
                  </span>
                  <span className="shrink-0 w-14">
                    {eventTypeLabel(evt.event_type)}
                  </span>
                  <span className="text-foreground shrink-0 w-16 text-right">
                    {evt.damage != null ? `${evt.damage} dmg` : "—"}
                  </span>
                  <span className="text-muted-foreground shrink-0">
                    {evt.hull_after != null && evt.max_hull != null
                      ? `${evt.hull_after}/${evt.max_hull}`
                      : "—"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
