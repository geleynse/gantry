"use client";

import { useRouter } from "next/navigation";
import { cn, formatCredits, getItemName, formatModuleName } from "@/lib/utils";
import { formatAbsolute, relativeTime } from "@/lib/time";
import { HealthBar } from "./health-bar";
import { ShipImage } from "./ShipImage";
import { HealthMetricsCard } from "./health-metrics-card";
import { AgentStatusHeader, HealthScoreIndicator } from "./agent-card-status";
import { AgentActions } from "./agent-card-actions";
import type { AgentStatus } from "@/hooks/use-fleet-status";
import type { AgentGameState } from "@/hooks/use-game-state";
import { useAuth } from "@/hooks/use-auth";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatSessionStart(isoTimestamp: string | null | undefined): string {
  if (!isoTimestamp) return "—";
  const date = new Date(isoTimestamp);
  const ms = date.getTime();
  if (!Number.isFinite(ms)) return "—";
  const now = new Date();
  const diffMs = now.getTime() - ms;
  if (diffMs < 0) return "—";
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const diffHours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

  if (diffDays > 0) {
    return `${diffDays}d ${diffHours}h ago`;
  } else if (diffHours > 0) {
    const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    return `${diffHours}h ${diffMins}m ago`;
  } else {
    const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    return `${diffMins}m ago`;
  }
}

// `relativeTime` now imported from `@/lib/time` — same behaviour, single
// canonical implementation across the dashboard.

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface AgentCardProps {
  agent?: AgentStatus | null;
  gameState?: AgentGameState | null;
  /** Used for skeleton rendering when agent data is not yet loaded */
  name?: string;
  /** Render as a compact single-line row */
  compact?: boolean;
}

export function AgentCard({ agent, gameState, name, compact }: AgentCardProps) {
  const router = useRouter();
  const { isAdmin } = useAuth();
  const displayName = agent?.name ?? name ?? "—";
  const ship = gameState?.ship ?? null;

  function handleClick() {
    if (displayName && displayName !== "—") {
      router.push(`/agent/${displayName}`);
    }
  }

  // Compact single-line view
  if (compact && agent) {
    const stateColor = agent.state === "running"
      ? "bg-success"
      : agent.state === "stopped"
        ? "bg-muted-foreground opacity-50"
        : "bg-warning";
    const location = gameState?.current_system
      ? `${gameState.current_system}${gameState.current_poi ? ` · ${gameState.current_poi}` : ""}`
      : "—";
    return (
      <div
        onClick={handleClick}
        className="bg-card border border-border border-l-2 border-l-primary px-4 py-2 cursor-pointer hover:bg-card-hover transition-colors flex items-center gap-4 text-xs"
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleClick(); } }}
        aria-label={`View agent ${displayName}`}
      >
        <span className="font-bold text-foreground w-32 truncate">{displayName}</span>
        <span className={cn("inline-block w-2 h-2 rounded-full shrink-0", stateColor)} title={agent.state} />
        <span className="font-mono text-foreground shrink-0 w-24 text-right">
          {formatCredits(gameState?.credits ?? null)}
        </span>
        <span className="text-muted-foreground truncate flex-1 text-right">{location}</span>
      </div>
    );
  }

  // Skeleton state: no agent data yet
  if (!agent) {
    return (
      <div className="bg-card border border-border p-4 animate-pulse space-y-3">
        <div className="flex items-center justify-between">
          <div className="h-4 w-32 bg-secondary" />
          <div className="h-2 w-2 rounded-full bg-secondary" />
        </div>
        <div className="h-3 w-24 bg-secondary" />
        <div className="space-y-2 pt-1">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-2">
              <div className="h-2 w-10 bg-secondary" />
              <div className="flex-1 h-1.5 bg-secondary" />
              <div className="h-2 w-16 bg-secondary" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      onClick={handleClick}
      className="bg-card border border-border border-l-2 border-l-primary p-4 cursor-pointer hover:bg-card-hover transition-colors space-y-3 focus-visible:ring-1 focus-visible:ring-primary/40"
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleClick();
        }
      }}
      aria-label={`View agent ${displayName}`}
    >
      {/* Header: Ship Thumbnail + Agent Name/Status + Actions */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex items-start gap-3">
          {ship && (
            <div className="mt-0.5 shrink-0">
              <ShipImage
                shipClass={ship.class}
                size="thumbnail"
                alt={`${agent.name}'s ship`}
                lazy={true}
              />
            </div>
          )}
          <AgentStatusHeader agent={agent} />
        </div>

        {/* Action buttons and health score */}
        <div className="flex flex-col items-end gap-2 shrink-0">
          <AgentActions agent={agent} isAdmin={isAdmin} />
          <HealthScoreIndicator score={agent.healthScore} state={agent.state} agent={agent} />
        </div>
      </div>

      {/* Ship bars */}
      {ship ? (
        <div className="space-y-1.5">
          <div className="text-[10px] text-foreground/80 uppercase tracking-wider mb-1">
            {ship.name}
            {ship.class && (
              <span className="ml-1">({ship.class})</span>
            )}
          </div>
          <HealthBar label="Hull" value={ship.hull} max={ship.max_hull} size="sm" />
          <HealthBar label="Shield" value={ship.shield} max={ship.max_shield} size="sm" />
          <HealthBar label="Fuel" value={ship.fuel} max={ship.max_fuel} size="sm" />
          <HealthBar label="Cargo" value={ship.cargo_used} max={ship.cargo_capacity} size="sm" invert />

          {/* Faction Storage */}
          {gameState?.faction && gameState.faction.storage_capacity && (
            <div className="mt-2 pt-1.5 border-t border-border/30">
              <HealthBar
                label={`Faction (${gameState.faction.tag || 'Storage'})`}
                value={gameState.faction.storage_used || 0}
                max={gameState.faction.storage_capacity}
                size="sm"
                invert
              />
            </div>
          )}

          {/* Modules */}
          {ship.modules && ship.modules.length > 0 && (
            <div className="mt-2 pt-1.5 border-t border-border/30">
              <div className="text-[9px] uppercase tracking-wider text-muted-foreground/70 mb-1">
                Modules
              </div>
              <div className="space-y-0.5">
                {ship.modules.map((mod, idx) => (
                  <div key={idx} className="text-[9px] text-foreground/70 flex items-center gap-1">
                    <span className="text-muted-foreground">
                      {mod.slot_type || "?"}:
                    </span>
                    <span className="truncate">
                      {formatModuleName(mod.item_name, mod.item_id)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Cargo */}
          {ship.cargo && ship.cargo.length > 0 && (
            <div className="mt-2 pt-1.5 border-t border-border/30">
              <div className="text-[9px] uppercase tracking-wider text-muted-foreground/70 mb-1">
                Cargo ({ship.cargo.length})
              </div>
              <div className="space-y-0.5">
                {ship.cargo.slice(0, 5).map((item, idx) => (
                  <div key={idx} className="text-[9px] text-foreground/70 flex items-center justify-between gap-1">
                    <span className="truncate">{getItemName(item.item_id, item.name)}</span>
                    {item.quantity && (
                      <span className="text-muted-foreground shrink-0">×{item.quantity}</span>
                    )}
                  </div>
                ))}
                {ship.cargo.length > 5 && (
                  <div className="text-[9px] text-muted-foreground/60 italic">
                    +{ship.cargo.length - 5} more
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-1.5 opacity-60">
          <HealthBar label="Hull" value={0} max={1} size="sm" />
          <HealthBar label="Shield" value={0} max={1} size="sm" />
          <HealthBar label="Fuel" value={0} max={1} size="sm" />
          <HealthBar label="Cargo" value={0} max={1} size="sm" invert />
        </div>
      )}

      {/* Location + Economy */}
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <div className="min-w-0 text-muted-foreground truncate flex flex-col gap-0.5">
          <div className="truncate">
            {gameState?.current_system ? (
              <>
                <span className="text-foreground/90">{gameState.current_system}</span>
                {gameState.current_poi && (
                  <span> · {gameState.current_poi}</span>
                )}
                {gameState.docked_at_base && (
                  <span className="ml-1 text-success">[docked]</span>
                )}
              </>
            ) : gameState?.data_age_s !== undefined ? (
              <span className="text-muted-foreground/60 italic">
                {agent.operatingZone ? `zone: ${agent.operatingZone}` : "location unknown"} · stale{" "}
                {gameState.data_age_s < 3600
                  ? `${Math.round(gameState.data_age_s / 60)}m ago`
                  : `${Math.round(gameState.data_age_s / 3600)}h ago`}
              </span>
            ) : (
              <span className="text-muted-foreground/60 italic">
                {agent.operatingZone ? `zone: ${agent.operatingZone}` : "location unknown"}
              </span>
            )}
          </div>
          {gameState?.home_system && (
            <div className="text-[9px] opacity-70 flex items-center gap-1">
              <span className="uppercase tracking-tighter text-[8px]">Home:</span>
              <span className="truncate">{gameState.home_system} {gameState.home_poi ? `· ${gameState.home_poi}` : ''}</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {gameState && (
            <div className="flex items-center gap-1">
              <span className="font-mono text-foreground">
                {formatCredits(gameState.credits)}
              </span>
              {agent.state === 'stopped' && gameState.data_age_s !== undefined && (
                <span
                  className="text-[9px] text-muted-foreground/60 font-mono"
                  title={gameState.last_seen ? `Last updated: ${formatAbsolute(gameState.last_seen)}` : 'Stale data'}
                >
                  ({gameState.data_age_s < 3600
                    ? `${Math.round(gameState.data_age_s / 60)}m ago`
                    : `${Math.round(gameState.data_age_s / 3600)}h ago`})
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Last activity */}
      <div className="text-[10px] text-muted-foreground border-t border-border pt-2 space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
            Session
          </span>
          <span className="font-mono text-foreground/80 shrink-0">
            {formatSessionStart(agent.sessionStartedAt)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
            Turns
          </span>
          <span className="font-mono text-foreground/80 shrink-0">
            {agent.turnCount > 0 ? `${agent.turnCount}` : "0"}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
            Last Tool
          </span>
          <span className="font-mono text-foreground/80 shrink-0">
            {agent.lastToolName
              ? <>{agent.lastToolName} <span className="text-muted-foreground/60">{relativeTime(agent.lastToolCallAt)}</span></>
              : agent.lastToolCallAt
                ? relativeTime(agent.lastToolCallAt)
                : <span className="text-muted-foreground/40 not-italic">N/A</span>}
          </span>
        </div>
      </div>

      {/* Health metrics (#145) */}
      <HealthMetricsCard
        agent={agent.name}
        latency={agent.latencyMetrics}
        errorRate={agent.errorRate}
        connectionStatus={agent.connectionStatus}
      />

      {/* Skills (#150) */}
      {gameState && Object.keys(gameState.skills ?? {}).length > 0 && (
        <div className="border-t border-border pt-2 mt-2">
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground/70 mb-1">
            Skills
          </div>
          <div className="space-y-0.5 text-[9px]">
            {Object.entries(gameState.skills).map(([skillName, skillData]) => (
              <div key={skillName} className="flex items-center justify-between gap-1">
                <span className="text-foreground/70 capitalize">
                  {skillName}
                </span>
                <div className="flex items-center gap-1 text-muted-foreground shrink-0">
                  <span>Lvl {skillData.level || 0}</span>
                  {skillData.xp_to_next && (
                    <span>({skillData.xp || 0}/{skillData.xp_to_next})</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
