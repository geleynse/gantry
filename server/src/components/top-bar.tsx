"use client";

import { Menu, Shield } from "lucide-react";
import { cn, formatCredits } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { useFleetStatus } from "@/hooks/use-fleet-status";
import { useGameState } from "@/hooks/use-game-state";
import { ServerStatusWidget } from "./server-status-widget";

export function TopBar() {
  const { isAdmin } = useAuth();
  const { data: fleetStatus } = useFleetStatus();
  const { data: gameStates } = useGameState();

  const totalCredits =
    gameStates != null
      ? Object.values(gameStates).reduce((sum, gs) => sum + (gs.credits ?? 0), 0)
      : null;

  // Exclude overseer from fleet agent counts — it has its own banner + page
  // and is not part of the operational fleet. Keeps the top-bar count
  // consistent with the Dashboard, Fleet page, Comms, etc.
  const fleetAgents = fleetStatus?.agents.filter((a) => a.name !== "overseer");

  const runningCount =
    fleetAgents != null
      ? fleetAgents.filter((a) => a.state === "running").length
      : null;

  const totalCount = fleetAgents?.length ?? null;

  const proxyHealthy = fleetStatus?.actionProxy?.healthy ?? null;

  // Bug 5: use formatCredits() for consistent abbreviated display (e.g. "1.6M cr")
  const creditsDisplay =
    totalCredits !== null ? formatCredits(totalCredits) : "\u2014 cr";

  // Bug 1: show "running / total" so header matches fleet page total
  const agentsDisplay =
    runningCount !== null && totalCount !== null
      ? `${runningCount} / ${totalCount}`
      : "\u2014 / \u2014";

  function openMobileSidebar() {
    document.dispatchEvent(new CustomEvent("sidebar:open"));
  }

  return (
    <header className="flex items-center h-12 px-3 md:px-4 border-b border-border bg-card shrink-0 gap-3 md:gap-6">
      {/* Mobile hamburger */}
      <button
        onClick={openMobileSidebar}
        className="md:hidden flex items-center justify-center w-8 h-8 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors -ml-1"
        aria-label="Open menu"
      >
        <Menu className="w-5 h-5" />
      </button>

      {/* Brand */}
      <span className="text-primary font-semibold tracking-widest uppercase text-xs flex items-center gap-2">
        Gantry
        {isAdmin && (
          <span className="bg-success/10 text-success border border-success/30 px-1.5 py-0.5 rounded-[2px] text-[9px] font-bold flex items-center gap-1">
            <Shield className="w-2.5 h-2.5" />
            ADMIN
          </span>
        )}
        {fleetStatus?.fleetName && (
          <span className="text-muted-foreground font-normal ml-1.5 hidden sm:inline">{"\u2014"} {fleetStatus.fleetName}</span>
        )}
      </span>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Stats row */}
      <div className="flex items-center gap-3 md:gap-6 text-xs text-muted-foreground">
        {/* Credits — always visible */}
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground uppercase tracking-wider text-[10px] hidden sm:inline">
            Credits
          </span>
          <span
            className={cn(
              "font-mono",
              totalCredits !== null ? "text-foreground" : "text-muted-foreground"
            )}
          >
            {creditsDisplay}
          </span>
        </div>

        {/* Active agents — hide label on small screens */}
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground uppercase tracking-wider text-[10px] hidden sm:inline">
            Agents
          </span>
          <span
            className={cn(
              "font-mono",
              runningCount !== null ? "text-foreground" : "text-muted-foreground"
            )}
          >
            {agentsDisplay}
          </span>
        </div>

        {/* Game server status — hidden on small screens */}
        <div className="hidden sm:block">
          <ServerStatusWidget />
        </div>

        {/* Proxy health indicator */}
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground uppercase tracking-wider text-[10px] hidden sm:inline">
            Proxy
          </span>
          <span
            className={cn(
              "inline-block w-2.5 h-2.5 rounded-full ring-2 ring-offset-1 ring-offset-card",
              proxyHealthy === true && "bg-success ring-success/20",
              proxyHealthy === false && "bg-error ring-error/20",
              proxyHealthy === null && "bg-muted-foreground opacity-50 ring-transparent"
            )}
            title={
              proxyHealthy === true
                ? "Proxy online"
                : proxyHealthy === false
                ? "Proxy offline"
                : "Proxy status unknown"
            }
          />
        </div>
      </div>
    </header>
  );
}
