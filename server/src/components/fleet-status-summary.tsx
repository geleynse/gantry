"use client";

import { getAgentDisplayState, getStateColor, getStateLabel } from "@/lib/agent-display-state";
import type { AgentDisplayState } from "@/lib/agent-display-state";
import type { AgentStatus } from "@/hooks/use-fleet-status";
import { cn } from "@/lib/utils";

interface FleetStatusSummaryProps {
  agents: AgentStatus[];
}

/** Compact fleet summary: groups agents by display state with colored count badges. */
export function FleetStatusSummary({ agents }: FleetStatusSummaryProps) {
  if (agents.length === 0) return null;

  // Group agents by display state
  const groups = new Map<AgentDisplayState, number>();
  for (const agent of agents) {
    const state = getAgentDisplayState(agent);
    groups.set(state, (groups.get(state) ?? 0) + 1);
  }

  // Display order: active first, then actionable states, then inactive
  const displayOrder: AgentDisplayState[] = [
    "active",
    "in-battle",
    "draining",
    "shutdown-waiting",
    "degraded",
    "offline",
    "disconnected",
    "stopped",
  ];

  // Role distribution (#213a): count agents by roleType
  const roleGroups = new Map<string, number>();
  for (const agent of agents) {
    if (agent.roleType) {
      roleGroups.set(agent.roleType, (roleGroups.get(agent.roleType) ?? 0) + 1);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      {/* State badges */}
      <div className="flex items-center gap-2 flex-wrap">
        {displayOrder
          .filter((state) => groups.has(state))
          .map((state) => (
            <div
              key={state}
              className={cn(
                "inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium",
                getStateColor(state),
              )}
            >
              <span className="font-bold">{groups.get(state)}</span>
              <span>{getStateLabel(state)}</span>
            </div>
          ))}
      </div>

      {/* Role distribution — only shown when roleType data is available */}
      {roleGroups.size > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[9px] uppercase tracking-wider text-muted-foreground/60">Roles:</span>
          {Array.from(roleGroups.entries()).map(([roleType, count]) => (
            <span
              key={roleType}
              className="text-[9px] text-muted-foreground border border-border/40 px-1 py-0.5"
            >
              {count}× {roleType}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
