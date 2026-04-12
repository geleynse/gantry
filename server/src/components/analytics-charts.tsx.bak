"use client";

import { useEffect, useState } from "react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from "recharts";
import { apiFetch } from "@/lib/api";
import { AGENT_COLORS, getAgentColor } from "@/lib/utils";
import { formatTimeShort, formatFullTimestamp } from "@/lib/time";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CostDataPoint {
  agent: string;
  timestamp: string;
  cost: number;
  iterations: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

interface ChartCostPoint {
  time: string;
  fullTimestamp: string;
  [key: string]: number | string; // agent costs
}

interface ToolFrequencyEntry {
  toolName: string;
  count: number;
  avgSuccess: number;
}

interface ChartToolPoint {
  name: string;
  count: number;
  successRate: number;
}

interface AgentComparisonEntry {
  agent: string;
  turnCount: number;
  totalCost: number;
  avgCostPerTurn: number;
  totalIterations: number;
  avgDurationMs: number;
  latestCredits: number | null;
  creditsChange: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatCost(n: number): string {
  if (n >= 10) return `$${n.toFixed(2)}`;
  if (n >= 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatCredits(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

// ---------------------------------------------------------------------------
// Custom Tooltips
// ---------------------------------------------------------------------------

interface CostTooltipProps {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string; payload?: ChartCostPoint }>;
  label?: string;
}

function CostTooltip({ active, payload }: CostTooltipProps) {
  if (!active || !payload?.length) return null;
  const fullTimestamp = (payload[0]?.payload as ChartCostPoint | undefined)?.fullTimestamp || "";
  return (
    <div
      style={{ background: "#3b4252", border: "1px solid #4c566a" }}
      className="px-3 py-2 text-xs font-mono space-y-1"
    >
      <div className="text-foreground text-[10px]">
        {fullTimestamp}
      </div>
      {payload.map((entry, i) => (
        <div key={i} style={{ color: entry.color }}>
          {entry.name}: ${entry.value.toFixed(4)}
        </div>
      ))}
    </div>
  );
}

interface ToolTooltipProps {
  active?: boolean;
  payload?: Array<{ value: number; payload: ChartToolPoint }>;
  label?: string;
}

function ToolTooltip({ active, payload }: ToolTooltipProps) {
  if (!active || !payload?.length) return null;
  const pt = payload[0];
  return (
    <div
      style={{ background: "#3b4252", border: "1px solid #4c566a" }}
      className="px-3 py-2 text-xs font-mono space-y-1"
    >
      <div className="text-foreground text-[10px]">{pt.payload.name}</div>
      <div style={{ color: "#88c0d0" }}>Calls: {pt.value}</div>
      <div className="text-muted-foreground opacity-70">
        Success: {(pt.payload.successRate * 100).toFixed(1)}%
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CostChart Component
// ---------------------------------------------------------------------------

interface CostChartProps {
  hours?: number;
}

export function CostChart({ hours }: CostChartProps) {
  const [data, setData] = useState<ChartCostPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);

    const params = new URLSearchParams();
    if (hours != null && hours > 0) params.append("hours", String(hours));

    apiFetch<CostDataPoint[]>(`/analytics-db/cost?${params}`)
      .then((raw) => {
        if (!Array.isArray(raw) || raw.length === 0) {
          setData([]);
          return;
        }

        // Group by timestamp, aggregate agent costs
        const grouped: Record<string, { agents: Record<string, number>; fullTs: string }> = {};
        raw.forEach((pt) => {
          if (!grouped[pt.timestamp]) {
            grouped[pt.timestamp] = {
              agents: {},
              fullTs: formatFullTimestamp(pt.timestamp),
            };
          }
          grouped[pt.timestamp].agents[pt.agent] = pt.cost;
        });

        // Downsample if too many points
        const MAX_POINTS = 200;
        const entries = Object.entries(grouped);
        let step = 1;
        if (entries.length > MAX_POINTS) {
          step = Math.ceil(entries.length / MAX_POINTS);
        }

        setData(
          entries
            .filter((_, i) => i % step === 0 || i === entries.length - 1)
            .map(([ts, { agents, fullTs }]) => ({
              time: formatTimeShort(ts),
              fullTimestamp: fullTs,
              ...agents,
            }))
        );
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load cost data");
      })
      .finally(() => setLoading(false));
  }, [hours]);

  if (loading) {
    return (
      <div className="h-[300px] flex items-center justify-center text-xs text-muted-foreground">
        Loading cost data…
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-[300px] flex items-center justify-center text-xs text-error opacity-70">
        Error: {error}
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="h-[300px] flex flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
        <span className="italic">No cost data in this time range</span>
        {(hours ?? 0) < 24 * 7 && (
          <span className="text-[10px]">Try expanding the time range to see historical data</span>
        )}
      </div>
    );
  }

  return (
    <div className="h-[300px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={data}
          margin={{ top: 8, right: 16, bottom: 8, left: 8 }}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="#3b4252"
            strokeOpacity={0.4}
          />
          <XAxis
            dataKey="time"
            tick={{ fill: "#8892a8", fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: "#3b4252" }}
            interval="preserveStartEnd"
          />
          <YAxis
            tickFormatter={formatCost}
            tick={{ fill: "#8892a8", fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: "#3b4252" }}
            width={48}
          />
          <Tooltip content={<CostTooltip />} />
          <Legend
            wrapperStyle={{ fontSize: 10 }}
            iconType="line"
            height={20}
          />
          {/* Derive agent list from data keys (AGENT_COLORS is empty at runtime) */}
          {Array.from(new Set(data.flatMap((pt) => Object.keys(pt).filter((k) => k !== "time" && k !== "fullTimestamp")))).map((agent) => {
            const color = getAgentColor(agent);
            return (
              <Line
                key={agent}
                type="monotone"
                dataKey={agent}
                stroke={color}
                strokeWidth={1.5}
                dot={false}
                activeDot={{ r: 3, fill: color }}
                connectNulls={true}
              />
            );
          })}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ToolUsageChart Component
// ---------------------------------------------------------------------------

interface ToolUsageChartProps {
  hours?: number;
}

export function ToolUsageChart({ hours }: ToolUsageChartProps) {
  const [data, setData] = useState<ChartToolPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);

    const params = new URLSearchParams();
    if (hours != null && hours > 0) params.append("hours", String(hours));

    apiFetch<ToolFrequencyEntry[]>(`/analytics-db/tools?${params}`)
      .then((raw) => {
        if (!Array.isArray(raw) || raw.length === 0) {
          setData([]);
          return;
        }

        // Take top 20 tools, sorted by count
        const top20 = raw.slice(0, 20);
        setData(
          top20.map((entry) => ({
            name: entry.toolName,
            count: entry.count,
            successRate: entry.avgSuccess,
          }))
        );
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load tool data");
      })
      .finally(() => setLoading(false));
  }, [hours]);

  if (loading) {
    return (
      <div className="h-[300px] flex items-center justify-center text-xs text-muted-foreground">
        Loading tool data…
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-[300px] flex items-center justify-center text-xs text-error opacity-70">
        Error: {error}
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="h-[300px] flex items-center justify-center text-xs text-muted-foreground italic">
        No tool data available
      </div>
    );
  }

  return (
    <div className="h-[300px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          layout="vertical"
          data={data}
          margin={{ top: 8, right: 16, bottom: 8, left: 140 }}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="#3b4252"
            strokeOpacity={0.4}
          />
          <XAxis
            type="number"
            tick={{ fill: "#8892a8", fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: "#3b4252" }}
          />
          <YAxis
            dataKey="name"
            type="category"
            tick={{ fill: "#8892a8", fontSize: 9 }}
            tickLine={false}
            axisLine={{ stroke: "#3b4252" }}
            width={135}
          />
          <Tooltip content={<ToolTooltip />} />
          <Bar dataKey="count" fill="#88c0d0" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AgentComparisonTable Component
// ---------------------------------------------------------------------------

interface AgentComparisonTableProps {
  hours?: number;
}

export function AgentComparisonTable({ hours }: AgentComparisonTableProps) {
  const [data, setData] = useState<AgentComparisonEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);

    const params = new URLSearchParams();
    if (hours != null && hours > 0) params.append("hours", String(hours));

    apiFetch<AgentComparisonEntry[]>(`/analytics-db/comparison?${params}`)
      .then((raw) => {
        if (Array.isArray(raw)) {
          setData(raw);
        }
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load comparison data");
      })
      .finally(() => setLoading(false));
  }, [hours]);

  if (loading) {
    return (
      <div className="h-[300px] flex items-center justify-center text-xs text-muted-foreground">
        Loading agent data…
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-[300px] flex items-center justify-center text-xs text-error opacity-70">
        Error: {error}
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="h-[300px] flex items-center justify-center text-xs text-muted-foreground italic">
        No agent data available
      </div>
    );
  }

  return (
    <div className="overflow-x-auto h-[300px] flex flex-col">
      <table className="w-full min-w-[640px] text-[11px] border-collapse">
        <thead>
          <tr className="border-b border-border sticky top-0 bg-nord-1/50">
            <th className="text-left px-2 py-2 font-semibold text-foreground">Agent</th>
            <th className="text-right px-2 py-2 font-semibold text-foreground">Turns</th>
            <th className="text-right px-2 py-2 font-semibold text-foreground">Cost</th>
            <th className="text-right px-2 py-2 font-semibold text-foreground">Avg Cost</th>
            <th className="text-right px-2 py-2 font-semibold text-foreground">Iterations</th>
            <th className="text-right px-2 py-2 font-semibold text-foreground">Avg Time</th>
            <th className="text-right px-2 py-2 font-semibold text-foreground whitespace-nowrap">Credits</th>
            <th className="text-right px-2 py-2 font-semibold text-foreground whitespace-nowrap">Δ Credits</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr key={row.agent} className="border-b border-border/50 hover:bg-primary/5">
              <td className="px-2 py-2">
                <span
                  style={{
                    backgroundColor: `${AGENT_COLORS[row.agent] ?? "#888"}33`,
                    color: AGENT_COLORS[row.agent] ?? "#888",
                  }}
                  className="px-2 py-1 text-xs font-medium"
                >
                  {row.agent}
                </span>
              </td>
              <td className="text-right px-2 py-2 font-mono text-foreground/80">
                {row.turnCount}
              </td>
              <td className="text-right px-2 py-2 font-mono text-foreground/80">
                {formatCost(row.totalCost)}
              </td>
              <td className="text-right px-2 py-2 font-mono text-foreground/80">
                {formatCost(row.avgCostPerTurn)}
              </td>
              <td className="text-right px-2 py-2 font-mono text-foreground/80">
                {row.totalIterations}
              </td>
              <td className="text-right px-2 py-2 font-mono text-foreground/80">
                {formatDuration(row.avgDurationMs)}
              </td>
              <td className="text-right px-2 py-2 font-mono text-foreground/80 whitespace-nowrap">
                {row.latestCredits != null ? formatCredits(row.latestCredits) : "—"}
              </td>
              <td
                className={`text-right px-2 py-2 font-mono whitespace-nowrap ${
                  row.creditsChange >= 0
                    ? "text-success"
                    : "text-error"
                }`}
              >
                {row.creditsChange >= 0 ? "+" : ""}
                {formatCredits(row.creditsChange)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ExpensiveTurnsTable Component (TODO #138)
// ---------------------------------------------------------------------------

interface ExpensiveTurn {
  id: number;
  agent: string;
  turnNumber: number;
  startedAt: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  iterations: number;
  durationMs: number;
  model: string | null;
  toolCallCount: number;
}

interface ExpensiveTurnsTableProps {
  hours?: number;
  limit?: number;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function cacheHitBadgeClass(rate: number): string {
  if (rate >= 0.6) return "text-success";
  if (rate >= 0.3) return "text-warning";
  return "text-muted-foreground";
}

export function ExpensiveTurnsTable({ hours, limit = 10 }: ExpensiveTurnsTableProps) {
  const [data, setData] = useState<ExpensiveTurn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);

    const params = new URLSearchParams();
    if (hours != null && hours > 0) params.append("hours", String(hours));
    params.append("limit", String(limit));

    apiFetch<ExpensiveTurn[]>(`/analytics-db/expensive-turns?${params}`)
      .then((raw) => {
        if (Array.isArray(raw)) setData(raw);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load expensive turns");
      })
      .finally(() => setLoading(false));
  }, [hours, limit]);

  if (loading) {
    return (
      <div className="h-[200px] flex items-center justify-center text-xs text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-[200px] flex items-center justify-center text-xs text-error opacity-70">
        Error: {error}
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="h-[200px] flex items-center justify-center text-xs text-muted-foreground italic">
        No turn cost data available
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[700px] text-[11px] border-collapse">
        <thead>
          <tr className="border-b border-border sticky top-0 bg-nord-1/50">
            <th className="text-left px-2 py-2 font-semibold text-foreground">Agent</th>
            <th className="text-right px-2 py-2 font-semibold text-foreground">Turn #</th>
            <th className="text-left px-2 py-2 font-semibold text-foreground">Time</th>
            <th className="text-right px-2 py-2 font-semibold text-foreground">Cost</th>
            <th className="text-right px-2 py-2 font-semibold text-foreground">Input</th>
            <th className="text-right px-2 py-2 font-semibold text-foreground">Output</th>
            <th className="text-right px-2 py-2 font-semibold text-foreground">Cache%</th>
            <th className="text-right px-2 py-2 font-semibold text-foreground">Iters</th>
            <th className="text-right px-2 py-2 font-semibold text-foreground">Duration</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => {
            const cacheRate = (row.inputTokens + row.cacheReadTokens) > 0
              ? row.cacheReadTokens / (row.inputTokens + row.cacheReadTokens)
              : 0;
            return (
              <tr key={row.id} className="border-b border-border/50 hover:bg-primary/5">
                <td className="px-2 py-2">
                  <a
                    href={`/agent/${row.agent}`}
                    className="hover:text-primary transition-colors"
                    style={{ color: AGENT_COLORS[row.agent] ?? "#88c0d0" }}
                  >
                    {row.agent}
                  </a>
                </td>
                <td className="text-right px-2 py-2 font-mono text-foreground/80">
                  {row.turnNumber}
                </td>
                <td className="px-2 py-2 font-mono text-foreground/60 text-[10px] whitespace-nowrap">
                  {formatFullTimestamp(row.startedAt)}
                </td>
                <td className="text-right px-2 py-2 font-mono font-semibold text-foreground">
                  {formatCost(row.costUsd)}
                </td>
                <td className="text-right px-2 py-2 font-mono text-foreground/80">
                  {formatTokens(row.inputTokens)}
                </td>
                <td className="text-right px-2 py-2 font-mono text-foreground/80">
                  {formatTokens(row.outputTokens)}
                </td>
                <td className={`text-right px-2 py-2 font-mono ${cacheHitBadgeClass(cacheRate)}`}>
                  {(cacheRate * 100).toFixed(0)}%
                </td>
                <td className="text-right px-2 py-2 font-mono text-foreground/80">
                  {row.iterations}
                </td>
                <td className="text-right px-2 py-2 font-mono text-foreground/60">
                  {formatDuration(row.durationMs)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TokenEfficiencyPanel Component (TODO #138)
// ---------------------------------------------------------------------------

interface AgentEfficiencyEntry {
  agent: string;
  totalCost: number;
  avgCostPerTurn: number;
  avgInputTokensPerTurn: number;
  avgOutputTokensPerTurn: number;
  cacheHitRate: number;
  estimatedCacheSavings: number;
  creditsPerDollar: number | null;
}

// ---------------------------------------------------------------------------
// Economy P&L
// ---------------------------------------------------------------------------

interface PnlSummary {
  agent: string;
  totalEarned: number;
  totalSpent: number;
  netPnl: number;
  actionCount: number;
}

interface PnlTopItem {
  item: string;
  totalCredits: number;
  quantity: number;
}

interface PnlResponse {
  agents: PnlSummary[];
  fleetTotals: { earned: number; spent: number; net: number };
  topRevenue: PnlTopItem[];
  topCosts: PnlTopItem[];
}

export function EconomyPnlPanel({ hours }: { hours?: number }) {
  const [data, setData] = useState<PnlResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (hours != null && hours > 0) params.append("hours", String(hours));
    apiFetch<PnlResponse>(`/economy/pnl?${params}`)
      .then((raw) => { if (raw) setData(raw); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [hours]);

  if (loading) return <div className="h-[200px] flex items-center justify-center text-xs text-muted-foreground">Loading...</div>;
  if (!data || data.agents.length === 0) return <div className="h-[200px] flex items-center justify-center text-xs text-muted-foreground italic">No economy data</div>;

  const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(0)}k` : n.toFixed(0);

  return (
    <div className="space-y-4">
      {/* Fleet totals */}
      <div className="grid grid-cols-3 gap-4 text-center">
        <div className="bg-secondary/30 p-3 ">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Earned</div>
          <div className="text-lg font-mono text-green-400">{fmt(data.fleetTotals.earned)} CR</div>
        </div>
        <div className="bg-secondary/30 p-3 ">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Spent</div>
          <div className="text-lg font-mono text-red-400">{fmt(data.fleetTotals.spent)} CR</div>
        </div>
        <div className="bg-secondary/30 p-3 ">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Net P&L</div>
          <div className={`text-lg font-mono ${data.fleetTotals.net >= 0 ? "text-green-400" : "text-red-400"}`}>
            {data.fleetTotals.net >= 0 ? "+" : ""}{fmt(data.fleetTotals.net)} CR
          </div>
        </div>
      </div>
      {/* Per-agent table */}
      <div className="overflow-x-auto">
        <table className="w-full text-[11px] border-collapse">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left px-2 py-2 font-semibold">Agent</th>
              <th className="text-right px-2 py-2 font-semibold">Earned</th>
              <th className="text-right px-2 py-2 font-semibold">Spent</th>
              <th className="text-right px-2 py-2 font-semibold">Net</th>
              <th className="text-right px-2 py-2 font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {data.agents.map((a) => (
              <tr key={a.agent} className="border-b border-border/50 hover:bg-primary/5">
                <td className="px-2 py-2" style={{ color: AGENT_COLORS[a.agent] ?? "#88c0d0" }}>{a.agent}</td>
                <td className="text-right px-2 py-2 font-mono text-green-400/80">{fmt(a.totalEarned)}</td>
                <td className="text-right px-2 py-2 font-mono text-red-400/80">{fmt(a.totalSpent)}</td>
                <td className={`text-right px-2 py-2 font-mono ${a.netPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                  {a.netPnl >= 0 ? "+" : ""}{fmt(a.netPnl)}
                </td>
                <td className="text-right px-2 py-2 font-mono text-foreground/60">{a.actionCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Top items */}
      {data.topRevenue.length > 0 && (
        <div>
          <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Top Revenue Items</h3>
          <div className="flex flex-wrap gap-2">
            {data.topRevenue.slice(0, 5).map((item) => (
              <span key={item.item} className="px-2 py-1 bg-green-900/20 text-green-400 text-[10px] ">
                {item.item}: {fmt(item.totalCredits)} CR ({item.quantity}x)
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model Cost Comparison
// ---------------------------------------------------------------------------

interface ModelCostEntry {
  model: string;
  turnCount: number;
  totalCost: number;
  avgCostPerTurn: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  totalHours: number;
  costPerHour: number;
  outputTokensPerDollar: number | null;
}

export function ModelCostComparison({ hours }: { hours?: number }) {
  const [data, setData] = useState<ModelCostEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (hours != null && hours > 0) params.append("hours", String(hours));
    apiFetch<ModelCostEntry[]>(`/analytics-db/model-costs?${params}`)
      .then((raw) => { if (Array.isArray(raw)) setData(raw); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [hours]);

  if (loading) return <div className="h-[200px] flex items-center justify-center text-xs text-muted-foreground">Loading...</div>;
  if (data.length === 0) return <div className="h-[200px] flex items-center justify-center text-xs text-muted-foreground italic">No model cost data</div>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px] border-collapse">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left px-2 py-2 font-semibold">Model</th>
            <th className="text-right px-2 py-2 font-semibold">Turns</th>
            <th className="text-right px-2 py-2 font-semibold">Total Cost</th>
            <th className="text-right px-2 py-2 font-semibold">Avg/Turn</th>
            <th className="text-right px-2 py-2 font-semibold">$/Hour</th>
            <th className="text-right px-2 py-2 font-semibold">Avg Tokens</th>
            <th className="text-right px-2 py-2 font-semibold whitespace-nowrap">Output/$</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr key={row.model} className="border-b border-border/50 hover:bg-primary/5">
              <td className="px-2 py-2 font-mono text-primary">{row.model}</td>
              <td className="text-right px-2 py-2 font-mono text-foreground/80">{row.turnCount}</td>
              <td className="text-right px-2 py-2 font-mono text-foreground/80">{formatCost(row.totalCost)}</td>
              <td className="text-right px-2 py-2 font-mono text-foreground/80">{formatCost(row.avgCostPerTurn)}</td>
              <td className="text-right px-2 py-2 font-mono text-foreground/80">{formatCost(row.costPerHour)}</td>
              <td className="text-right px-2 py-2 font-mono text-foreground/60">
                {formatTokens(row.avgInputTokens + row.avgOutputTokens)}
              </td>
              <td className="text-right px-2 py-2 font-mono text-foreground/80">
                {row.outputTokensPerDollar != null ? formatTokens(Math.round(row.outputTokensPerDollar)) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Session P&L
// ---------------------------------------------------------------------------

interface SessionPnlBreakdown {
  actionType: string;
  totalDelta: number;
  count: number;
}

interface SessionPnl {
  agent: string;
  sessionStart: string;
  sessionEnd: string;
  creditsStart: number;
  creditsEnd: number;
  creditsDelta: number;
  breakdown: SessionPnlBreakdown[];
  location: string;
}

export function SessionPnlPanel({ agents }: { agents?: string[] }) {
  const [data, setData] = useState<SessionPnl[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string>("");
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    params.append("limit", "40");
    if (selectedAgent) params.append("agent", selectedAgent);
    apiFetch<{ sessions: SessionPnl[] }>(`/economy/session-pnl?${params}`)
      .then((raw) => {
        if (raw?.sessions) setData(raw.sessions);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load session P&L");
      })
      .finally(() => setLoading(false));
  }, [selectedAgent]);

  const availableAgents = agents ?? Object.keys(AGENT_COLORS);
  const fmt = (n: number) =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(0)}k` : n.toFixed(0);

  return (
    <div className="space-y-3">
      {/* Agent filter */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Agent:</span>
        <select
          value={selectedAgent}
          onChange={(e) => { setSelectedAgent(e.target.value); setExpandedIdx(null); }}
          className="text-xs bg-secondary border border-border px-2 py-1 text-foreground"
        >
          <option value="">All agents</option>
          {availableAgents.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
      </div>

      {loading && (
        <div className="h-[200px] flex items-center justify-center text-xs text-muted-foreground">Loading...</div>
      )}
      {error && (
        <div className="h-[200px] flex items-center justify-center text-xs text-error opacity-70">Error: {error}</div>
      )}
      {!loading && !error && data.length === 0 && (
        <div className="h-[200px] flex items-center justify-center text-xs text-muted-foreground italic">
          No session data — agents need at least 2 handoff records
        </div>
      )}
      {!loading && !error && data.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-[11px] border-collapse">
            <thead>
              <tr className="border-b border-border sticky top-0 bg-nord-1/50">
                <th className="text-left px-2 py-2 font-semibold text-foreground w-4"></th>
                <th className="text-left px-2 py-2 font-semibold text-foreground">Agent</th>
                <th className="text-left px-2 py-2 font-semibold text-foreground">Session Start</th>
                <th className="text-left px-2 py-2 font-semibold text-foreground">Session End</th>
                <th className="text-right px-2 py-2 font-semibold text-foreground whitespace-nowrap">Credits Start → End</th>
                <th className="text-right px-2 py-2 font-semibold text-foreground">Delta</th>
                <th className="text-left px-2 py-2 font-semibold text-foreground">Top Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.map((row, idx) => {
                const isExpanded = expandedIdx === idx;
                const topActions = row.breakdown.slice(0, 3);
                return (
                  <>
                    <tr
                      key={`${row.agent}-${row.sessionEnd}-${idx}`}
                      className="border-b border-border/50 hover:bg-primary/5 cursor-pointer"
                      onClick={() => setExpandedIdx(isExpanded ? null : idx)}
                    >
                      <td className="px-2 py-2 text-muted-foreground text-[10px]">
                        {isExpanded ? "▾" : "▸"}
                      </td>
                      <td className="px-2 py-2">
                        <span style={{ color: AGENT_COLORS[row.agent] ?? "#88c0d0" }}>
                          {row.agent}
                        </span>
                      </td>
                      <td className="px-2 py-2 font-mono text-foreground/60 text-[10px] whitespace-nowrap">
                        {formatFullTimestamp(row.sessionStart)}
                      </td>
                      <td className="px-2 py-2 font-mono text-foreground/60 text-[10px] whitespace-nowrap">
                        {formatFullTimestamp(row.sessionEnd)}
                      </td>
                      <td className="text-right px-2 py-2 font-mono text-foreground/80 whitespace-nowrap">
                        {fmt(row.creditsStart)} → {fmt(row.creditsEnd)}
                      </td>
                      <td
                        className={`text-right px-2 py-2 font-mono font-semibold whitespace-nowrap ${
                          row.creditsDelta >= 0 ? "text-green-400" : "text-red-400"
                        }`}
                      >
                        {row.creditsDelta >= 0 ? "+" : ""}{fmt(row.creditsDelta)}
                      </td>
                      <td className="px-2 py-2 text-foreground/60">
                        {topActions.length > 0
                          ? topActions.map((b) => `${b.actionType}(${b.count})`).join(", ")
                          : "—"}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr key={`${row.agent}-${row.sessionEnd}-${idx}-expanded`} className="bg-secondary/20 border-b border-border/50">
                        <td colSpan={7} className="px-4 py-3">
                          <div className="space-y-2">
                            {row.location && (
                              <div className="text-[10px] text-muted-foreground">
                                Location at end: <span className="text-foreground/70">{row.location}</span>
                              </div>
                            )}
                            {row.breakdown.length === 0 ? (
                              <div className="text-[10px] text-muted-foreground italic">No action log entries in this session window</div>
                            ) : (
                              <table className="w-full text-[10px] border-collapse">
                                <thead>
                                  <tr className="border-b border-border/30">
                                    <th className="text-left px-2 py-1 font-semibold text-muted-foreground">Action Type</th>
                                    <th className="text-right px-2 py-1 font-semibold text-muted-foreground">Count</th>
                                    <th className="text-right px-2 py-1 font-semibold text-muted-foreground">Total Delta</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {row.breakdown.map((b) => (
                                    <tr key={b.actionType} className="border-b border-border/20">
                                      <td className="px-2 py-1 text-foreground/70">{b.actionType}</td>
                                      <td className="text-right px-2 py-1 font-mono text-foreground/60">{b.count}</td>
                                      <td
                                        className={`text-right px-2 py-1 font-mono ${
                                          b.totalDelta >= 0 ? "text-green-400/80" : "text-red-400/80"
                                        }`}
                                      >
                                        {b.totalDelta >= 0 ? "+" : ""}{fmt(b.totalDelta)}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Token Efficiency
// ---------------------------------------------------------------------------

interface TokenEfficiencyPanelProps {
  hours?: number;
}

export function TokenEfficiencyPanel({ hours }: TokenEfficiencyPanelProps) {
  const [data, setData] = useState<AgentEfficiencyEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);

    const params = new URLSearchParams();
    if (hours != null && hours > 0) params.append("hours", String(hours));

    apiFetch<AgentEfficiencyEntry[]>(`/analytics-db/efficiency?${params}`)
      .then((raw) => {
        if (Array.isArray(raw)) setData(raw);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load efficiency data");
      })
      .finally(() => setLoading(false));
  }, [hours]);

  if (loading) {
    return (
      <div className="h-[200px] flex items-center justify-center text-xs text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-[200px] flex items-center justify-center text-xs text-error opacity-70">
        Error: {error}
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="h-[200px] flex items-center justify-center text-xs text-muted-foreground italic">
        No efficiency data available
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-[11px] border-collapse">
        <thead>
          <tr className="border-b border-border sticky top-0 bg-nord-1/50">
            <th className="text-left px-2 py-2 font-semibold text-foreground">Agent</th>
            <th className="text-right px-2 py-2 font-semibold text-foreground">Total Cost</th>
            <th className="text-right px-2 py-2 font-semibold text-foreground">Avg/Turn</th>
            <th className="text-right px-2 py-2 font-semibold text-foreground">Avg Tokens/Turn</th>
            <th className="text-right px-2 py-2 font-semibold text-foreground">Cache Hit%</th>
            <th className="text-right px-2 py-2 font-semibold text-foreground">Cache Savings</th>
            <th className="text-right px-2 py-2 font-semibold text-foreground whitespace-nowrap">Credits/$</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr key={row.agent} className="border-b border-border/50 hover:bg-primary/5">
              <td className="px-2 py-2">
                <a
                  href={`/agent/${row.agent}`}
                  className="hover:text-primary transition-colors"
                  style={{ color: AGENT_COLORS[row.agent] ?? "#88c0d0" }}
                >
                  {row.agent}
                </a>
              </td>
              <td className="text-right px-2 py-2 font-mono text-foreground/80">
                {formatCost(row.totalCost)}
              </td>
              <td className="text-right px-2 py-2 font-mono text-foreground/80">
                {formatCost(row.avgCostPerTurn)}
              </td>
              <td className="text-right px-2 py-2 font-mono text-foreground/60">
                {formatTokens(Math.round(row.avgInputTokensPerTurn + row.avgOutputTokensPerTurn))}
              </td>
              <td className={`text-right px-2 py-2 font-mono ${cacheHitBadgeClass(row.cacheHitRate)}`}>
                {(row.cacheHitRate * 100).toFixed(1)}%
              </td>
              <td className="text-right px-2 py-2 font-mono text-success">
                {row.estimatedCacheSavings > 0 ? `Saved ${formatCost(row.estimatedCacheSavings)}` : "—"}
              </td>
              <td className="text-right px-2 py-2 font-mono text-foreground/80 whitespace-nowrap">
                {row.creditsPerDollar != null
                  ? `${(row.creditsPerDollar / 1000).toFixed(0)}k CR/$`
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Session Credits Chart — credits delta per session, by agent
// Derived from session_handoffs (always available, independent of turns table)
// ---------------------------------------------------------------------------

interface SessionCreditPoint {
  sessionEnd: string;
  [agent: string]: number | string;
}

export function SessionCreditChart() {
  const [data, setData] = useState<SessionCreditPoint[]>([]);
  const [agents, setAgents] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    apiFetch<{ sessions: SessionPnl[] }>("/economy/session-pnl?limit=40")
      .then((raw) => {
        if (!raw?.sessions?.length) {
          setData([]);
          return;
        }

        // One bar per session end time, keyed by agent
        const agentSet = new Set<string>();
        raw.sessions.forEach((s) => agentSet.add(s.agent));
        setAgents(Array.from(agentSet));

        // Sort sessions oldest-first so chart reads left-to-right
        const sorted = [...raw.sessions].sort(
          (a, b) => new Date(a.sessionEnd).getTime() - new Date(b.sessionEnd).getTime()
        );

        // Group by sessionEnd timestamp per agent
        const pointMap: Record<string, SessionCreditPoint> = {};
        for (const s of sorted) {
          const key = s.sessionEnd;
          if (!pointMap[key]) {
            pointMap[key] = { sessionEnd: formatTimeShort(s.sessionEnd) };
          }
          pointMap[key][s.agent] = s.creditsDelta;
        }

        setData(Object.values(pointMap));
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load session data");
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="h-[300px] flex items-center justify-center text-xs text-muted-foreground">
        Loading session data…
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-[300px] flex items-center justify-center text-xs text-error opacity-70">
        Error: {error}
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="h-[300px] flex items-center justify-center text-xs text-muted-foreground italic">
        No session data available
      </div>
    );
  }

  return (
    <div className="h-[300px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#3b4252" strokeOpacity={0.4} />
          <XAxis
            dataKey="sessionEnd"
            tick={{ fill: "#8892a8", fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: "#3b4252" }}
            interval="preserveStartEnd"
          />
          <YAxis
            tickFormatter={(v) =>
              Math.abs(v) >= 1_000_000
                ? `${(v / 1_000_000).toFixed(1)}M`
                : Math.abs(v) >= 1_000
                ? `${(v / 1_000).toFixed(0)}k`
                : String(v)
            }
            tick={{ fill: "#8892a8", fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: "#3b4252" }}
            width={48}
          />
          <Tooltip
            formatter={(value, name) => {
              const v = typeof value === "number" ? value : 0;
              const n = typeof name === "string" ? name : "";
              return [v >= 0 ? `+${v.toLocaleString()} cr` : `${v.toLocaleString()} cr`, n];
            }}
            contentStyle={{ background: "#3b4252", border: "1px solid #4c566a", fontSize: 11 }}
            labelStyle={{ color: "#d8dee9", fontSize: 10 }}
          />
          <Legend wrapperStyle={{ fontSize: 10 }} height={20} />
          {agents.map((agent) => (
            <Bar
              key={agent}
              dataKey={agent}
              fill={AGENT_COLORS[agent] ?? "#88c0d0"}
              stackId="stack"
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
