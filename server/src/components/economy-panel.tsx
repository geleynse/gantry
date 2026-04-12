"use client";

import { useEffect, useState } from "react";
import { cn, summarizeArgs } from "@/lib/utils";
import { CreditChart } from "./credit-chart";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ToolCallRecord {
  id: number;
  agent: string;
  tool_name: string;
  args_summary: string | null;
  result_summary: string | null;
  success: number;
  error_code: string | null;
  duration_ms: number | null;
  is_compound: number;
  timestamp: string;
  created_at: string;
}

interface ActionLogRecord {
  id: number;
  agent: string;
  action_type: string;
  item: string | null;
  quantity: number | null;
  credits_delta: number | null;
  station: string | null;
  system: string | null;
  game_timestamp: string | null;
  created_at: string;
}

interface TransactionRow {
  id: number;
  time: string;
  action: string;
  summary: string;
  creditsDelta: number | null;
  success: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MissionObjective {
  type?: string;
  target?: string;
  count?: number;
  description?: string;
}

interface MissionReward {
  credits?: number;
  xp?: number;
  items?: Array<{ item_id: string; quantity: number }>;
}

interface Mission {
  id?: string;
  title?: string;
  objectives?: MissionObjective[];
  reward?: MissionReward;
  status?: string;
}

// ---------------------------------------------------------------------------
// Mission type color map
// ---------------------------------------------------------------------------

const MISSION_TYPE_COLORS: Record<string, string> = {
  combat: "bg-red-900/30 text-red-400 border-red-800/40",
  equipment: "bg-blue-900/30 text-blue-400 border-blue-800/40",
  crafting: "bg-orange-900/30 text-orange-400 border-orange-800/40",
  delivery: "bg-green-900/30 text-green-400 border-green-800/40",
  supply: "bg-green-900/30 text-green-400 border-green-800/40",
};

function missionTypeColor(type?: string): string {
  if (!type) return "bg-zinc-800/50 text-zinc-400 border-zinc-700/40";
  return MISSION_TYPE_COLORS[type.toLowerCase()] ?? "bg-zinc-800/50 text-zinc-400 border-zinc-700/40";
}

// Tools that represent economic transactions (sell / buy / commission)
const ECONOMIC_TOOLS = new Set([
  "sell",
  "buy",
  "multi_sell",
  "commission_ship",
  "supply_commission",
  "craft",
  "buy_listed_ship",
]);

function isEconomicTool(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  return (
    ECONOMIC_TOOLS.has(lower) ||
    lower.startsWith("sell") ||
    lower.startsWith("buy") ||
    lower.includes("multi_sell")
  );
}

function relativeTime(isoTimestamp: string | null | undefined): string {
  if (!isoTimestamp) return "—";
  const diff = Math.floor((Date.now() - new Date(isoTimestamp).getTime()) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function toolLabel(toolName: string): string {
  const map: Record<string, string> = {
    sell: "Sell",
    buy: "Buy",
    multi_sell: "Multi-Sell",
    commission_ship: "Commission",
    supply_commission: "Supply",
    craft: "Craft",
    buy_listed_ship: "Buy Ship",
  };
  return map[toolName] ?? toolName.replace(/_/g, " ");
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Panel({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("bg-card border border-border p-4 space-y-3", className)}>
      <h3 className="text-[10px] uppercase tracking-wider text-foreground/70 border-b border-border pb-2">
        {title}
      </h3>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recent Transactions panel
// ---------------------------------------------------------------------------

/** Format a credits delta as a signed string with commas. */
function formatCredits(delta: number | null): string {
  if (delta === null) return "";
  const abs = Math.abs(delta).toLocaleString();
  return delta >= 0 ? `+${abs}` : `-${abs}`;
}

/** Build a human-readable summary line from a structured action log entry. */
function actionSummary(row: ActionLogRecord): string {
  const parts: string[] = [];
  if (row.item) {
    parts.push(row.quantity != null ? `${row.quantity}x ${row.item}` : row.item);
  }
  if (row.station) parts.push(`@ ${row.station}`);
  else if (row.system) parts.push(`in ${row.system}`);
  return parts.join(" ") || "—";
}

function RecentTransactions({ agentName }: { agentName: string }) {
  const [rows, setRows] = useState<TransactionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!agentName) return;

    setLoading(true);
    setError(null);

    // Primary: structured action log from agent_action_log table
    const actionLogUrl = `/api/economy/actions?agent=${encodeURIComponent(agentName)}&limit=100`;
    // Fallback: live proxy feed filtered to economic tools
    const liveUrl = `/api/tool-calls?agent=${encodeURIComponent(agentName)}&limit=200`;

    Promise.all([
      fetch(actionLogUrl).then(r =>
        r.ok ? r.json().then((d: { actions: ActionLogRecord[] }) => d.actions ?? []) : []
      ),
      fetch(liveUrl).then(r =>
        r.ok ? r.json().then((d: { tool_calls: ToolCallRecord[] }) => d.tool_calls ?? []) : []
      ),
    ])
      .then(([structured, live]: [ActionLogRecord[], ToolCallRecord[]]) => {
        const combined: TransactionRow[] = [];

        // Structured entries from action log (preferred — have credits_delta)
        for (const a of structured) {
          combined.push({
            id: a.id,
            time: relativeTime(a.game_timestamp ?? a.created_at),
            action: toolLabel(a.action_type),
            summary: actionSummary(a),
            creditsDelta: a.credits_delta,
            success: true,
          });
        }

        // Supplement with live proxy tool calls for tools not yet in action log
        // (e.g. recent buy/sell before agent called get_action_log)
        const hasStructuredData = combined.length > 0;
        if (!hasStructuredData) {
          for (const tc of live) {
            if (!isEconomicTool(tc.tool_name)) continue;

            // Attempt to extract creditsDelta from result_summary
            // Buy/sell/multi_sell results contain credits_after; compute delta if available
            let creditsDelta: number | null = null;
            if (tc.result_summary) {
              try {
                const result = JSON.parse(tc.result_summary);
                if (typeof result.credits_after === 'number' && typeof result.credits_before === 'number') {
                  creditsDelta = result.credits_after - result.credits_before;
                } else if (typeof result.credits_delta === 'number') {
                  creditsDelta = result.credits_delta;
                }
              } catch {
                // result_summary may not be valid JSON; skip parsing
              }
            }

            combined.push({
              id: tc.id + 1_000_000, // offset to avoid id collisions
              time: relativeTime(tc.created_at),
              action: toolLabel(tc.tool_name),
              summary: tc.args_summary || (summarizeArgs(tc.result_summary) ?? "—"),
              creditsDelta,
              success: tc.success === 1,
            });
          }
        }

        setRows(combined.slice(0, 50));
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load");
      })
      .finally(() => setLoading(false));
  }, [agentName]);

  if (loading) {
    return (
      <div className="text-xs text-muted-foreground italic py-4 text-center">
        Loading…
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-xs text-error opacity-70 py-4 text-center">
        Error: {error}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground italic">
        No recent transactions recorded
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px] border-collapse">
        <thead>
          <tr className="text-left text-muted-foreground border-b border-border bg-nord-1/30">
            <th className="pb-1.5 pr-3 font-normal uppercase tracking-wider text-[10px]">
              Time
            </th>
            <th className="pb-1.5 pr-3 font-normal uppercase tracking-wider text-[10px]">
              Action
            </th>
            <th className="pb-1.5 pr-3 font-normal uppercase tracking-wider text-[10px]">
              Details
            </th>
            <th className="pb-1.5 font-normal uppercase tracking-wider text-[10px] text-right">
              Credits
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/40">
          {rows.map((row) => (
            <tr key={row.id} className="hover:bg-secondary/30 transition-colors">
              <td className="py-1.5 pr-3 text-muted-foreground font-mono whitespace-nowrap">
                {row.time}
              </td>
              <td className="py-1.5 pr-3 whitespace-nowrap">
                <span
                  className={cn(
                    "font-mono",
                    row.success ? "text-success" : "text-error"
                  )}
                >
                  {row.action}
                </span>
              </td>
              <td className="py-1.5 pr-3 text-muted-foreground truncate max-w-[160px]">
                {row.summary}
              </td>
              <td className="py-1.5 font-mono text-right whitespace-nowrap">
                {row.creditsDelta !== null && (
                  <span
                    className={cn(
                      row.creditsDelta >= 0 ? "text-success" : "text-error"
                    )}
                  >
                    {formatCredits(row.creditsDelta)}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
// Active Missions panel
// ---------------------------------------------------------------------------

function MissionCard({ mission }: { mission: Mission }) {
  const type = (mission.objectives?.[0]?.type ?? "").toLowerCase();
  const colorCls = missionTypeColor(type);
  const credits = mission.reward?.credits;

  return (
    <div className="bg-background/50 border border-border p-2 space-y-1 text-[11px]">
      <div className="flex items-start justify-between gap-2">
        <span className="text-foreground font-medium leading-tight">
          {mission.title ?? "Unknown Mission"}
        </span>
        {type && (
          <span className={cn("px-1.5 py-0.5 border rounded text-[9px] uppercase tracking-wider shrink-0", colorCls)}>
            {type}
          </span>
        )}
      </div>
      {credits != null && (
        <div className="text-muted-foreground">
          Reward: <span className="text-foreground/80">{credits.toLocaleString()} cr</span>
        </div>
      )}
      {mission.status && (
        <div className="text-muted-foreground capitalize">
          {mission.status.replace(/_/g, " ")}
        </div>
      )}
    </div>
  );
}

function ActiveMissions({ agentName }: { agentName: string }) {
  const [missions, setMissions] = useState<Mission[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!agentName) return;

    let cancelled = false;

    function fetchMissions() {
      fetch(`/api/tool-calls/missions?agent=${encodeURIComponent(agentName)}`)
        .then(r => r.ok ? r.json() : { missions: [] })
        .then((d: { missions: Mission[] }) => {
          if (!cancelled) {
            setMissions(d.missions ?? []);
            setLoading(false);
          }
        })
        .catch(() => {
          if (!cancelled) setLoading(false);
        });
    }

    fetchMissions();
    const interval = setInterval(fetchMissions, 60_000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [agentName]);

  if (loading) {
    return <p className="text-[11px] text-muted-foreground italic">Loading...</p>;
  }

  if (missions.length === 0) {
    return <p className="text-[11px] text-muted-foreground italic">No active missions</p>;
  }

  return (
    <div className="space-y-2">
      {missions.map((m, i) => (
        <MissionCard key={m.id ?? i} mission={m} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface EconomyPanelProps {
  agentName: string;
}

export function EconomyPanel({ agentName }: EconomyPanelProps) {
  return (
    <div className="space-y-4">
      {/* Credit history chart */}
      <Panel title="Credits Over Time">
        <CreditChart agentName={agentName} />
      </Panel>

      {/* Two-column grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Recent Transactions */}
        <Panel title="Recent Transactions">
          <RecentTransactions agentName={agentName} />
        </Panel>

        {/* Active Missions */}
        <Panel title="Active Missions">
          <ActiveMissions agentName={agentName} />
        </Panel>
      </div>
    </div>
  );
}
