"use client";

import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Target, Clock, CheckCircle, XCircle, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";
import { useAgentNames } from "@/hooks/use-agent-names";
import { formatAbsolute, relativeTime } from "@/lib/time";
import { formatCredits } from "@/lib/format";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MissionObjective {
  type?: string;
  target?: string;
  count?: number;
  current?: number;
  description?: string;
}

interface MissionReward {
  credits?: number;
  xp?: number;
  items?: Array<{ name?: string; quantity?: number }>;
}

interface Mission {
  id?: string;
  title?: string;
  type?: string;
  status?: string;
  deadline?: string;
  objectives?: MissionObjective[];
  reward?: MissionReward;
  description?: string;
}

interface AgentMissions {
  agent: string;
  missions: Mission[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getMissionStatus(mission: Mission): "active" | "expiring" | "completed" | "failed" | "unknown" {
  const status = (mission.status ?? "").toLowerCase();
  if (status === "completed" || status === "complete") return "completed";
  if (status === "failed" || status === "expired") return "failed";

  // Check deadline proximity
  if (mission.deadline) {
    const deadline = new Date(mission.deadline).getTime();
    const now = Date.now();
    const hoursLeft = (deadline - now) / (1000 * 60 * 60);
    if (hoursLeft < 0) return "failed";
    if (hoursLeft < 2) return "expiring";
  }

  if (status === "active" || status === "in_progress" || status === "") return "active";
  return "unknown";
}

function getStatusColor(status: ReturnType<typeof getMissionStatus>): string {
  switch (status) {
    case "active": return "text-success";
    case "expiring": return "text-warning";
    case "completed": return "text-primary";
    case "failed": return "text-error";
    default: return "text-muted-foreground";
  }
}

function getStatusIcon(status: ReturnType<typeof getMissionStatus>) {
  switch (status) {
    case "active": return <Target className="w-3.5 h-3.5 text-success" />;
    case "expiring": return <AlertTriangle className="w-3.5 h-3.5 text-warning" />;
    case "completed": return <CheckCircle className="w-3.5 h-3.5 text-primary" />;
    case "failed": return <XCircle className="w-3.5 h-3.5 text-error" />;
    default: return <Clock className="w-3.5 h-3.5 text-muted-foreground" />;
  }
}

function formatObjectiveProgress(obj: MissionObjective): string {
  const parts: string[] = [];
  if (obj.type) parts.push(obj.type);
  if (obj.target) parts.push(obj.target);
  if (obj.count !== undefined) {
    const cur = obj.current ?? 0;
    parts.push(`${cur}/${obj.count}`);
  }
  return parts.join(" — ") || (obj.description ?? "");
}

function MissionRow({ mission }: { mission: Mission }) {
  const status = getMissionStatus(mission);
  const statusColor = getStatusColor(status);
  const objectives = mission.objectives ?? [];

  return (
    <div className="px-4 py-3 border-b border-border/50 last:border-b-0 hover:bg-secondary/20 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2 flex-1 min-w-0">
          <div className="shrink-0 mt-0.5">{getStatusIcon(status)}</div>
          <div className="flex-1 min-w-0">
            <div className="text-xs text-foreground font-medium truncate">
              {mission.title ?? mission.id ?? "Unknown Mission"}
            </div>
            {mission.type && (
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mt-0.5">
                {mission.type}
              </div>
            )}
            {objectives.length > 0 && (
              <div className="mt-1 space-y-0.5">
                {objectives.map((obj, i) => (
                  <div key={i} className="text-[10px] text-muted-foreground">
                    {formatObjectiveProgress(obj)}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className={cn("text-[10px] uppercase tracking-wider font-semibold", statusColor)}>
            {status}
          </span>
          {mission.reward?.credits !== undefined && mission.reward.credits > 0 && (
            <span className="text-[10px] text-muted-foreground font-mono">
              {formatCredits(mission.reward.credits)}
            </span>
          )}
          {mission.deadline && (
            <span
              className="text-[10px] text-muted-foreground tabular-nums"
              title={relativeTime(mission.deadline)}
            >
              {formatAbsolute(mission.deadline)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function AgentMissionsSection({ data }: { data: AgentMissions }) {
  const activeMissions = data.missions.filter(
    (m) => !["completed", "failed"].includes(getMissionStatus(m))
  );
  const doneMissions = data.missions.filter((m) =>
    ["completed", "failed"].includes(getMissionStatus(m))
  );

  return (
    <div className="bg-card border border-border">
      <div className="px-4 py-2.5 border-b border-border bg-secondary/30 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider font-semibold text-foreground">
          {data.agent}
        </span>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          {activeMissions.length > 0 && (
            <span className="text-success">{activeMissions.length} active</span>
          )}
          {doneMissions.length > 0 && (
            <span>{doneMissions.length} done</span>
          )}
          {data.missions.length === 0 && (
            <span className="italic">no missions</span>
          )}
        </div>
      </div>

      {data.error ? (
        <div className="px-4 py-3 text-xs text-error">
          Error: {data.error}
        </div>
      ) : data.missions.length === 0 ? (
        <div className="px-4 py-4 text-center text-xs text-muted-foreground italic">
          No mission data available
        </div>
      ) : (
        <div>
          {data.missions.map((mission, i) => (
            <MissionRow key={mission.id ?? i} mission={mission} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const AUTO_REFRESH_MS = 30_000;

export default function MissionsPage() {
  // Use the shared agent name hook (filters out overseer — it does not run
  // missions) so this page agrees with the rest of the UI on fleet size.
  const agentList = useAgentNames();
  const [agentMissions, setAgentMissions] = useState<AgentMissions[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [sortBy, setSortBy] = useState<"agent" | "active-first">("active-first");
  const [showEmpty, setShowEmpty] = useState(false);

  const fetchMissions = useCallback(async () => {
    if (agentList.length === 0) return;

    setIsLoading(true);
    try {
      const results = await Promise.all(
        agentList.map(async (agent): Promise<AgentMissions> => {
          try {
            const res = await apiFetch<{ missions: Mission[] }>(
              `/tool-calls/missions?agent=${encodeURIComponent(agent)}`
            );
            return { agent, missions: res.missions };
          } catch (err) {
            return {
              agent,
              missions: [],
              error: err instanceof Error ? err.message : "Failed to load",
            };
          }
        })
      );

      setAgentMissions(results);
      setLastRefresh(new Date());
    } finally {
      setIsLoading(false);
    }
  }, [agentList]);

  // Fetch on agent list load and auto-refresh
  useEffect(() => {
    if (agentList.length === 0) return;
    fetchMissions();
    const id = setInterval(fetchMissions, AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [agentList, fetchMissions]);

  // Hide agents with no missions by default so a mostly-empty fleet does
  // not render six tall empty-state cards (report #20).
  const visibleMissions = showEmpty
    ? agentMissions
    : agentMissions.filter((am) => am.missions.length > 0 || !!am.error);

  const hiddenCount = agentMissions.length - visibleMissions.length;

  // Sort
  const sortedMissions = [...visibleMissions].sort((a, b) => {
    if (sortBy === "agent") {
      return a.agent.localeCompare(b.agent);
    }
    // active-first: count active missions descending
    const countActive = (m: AgentMissions) =>
      m.missions.filter((x) => !["completed", "failed"].includes(getMissionStatus(x))).length;
    return countActive(b) - countActive(a);
  });

  const totalActive = agentMissions.reduce(
    (sum, am) =>
      sum + am.missions.filter((m) => !["completed", "failed"].includes(getMissionStatus(m))).length,
    0
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-primary/20 pb-4">
        <div>
          <h1 className="text-lg font-semibold text-primary uppercase tracking-wider flex items-center gap-2">
            <Target className="w-5 h-5" />
            Missions
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            Active and completed missions across all agents.
            {totalActive > 0 && (
              <span className="ml-2 text-success font-semibold">{totalActive} active</span>
            )}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Sort controls */}
          <div className="flex gap-1">
            {(["active-first", "agent"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSortBy(s)}
                className={cn(
                  "px-2.5 py-1 text-[10px] uppercase tracking-wider transition-colors",
                  sortBy === s
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {s === "active-first" ? "Active First" : "By Agent"}
              </button>
            ))}
          </div>
          <button
            onClick={() => setShowEmpty((v) => !v)}
            className={cn(
              "px-2.5 py-1 text-[10px] uppercase tracking-wider transition-colors border border-border",
              showEmpty
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
            title={showEmpty ? "Hide agents with no missions" : "Show agents with no missions"}
          >
            {showEmpty ? "Hide Empty" : `Show Empty${hiddenCount > 0 ? ` (${hiddenCount})` : ""}`}
          </button>

          {lastRefresh && (
            <span
              className="text-[10px] text-muted-foreground tabular-nums"
              title={formatAbsolute(lastRefresh)}
            >
              Updated {relativeTime(lastRefresh)}
            </span>
          )}

          <button
            onClick={fetchMissions}
            disabled={isLoading || agentList.length === 0}
            className={cn(
              "p-1.5 text-foreground hover:bg-secondary transition-colors",
              (isLoading || agentList.length === 0) && "opacity-50 cursor-not-allowed"
            )}
            title="Refresh"
          >
            <RefreshCw className={cn("w-4 h-4", isLoading && "animate-spin")} />
          </button>
        </div>
      </div>

      {/* Content */}
      {agentList.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground text-sm">
          Loading agents...
        </div>
      ) : sortedMissions.length === 0 && isLoading ? (
        <div className="text-center py-16 text-muted-foreground text-sm">
          Loading missions...
        </div>
      ) : (
        <div className="space-y-4">
          {sortedMissions.map((am) => (
            <AgentMissionsSection key={am.agent} data={am} />
          ))}
        </div>
      )}
    </div>
  );
}
