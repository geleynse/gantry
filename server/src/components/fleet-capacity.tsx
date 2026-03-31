"use client";

import Link from "next/link";

import { useEffect, useState } from "react";
import { cn, formatCredits, relativeTime } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types (mirrored from API shape — no server imports in client bundle)
// ---------------------------------------------------------------------------

interface AgentCapacity {
  name: string;
  role: string | undefined;
  zone: string | undefined;
  system: string | undefined;
  credits: number | null;
  cargoUsed: number | null;
  cargoMax: number | null;
  fuel: number | null;
  fuelMax: number | null;
  hullPercent: number | null;
  online: boolean;
  /** True when data is present but stale (agent offline, showing last-known values) */
  isStale?: boolean;
  /** Unix ms timestamp of last known activity, or null if no data */
  lastActiveAt?: number | null;
}

interface ZoneCoverageData {
  covered: Record<string, string[]>;
  uncovered: string[];
}

interface FleetTotals {
  totalCredits: number;
  totalCargoCapacity: number;
  totalCargoUsed: number;
  agentCount: number;
  onlineCount: number;
  byRole: Record<string, number>;
}

interface CapacityData {
  agents: AgentCapacity[];
  totals: FleetTotals;
  zoneCoverage: ZoneCoverageData;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatCargo(used: number | null, max: number | null): string {
  if (used === null && max === null) return "—";
  if (max === null) return `${used ?? "?"} used`;
  return `${used ?? 0} / ${max}`;
}
// Note: formatCargo already handles "X used" for known-used/null-max.
// The real fix is in fleet-capacity.ts: offline agents now retain cargoMax
// from cache so "X / Y" will show instead of "X used".

function cargoPercent(used: number | null, max: number | null): number | null {
  if (used === null || max === null || max === 0) return null;
  return Math.round((used / max) * 100);
}

function hullColor(pct: number | null): string {
  if (pct === null) return "text-muted-foreground";
  if (pct >= 70) return "text-success";
  if (pct >= 40) return "text-warning";
  return "text-error";
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SummaryCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-card border border-border p-3 flex flex-col gap-1">
      <span className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</span>
      <span className="font-mono text-sm font-semibold text-foreground">{value}</span>
      {sub && <span className="text-[10px] text-muted-foreground">{sub}</span>}
    </div>
  );
}

function RoleBreakdown({ byRole }: { byRole: Record<string, number> }) {
  const roles = Object.entries(byRole).sort((a, b) => b[1] - a[1]);
  if (roles.length === 0) return <span className="text-muted-foreground text-xs">—</span>;

  return (
    <div className="flex flex-wrap gap-1.5">
      {roles.map(([role, count]) => (
        <span
          key={role}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-secondary text-[10px] font-medium text-foreground"
        >
          <span className="font-bold">{count}</span>
          <span className="text-muted-foreground">{role}</span>
        </span>
      ))}
    </div>
  );
}

function ZoneMap({
  covered,
  uncovered,
}: {
  covered: Record<string, string[]>;
  uncovered: string[];
}) {
  const allZones = [...Object.keys(covered), ...uncovered].sort();
  if (allZones.length === 0) {
    return <span className="text-muted-foreground text-xs">No zones configured</span>;
  }

  return (
    <div className="space-y-1">
      {allZones.map((zone) => {
        const agents = covered[zone] ?? [];
        const hasCoverage = agents.length > 0;
        return (
          <div key={zone} className="flex items-center gap-2 text-xs">
            <span
              className={cn(
                "inline-block w-2 h-2 rounded-full shrink-0",
                hasCoverage ? "bg-success" : "bg-error opacity-60",
              )}
            />
            <span className="font-mono text-foreground">{zone}</span>
            {hasCoverage ? (
              <span className="text-muted-foreground">{agents.join(", ")}</span>
            ) : (
              <span className="text-error text-[10px]">uncovered</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

type SortKey = "name" | "credits" | "cargo" | "zone" | "online" | "lastActive";

// ---------------------------------------------------------------------------
// ThButton — extracted so it's not recreated on every AgentTable render
// ---------------------------------------------------------------------------

interface ThButtonProps {
  label: string;
  sortK: SortKey;
  activeSortKey: SortKey;
  asc: boolean;
  onSort: (key: SortKey) => void;
}

function ThButton({ label, sortK, activeSortKey, asc, onSort }: ThButtonProps) {
  return (
    <button
      onClick={() => onSort(sortK)}
      aria-label={`Sort by ${label}`}
      className={cn(
        "text-left text-[10px] uppercase tracking-wider select-none cursor-pointer hover:text-foreground transition-colors",
        activeSortKey === sortK ? "text-primary" : "text-muted-foreground",
      )}
    >
      {label}
      {activeSortKey === sortK ? (asc ? " ↑" : " ↓") : ""}
    </button>
  );
}

function AgentTable({ agents }: { agents: AgentCapacity[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [asc, setAsc] = useState(true);

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setAsc((v) => !v);
    } else {
      setSortKey(key);
      setAsc(true);
    }
  }

  // Overseer has its own dedicated page — hide from fleet agent table
  const filteredAgents = agents.filter((a) => a.name !== "overseer");

  const sorted = [...filteredAgents].sort((a, b) => {
    let cmp = 0;
    switch (sortKey) {
      case "name":
        cmp = a.name.localeCompare(b.name);
        break;
      case "credits":
        cmp = (a.credits ?? -1) - (b.credits ?? -1);
        break;
      case "cargo":
        cmp = (cargoPercent(a.cargoUsed, a.cargoMax) ?? -1) - (cargoPercent(b.cargoUsed, b.cargoMax) ?? -1);
        break;
      case "zone":
        cmp = (a.zone ?? "").localeCompare(b.zone ?? "");
        break;
      case "online":
        cmp = Number(a.online) - Number(b.online);
        break;
      case "lastActive":
        cmp = (a.lastActiveAt ?? 0) - (b.lastActiveAt ?? 0);
        break;
    }
    return asc ? cmp : -cmp;
  });

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="border-b border-border">
            <th className="py-2 pr-4 text-left"><ThButton label="Agent" sortK="name" activeSortKey={sortKey} asc={asc} onSort={handleSort} /></th>
            <th className="py-2 pr-4 text-left"><ThButton label="Status" sortK="online" activeSortKey={sortKey} asc={asc} onSort={handleSort} /></th>
            <th className="py-2 pr-4 text-left">Role</th>
            <th className="py-2 pr-4 text-left"><ThButton label="Zone" sortK="zone" activeSortKey={sortKey} asc={asc} onSort={handleSort} /></th>
            <th className="py-2 pr-4 text-left">System</th>
            <th className="py-2 pr-4 text-right"><ThButton label="Credits" sortK="credits" activeSortKey={sortKey} asc={asc} onSort={handleSort} /></th>
            <th className="py-2 pr-4 text-right"><ThButton label="Cargo" sortK="cargo" activeSortKey={sortKey} asc={asc} onSort={handleSort} /></th>
            <th className="py-2 pr-4 text-right">Hull</th>
            <th className="py-2 text-right"><ThButton label="Last Active" sortK="lastActive" activeSortKey={sortKey} asc={asc} onSort={handleSort} /></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((agent) => {
            const cargoPct = cargoPercent(agent.cargoUsed, agent.cargoMax);
            return (
              <tr key={agent.name} className="border-b border-border/40 hover:bg-secondary/20">
                <td className="py-1.5 pr-4 font-mono"><Link href={`/agent/${agent.name}`} className="hover:text-primary transition-colors">{agent.name}</Link></td>
                <td className="py-1.5 pr-4">
                  <span
                    role="img"
                    aria-label={agent.online ? "Online" : "Offline"}
                    title={agent.online ? "Online" : "Offline"}
                    className={cn(
                      "inline-block w-2 h-2 rounded-full",
                      agent.online ? "bg-success" : "bg-muted-foreground opacity-50",
                    )}
                  />
                </td>
                <td className="py-1.5 pr-4 text-muted-foreground">{agent.role ?? "—"}</td>
                <td className="py-1.5 pr-4 font-mono text-[10px]">{agent.zone ?? "—"}</td>
                <td className="py-1.5 pr-4 text-muted-foreground">{agent.system ?? "—"}</td>
                <td className={cn("py-1.5 pr-4 text-right font-mono", agent.isStale && "opacity-50 italic")}>
                  {formatCredits(agent.credits)}
                </td>
                <td className="py-1.5 pr-4 text-right">
                  <span className={cn(
                    cargoPct !== null && cargoPct >= 80 ? "text-warning" : "text-foreground",
                    agent.isStale && "opacity-50 italic",
                  )}>
                    {formatCargo(agent.cargoUsed, agent.cargoMax)}
                  </span>
                  {cargoPct !== null && (
                    <span className="text-muted-foreground text-[10px] ml-1">({cargoPct}%)</span>
                  )}
                </td>
                <td className={cn("py-1.5 pr-4 text-right font-mono", hullColor(agent.hullPercent), agent.isStale && "opacity-50 italic")}>
                  {agent.hullPercent !== null ? `${agent.hullPercent}%` : "—"}
                </td>
                <td className="py-1.5 text-right text-muted-foreground text-[10px] font-mono whitespace-nowrap">
                  {agent.lastActiveAt ? relativeTime(agent.lastActiveAt) : "—"}
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
// Main component
// ---------------------------------------------------------------------------

export function FleetCapacity() {
  const [data, setData] = useState<CapacityData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    async function load() {
      try {
        const res = await fetch("/api/fleet/capacity");
        if (!res.ok) throw new Error(`API ${res.status}`);
        const json = await res.json() as CapacityData;
        if (mounted) {
          setData(json);
          setError(null);
        }
      } catch (err) {
        if (mounted) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();
    const interval = setInterval(load, 30_000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  if (loading) {
    return (
      <div className="text-muted-foreground text-xs p-4">Loading fleet capacity…</div>
    );
  }

  if (error) {
    return (
      <div className="text-error text-xs p-4">Failed to load fleet capacity: {error}</div>
    );
  }

  if (!data) return null;

  const { agents, totals, zoneCoverage } = data;
  const cargoUtilPct = totals.totalCargoCapacity > 0
    ? Math.round((totals.totalCargoUsed / totals.totalCargoCapacity) * 100)
    : 0;

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <SummaryCard
          label="Fleet Credits"
          value={formatCredits(totals.totalCredits)}
          sub={`${totals.onlineCount}/${totals.agentCount} agents online`}
        />
        <SummaryCard
          label="Total Cargo"
          value={`${totals.totalCargoUsed} / ${totals.totalCargoCapacity}`}
          sub={`${cargoUtilPct}% utilization`}
        />
        <SummaryCard
          label="Agents"
          value={String(totals.agentCount)}
          sub={`${totals.onlineCount} online`}
        />
        <SummaryCard
          label="Zones Covered"
          value={`${Object.keys(zoneCoverage.covered).length}`}
          sub={
            zoneCoverage.uncovered.length > 0
              ? `${zoneCoverage.uncovered.length} uncovered`
              : "Full coverage"
          }
        />
      </div>

      {/* Role breakdown + zone map */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
            Role Breakdown
          </h3>
          <RoleBreakdown byRole={totals.byRole} />
        </div>
        <div>
          <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
            Zone Coverage
          </h3>
          <ZoneMap covered={zoneCoverage.covered} uncovered={zoneCoverage.uncovered} />
        </div>
      </div>

      {/* Per-agent table */}
      <div>
        <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
          Agent Details
        </h3>
        <AgentTable agents={agents} />
      </div>
    </div>
  );
}
