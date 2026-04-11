"use client";

import { cn } from "@/lib/utils";
import { getAgentDisplayState } from "@/lib/agent-display-state";
import { getProxyStatusText } from "@/lib/proxy-status";
import { StatusBadge } from "./status-badge";
import type { AgentStatus } from "@/hooks/use-fleet-status";

// ---------------------------------------------------------------------------
// Role badge
// ---------------------------------------------------------------------------

type RoleType = "combat" | "trader" | "explorer" | "miner" | "crafter" | "hauler" | "salvager" | "diplomat" | "prospector";

const ROLE_COLORS: Record<RoleType, string> = {
  combat:     "bg-red-900/30 text-red-400 border-red-800/50",
  trader:     "bg-blue-900/30 text-blue-400 border-blue-800/50",
  explorer:   "bg-green-900/30 text-green-400 border-green-800/50",
  miner:      "bg-yellow-900/30 text-yellow-400 border-yellow-800/50",
  crafter:    "bg-purple-900/30 text-purple-400 border-purple-800/50",
  hauler:     "bg-sky-900/30 text-sky-400 border-sky-800/50",
  salvager:   "bg-orange-900/30 text-orange-400 border-orange-800/50",
  diplomat:   "bg-pink-900/30 text-pink-400 border-pink-800/50",
  prospector: "bg-lime-900/30 text-lime-400 border-lime-800/50",
};

export function RoleTypeBadge({ roleType }: { roleType: string }) {
  const colorClass = ROLE_COLORS[roleType as RoleType] ?? "bg-secondary text-muted-foreground border-border";
  return (
    <span className={cn(
      "text-[9px] uppercase tracking-wider px-1.5 py-0.5 border font-medium",
      colorClass
    )}>
      {roleType}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Agent name + status header
// ---------------------------------------------------------------------------

export interface AgentStatusHeaderProps {
  agent: AgentStatus;
}

export function AgentStatusHeader({ agent }: AgentStatusHeaderProps) {
  return (
    <div className="flex-1 min-w-0 flex flex-col">
      <span className="font-bold text-foreground text-base block w-full break-words leading-tight mb-1">
        {agent.name}
      </span>
      <div className="flex items-center gap-2">
        <StatusBadge
          state={getAgentDisplayState(agent)}
          size="sm"
          subLabel={getProxyStatusText(agent)}
        />
      </div>
      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
        {agent.roleType && (
          <RoleTypeBadge roleType={agent.roleType} />
        )}
        {agent.role && (
          <span className="text-[10px] uppercase tracking-wider text-primary bg-primary/10 px-1.5 py-0.5">
            {agent.role}
          </span>
        )}
        <span className="text-[10px] text-muted-foreground font-mono">
          {agent.model || "—"}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Health score indicator
// ---------------------------------------------------------------------------

export interface HealthScoreProps {
  score: number | null;
  state: string;
  agent: AgentStatus;
}

// Determine pill color class based on issue text content
function getIssuePillClass(issue: string): string {
  const lower = issue.toLowerCase();
  if (lower.includes("auth") || lower.includes("credential") || lower.includes("forbidden") || lower.includes("unauthorized")) {
    return "bg-red-900/50 text-red-300 border-red-700/60";
  }
  if (lower.includes("error") || lower.includes("fail") || lower.includes("crash") || lower.includes("dead")) {
    return "bg-red-900/40 text-red-400 border-red-800/50";
  }
  if (lower.includes("slow") || lower.includes("timeout") || lower.includes("lag") || lower.includes("latency")) {
    return "bg-yellow-900/40 text-yellow-300 border-yellow-700/50";
  }
  if (lower.includes("warn") || lower.includes("retry")) {
    return "bg-orange-900/40 text-orange-300 border-orange-700/50";
  }
  return "bg-secondary/60 text-muted-foreground border-border/50";
}

const MAX_VISIBLE_ISSUES = 2;

export function HealthScoreIndicator({ score, state, agent }: HealthScoreProps) {
  // Hide health when agent is not running — stale metrics are misleading
  if (score === null || state === 'stopped' || state === 'dead') return null;

  const issues = agent.healthIssues ?? [];
  const healthTooltip = issues.length > 0 ? issues.join("; ") : "Healthy";
  const visibleIssues = issues.slice(0, MAX_VISIBLE_ISSUES);
  const hiddenCount = issues.length - visibleIssues.length;

  return (
    <div
      className="flex flex-col items-end mt-auto gap-1"
      title={healthTooltip}
    >
      <div className="flex flex-col items-end">
        <span
          className={cn(
            "text-sm font-bold font-mono tabular-nums",
            score > 60 ? "text-success" : score > 30 ? "text-warning" : "text-error"
          )}
        >
          {score}%
        </span>
        <span className="text-[9px] uppercase tracking-wider text-muted-foreground leading-none">
          health
        </span>
      </div>
      {visibleIssues.length > 0 && (
        <div className="flex flex-col items-end gap-0.5">
          {visibleIssues.map((issue, idx) => (
            <span
              key={idx}
              className={cn(
                "text-[9px] font-mono px-1.5 py-0.5 border leading-none whitespace-nowrap max-w-[112px] truncate",
                getIssuePillClass(issue)
              )}
              title={issue}
            >
              {issue}
            </span>
          ))}
          {hiddenCount > 0 && (
            <span className="text-[9px] text-muted-foreground/60 font-mono leading-none">
              +{hiddenCount} more
            </span>
          )}
        </div>
      )}
    </div>
  );
}
