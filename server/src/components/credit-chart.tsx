"use client";

import { useEffect, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts";
import { formatAbsolute, formatTimeShort } from "@/lib/time";
import { formatCredits as formatCreditsFull, formatCreditsCompact } from "@/lib/format";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CreditsDataPoint {
  timestamp: string;
  credits: number;
  system: string;
  poi: string;
}

interface ChartDataPoint {
  time: string;
  credits: number;
  fullTimestamp: string;
  system: string;
  /** Non-empty string ("Apr 24") on the first point of a new local day. */
  dayStart?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Y-axis tick labels — compact credits form with "cr" suffix.
const formatCreditsAxis = (n: number) => formatCreditsCompact(n);

// X-axis tick labels — short HH:MM via the shared helper.
const formatTimestamp = formatTimeShort;
// Tooltip title — canonical absolute form.
const formatFullTimestamp = formatAbsolute;

// ---------------------------------------------------------------------------
// Custom tooltip
// ---------------------------------------------------------------------------

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ value: number; payload: ChartDataPoint }>;
  label?: string;
}

function CustomTooltip({ active, payload }: CustomTooltipProps) {
  if (!active || !payload?.length) return null;
  const pt = payload[0];
  return (
    <div
      style={{ background: "#3b4252", border: "1px solid #4c566a" }}
      className="px-3 py-2 text-xs font-mono space-y-1"
    >
      <div className="text-foreground">{pt.payload.fullTimestamp}</div>
      <div style={{ color: "#88c0d0" }}>
        {formatCreditsFull(pt.value)}
      </div>
      {pt.payload.system && (
        <div className="text-muted-foreground opacity-70">
          {pt.payload.system}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface CreditChartProps {
  agentName: string;
}

export function CreditChart({ agentName }: CreditChartProps) {
  const [data, setData] = useState<ChartDataPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!agentName) return;

    setLoading(true);
    setError(null);

    fetch(`/api/analytics-db/credits?agent=${encodeURIComponent(agentName)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<CreditsDataPoint[]>;
      })
      .then((raw) => {
        if (!Array.isArray(raw) || raw.length === 0) {
          setData([]);
          return;
        }
        // Downsample if many points — show at most 200 points
        const MAX_POINTS = 200;
        let pts = raw;
        if (pts.length > MAX_POINTS) {
          const step = Math.ceil(pts.length / MAX_POINTS);
          pts = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
        }
        // Track day boundaries for reference line markers
        let prevDate: string | null = null;
        setData(
          pts.map((pt) => {
            const d = new Date(
              pt.timestamp.includes("T")
                ? pt.timestamp
                : pt.timestamp.replace(" ", "T") + "Z"
            );
            const localDate = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
            const isDayStart = prevDate !== null && localDate !== prevDate;
            prevDate = localDate;
            const dayLabel = `${d.toLocaleString("en-US", { month: "short" })} ${d.getDate()}`;
            return {
              time: formatTimestamp(pt.timestamp),
              credits: pt.credits,
              fullTimestamp: formatFullTimestamp(pt.timestamp),
              system: pt.system ?? "",
              dayStart: isDayStart ? dayLabel : undefined,
            };
          })
        );
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load data");
      })
      .finally(() => setLoading(false));
  }, [agentName]);

  if (loading) {
    return (
      <div className="h-[300px] flex items-center justify-center text-xs text-muted-foreground">
        Loading credit history…
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
        No credit history available
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
            stroke="#4c566a"
            strokeOpacity={0.4}
          />
          <XAxis
            dataKey="time"
            tick={{ fill: "#616e88", fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: "#4c566a" }}
            interval="preserveStartEnd"
          />
          <YAxis
            tickFormatter={formatCreditsAxis}
            tick={{ fill: "#616e88", fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: "#4c566a" }}
            width={60}
          />
          <Tooltip content={<CustomTooltip />} />
          {/* Midnight reference lines — one per day boundary in the visible range */}
          {data
            .filter((pt) => pt.dayStart)
            .map((pt) => (
              <ReferenceLine
                key={`day-${pt.time}`}
                x={pt.time}
                stroke="#4c566a"
                strokeDasharray="4 3"
                strokeOpacity={0.6}
                label={{
                  value: pt.dayStart as string,
                  position: "insideTopRight",
                  fill: "#616e88",
                  fontSize: 9,
                }}
              />
            ))}
          <Line
            type="monotone"
            dataKey="credits"
            stroke="#88c0d0"
            strokeWidth={1.5}
            dot={false}
            activeDot={{ r: 3, fill: "#88c0d0" }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
