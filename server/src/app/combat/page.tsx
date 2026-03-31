"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { Skull, Swords, Shield, AlertTriangle, RefreshCw } from "lucide-react";
import { EncounterCard, tierBadge } from "@/components/encounter-card";
import type { Encounter, CombatEvent } from "@/components/encounter-card";
import { groupEncounters } from "@/lib/combat-grouping";
import type { GroupBy } from "@/lib/combat-grouping";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentSummary {
  agent: string;
  total_hits: number;
  total_encounters: number;
  total_damage: number;
  total_deaths: number;
  total_insurance: number;
}

interface SystemRisk {
  system: string;
  encounter_count: number;
  death_count: number;
  total_damage: number;
}

interface TimelineCell {
  encounters: number;
  deaths: number;
}

type TimelineRow = {
  date: string;
  agents: Record<string, TimelineCell>;
};

type TabId = "overview" | "battles" | "timeline" | "heatmap";
type DateRange = "1h" | "today" | "7d" | "30d" | "all";
type TimelineView = "table" | "visual";

interface HeatmapRow {
  system: string | null;
  agent: string;
  date: string;
  deaths: number;
  encounters: number;
  damage: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  color,
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="bg-card border border-border p-4 space-y-1">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className={`w-4 h-4 ${color ?? ""}`} />
        <span className="text-xs uppercase tracking-wider">{label}</span>
      </div>
      <div className="text-2xl font-semibold font-mono">{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a DateRange to a from-timestamp string (ISO) */
function dateRangeToFrom(range: DateRange): string {
  const now = new Date();
  switch (range) {
    case "1h":
      return new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    case "today": {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      return d.toISOString();
    }
    case "7d":
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    case "30d":
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    case "all":
      return "";
  }
}

// ---------------------------------------------------------------------------
// Tab bar
// ---------------------------------------------------------------------------

function TabBar({
  active,
  onChange,
}: {
  active: TabId;
  onChange: (tab: TabId) => void;
}) {
  const tabs: { id: TabId; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "battles", label: "Battle Log" },
    { id: "timeline", label: "Timeline" },
    { id: "heatmap", label: "Death Heatmap" },
  ];

  return (
    <div className="flex gap-0 border-b border-border">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`px-4 py-2 text-xs uppercase tracking-wider transition-colors ${
            active === tab.id
              ? "border-b-2 border-primary text-primary"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview tab
// ---------------------------------------------------------------------------

function OverviewTab({
  summary,
  systems,
  loading,
  agentFilter,
  setAgentFilter,
}: {
  summary: AgentSummary[];
  systems: SystemRisk[];
  loading: boolean;
  agentFilter: string;
  setAgentFilter: (v: string) => void;
}) {
  const totals = summary.reduce(
    (acc, s) => ({
      encounters: acc.encounters + s.total_encounters,
      deaths: acc.deaths + s.total_deaths,
      damage: acc.damage + s.total_damage,
      insurance: acc.insurance + s.total_insurance,
    }),
    { encounters: 0, deaths: 0, damage: 0, insurance: 0 }
  );

  return (
    <div className="space-y-6">
      {/* Fleet-wide stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard icon={Swords} label="Encounters" value={totals.encounters} />
        <StatCard icon={Shield} label="Damage Taken" value={totals.damage} />
        <StatCard icon={Skull} label="Deaths" value={totals.deaths} color="text-red-400" />
        <StatCard icon={AlertTriangle} label="Insurance Paid" value={`${totals.insurance} cr`} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Per-agent summary table */}
        <div className="lg:col-span-2 space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            Per-Agent Stats
          </h2>
          <div className="bg-card border border-border overflow-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground uppercase tracking-wider">
                  <th className="text-left px-3 py-2">Agent</th>
                  <th className="text-right px-3 py-2">Encounters</th>
                  <th className="text-right px-3 py-2">Damage</th>
                  <th className="text-right px-3 py-2">Deaths</th>
                  <th className="text-right px-3 py-2">Insurance</th>
                  <th className="text-right px-3 py-2">Survival</th>
                </tr>
              </thead>
              <tbody>
                {summary.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground text-xs">
                      {loading ? "Loading..." : "No combat data"}
                    </td>
                  </tr>
                ) : (
                  summary.map((s) => (
                    <tr
                      key={s.agent}
                      className="border-b border-border/50 hover:bg-secondary/30 transition-colors cursor-pointer"
                      onClick={() => setAgentFilter(agentFilter === s.agent ? "" : s.agent)}
                    >
                      <td className={`px-3 py-2 font-mono text-xs ${agentFilter === s.agent ? "text-primary font-semibold" : ""}`}>
                        {s.agent}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{s.total_encounters}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{s.total_damage}</td>
                      <td className={`px-3 py-2 text-right font-mono text-xs ${s.total_deaths > 0 ? "text-red-400" : ""}`}>
                        {s.total_deaths}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{s.total_insurance} cr</td>
                      <td className={`px-3 py-2 text-right font-mono text-xs ${
                        s.total_encounters === 0 ? "text-muted-foreground/40" :
                        (s.total_encounters - s.total_deaths) / s.total_encounters >= 0.8 ? "text-green-400" :
                        (s.total_encounters - s.total_deaths) / s.total_encounters >= 0.5 ? "text-yellow-400" :
                        "text-red-400"
                      }`}>
                        {s.total_encounters === 0 ? "—" : `${Math.round(((s.total_encounters - s.total_deaths) / s.total_encounters) * 100)}%`}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* High-risk systems */}
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            High-Risk Systems
          </h2>
          <div className="bg-card border border-border overflow-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground uppercase tracking-wider">
                  <th className="text-left px-3 py-2">System</th>
                  <th className="text-right px-3 py-2">Hits</th>
                  <th className="text-right px-3 py-2">Deaths</th>
                </tr>
              </thead>
              <tbody>
                {systems.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-3 py-6 text-center text-muted-foreground text-xs">
                      No data
                    </td>
                  </tr>
                ) : (
                  systems.slice(0, 5).map((s) => (
                    <tr key={s.system} className="border-b border-border/50">
                      <td className="px-3 py-2 font-mono text-xs">{s.system}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{s.encounter_count}</td>
                      <td className={`px-3 py-2 text-right font-mono text-xs ${s.death_count > 0 ? "text-red-400" : ""}`}>
                        {s.death_count}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// GroupBy toggle
// ---------------------------------------------------------------------------

function GroupByToggle({
  value,
  onChange,
}: {
  value: GroupBy;
  onChange: (v: GroupBy) => void;
}) {
  const options: { id: GroupBy; label: string }[] = [
    { id: "flat", label: "Flat" },
    { id: "agent", label: "By Agent" },
    { id: "system", label: "By System" },
  ];
  return (
    <div className="flex items-center gap-1 border border-border rounded overflow-hidden" aria-label="Group by">
      {options.map((opt) => (
        <button
          key={opt.id}
          onClick={() => onChange(opt.id)}
          aria-pressed={value === opt.id}
          className={`px-3 py-1.5 text-xs font-mono transition-colors ${
            value === opt.id
              ? "bg-primary text-primary-foreground"
              : "bg-secondary text-muted-foreground hover:text-foreground"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Accordion group for grouped encounters
// ---------------------------------------------------------------------------

function EncounterGroup({
  groupKey,
  encounters,
  expandedId,
  eventCache,
  onToggle,
  defaultOpen,
}: {
  groupKey: string;
  encounters: Encounter[];
  expandedId: number | null;
  eventCache: Record<number, CombatEvent[]>;
  onToggle: (id: number) => void;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  const wins = encounters.filter((e) => e.outcome === "survived").length;
  const losses = encounters.filter((e) => e.outcome === "died").length;
  const fledCount = encounters.filter((e) => e.outcome === "fled").length;

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      {/* Accordion header */}
      <button
        className="w-full flex items-center gap-3 px-3 py-2 bg-secondary/40 hover:bg-secondary/60 transition-colors text-left"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="text-xs font-mono font-semibold text-foreground flex-1 truncate">
          {groupKey}
        </span>
        <span className="text-xs font-mono text-muted-foreground shrink-0">
          {encounters.length} enc
        </span>
        {wins > 0 && (
          <span className="text-xs font-mono text-green-400 shrink-0">{wins}W</span>
        )}
        {losses > 0 && (
          <span className="text-xs font-mono text-red-400 shrink-0">{losses}L</span>
        )}
        {fledCount > 0 && (
          <span className="text-xs font-mono text-yellow-400 shrink-0">{fledCount}F</span>
        )}
        <span className="text-xs text-muted-foreground shrink-0 select-none">
          {open ? "▲" : "▼"}
        </span>
      </button>

      {/* Encounter cards */}
      {open && (
        <div className="divide-y divide-border/50">
          {encounters.map((enc) => (
            <EncounterCard
              key={enc.id}
              encounter={enc}
              expanded={expandedId === enc.id}
              onToggle={() => onToggle(enc.id)}
              events={eventCache[enc.id]}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Battle Log tab
// ---------------------------------------------------------------------------

const ENCOUNTER_LIMIT = 20;

function BattleLogTab({ summary, systems }: { summary: AgentSummary[]; systems: SystemRisk[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Read initial filter state from URL params
  const [agentFilter, setAgentFilterState] = useState(() => searchParams.get("agent") ?? "");
  const [systemFilter, setSystemFilterState] = useState(() => searchParams.get("system") ?? "");
  const [outcomeFilter, setOutcomeFilterState] = useState(() => searchParams.get("outcome") ?? "");
  const [tierFilter, setTierFilterState] = useState(() => searchParams.get("tier") ?? "");
  const [dateRange, setDateRangeState] = useState<DateRange>(
    () => (searchParams.get("range") as DateRange) ?? "all"
  );
  const [groupBy, setGroupByState] = useState<GroupBy>(
    () => (searchParams.get("groupBy") as GroupBy) ?? "flat"
  );

  const [encounters, setEncounters] = useState<Encounter[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);

  // Expanded + cached events
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [eventCache, setEventCache] = useState<Record<number, CombatEvent[]>>({});

  // System filter text input (local debounce)
  const systemInputRef = useRef<HTMLInputElement>(null);

  // Helper: push all current filter state to URL params
  const pushUrl = useCallback(
    (updates: Partial<{
      agent: string; system: string; outcome: string; tier: string;
      range: DateRange; groupBy: GroupBy;
    }>) => {
      const params = new URLSearchParams(searchParams.toString());
      const merged = {
        agent: agentFilter, system: systemFilter, outcome: outcomeFilter,
        tier: tierFilter, range: dateRange, groupBy,
        ...updates,
      };
      const keys = ["agent", "system", "outcome", "tier", "range", "groupBy"] as const;
      for (const key of keys) {
        const v = merged[key];
        if (v && v !== "all" && v !== "flat") {
          params.set(key, v);
        } else {
          params.delete(key);
        }
      }
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname, agentFilter, systemFilter, outcomeFilter, tierFilter, dateRange, groupBy]
  );

  // Setters that also update URL
  const setAgentFilter = (v: string) => { setAgentFilterState(v); pushUrl({ agent: v }); };
  const setOutcomeFilter = (v: string) => { setOutcomeFilterState(v); pushUrl({ outcome: v }); };
  const setTierFilter = (v: string) => { setTierFilterState(v); pushUrl({ tier: v }); };
  const setDateRange = (v: DateRange) => { setDateRangeState(v); pushUrl({ range: v }); };
  const setGroupBy = (v: GroupBy) => { setGroupByState(v); pushUrl({ groupBy: v }); };

  const fetchEncounters = useCallback(async (off = 0) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(ENCOUNTER_LIMIT), offset: String(off) });
      if (agentFilter) params.set("agent", agentFilter);
      if (systemFilter) params.set("system", systemFilter);
      if (outcomeFilter) params.set("outcome", outcomeFilter);
      if (tierFilter) params.set("pirate_tier", tierFilter);
      const from = dateRangeToFrom(dateRange);
      if (from) params.set("from", from);
      const res = await fetch(`/api/combat/encounters?${params}`);
      const data = await res.json();
      setEncounters(data.encounters ?? []);
      setTotal(data.total ?? 0);
    } finally {
      setLoading(false);
    }
  }, [agentFilter, systemFilter, outcomeFilter, tierFilter, dateRange]);

  useEffect(() => {
    setOffset(0);
    setExpandedId(null);
    fetchEncounters(0);
  }, [agentFilter, systemFilter, outcomeFilter, tierFilter, dateRange, fetchEncounters]);

  async function handleToggle(id: number) {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    if (eventCache[id]) return;
    try {
      const res = await fetch(`/api/combat/encounters/${id}`);
      const data = await res.json();
      setEventCache((prev) => ({ ...prev, [id]: data.events ?? [] }));
    } catch {
      setEventCache((prev) => ({ ...prev, [id]: [] }));
    }
  }

  const agentNames = summary.map((s) => s.agent);

  // Apply groupBy
  const groups = groupEncounters(encounters, groupBy);
  const isGrouped = groupBy !== "flat";

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex flex-wrap gap-2 items-center">
        {/* Agent dropdown */}
        <select
          value={agentFilter}
          onChange={(e) => setAgentFilter(e.target.value)}
          className="text-xs font-mono bg-secondary border border-border px-2 py-1.5 text-foreground"
          aria-label="Filter by agent"
        >
          <option value="">All Agents</option>
          {agentNames.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>

        {/* System text input */}
        <input
          ref={systemInputRef}
          type="text"
          value={systemFilter}
          onChange={(e) => {
            setSystemFilterState(e.target.value);
          }}
          onBlur={(e) => {
            pushUrl({ system: e.target.value });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              pushUrl({ system: systemFilter });
              fetchEncounters(0);
            }
          }}
          placeholder="System..."
          className="text-xs font-mono bg-secondary border border-border px-2 py-1.5 text-foreground w-28 placeholder:text-muted-foreground"
          aria-label="Filter by system"
        />

        {/* Outcome dropdown */}
        <select
          value={outcomeFilter}
          onChange={(e) => setOutcomeFilter(e.target.value)}
          className="text-xs font-mono bg-secondary border border-border px-2 py-1.5 text-foreground"
          aria-label="Filter by outcome"
        >
          <option value="">All Outcomes</option>
          <option value="survived">Survived</option>
          <option value="died">Died</option>
          <option value="fled">Fled</option>
        </select>

        {/* Tier dropdown */}
        <select
          value={tierFilter}
          onChange={(e) => setTierFilter(e.target.value)}
          className="text-xs font-mono bg-secondary border border-border px-2 py-1.5 text-foreground"
          aria-label="Filter by tier"
        >
          <option value="">All Tiers</option>
          <option value="small">Small</option>
          <option value="medium">Medium</option>
          <option value="large">Large</option>
          <option value="boss">Boss</option>
        </select>

        {/* Date range dropdown */}
        <select
          value={dateRange}
          onChange={(e) => setDateRange(e.target.value as DateRange)}
          className="text-xs font-mono bg-secondary border border-border px-2 py-1.5 text-foreground"
          aria-label="Date range"
        >
          <option value="1h">Last Hour</option>
          <option value="today">Today</option>
          <option value="7d">Last 7d</option>
          <option value="30d">Last 30d</option>
          <option value="all">All Time</option>
        </select>

        {/* Divider */}
        <div className="h-6 border-l border-border mx-1" />

        {/* GroupBy toggle */}
        <GroupByToggle value={groupBy} onChange={setGroupBy} />
      </div>

      {/* Encounter list / groups */}
      {loading ? (
        <div className="text-xs text-muted-foreground py-4 text-center">Loading...</div>
      ) : encounters.length === 0 ? (
        <div className="text-xs text-muted-foreground py-4 text-center">No encounters found</div>
      ) : isGrouped ? (
        <div className="space-y-3">
          {groups.map(({ key, encounters: groupEncs }) => (
            <EncounterGroup
              key={key}
              groupKey={key}
              encounters={groupEncs}
              expandedId={expandedId}
              eventCache={eventCache}
              onToggle={handleToggle}
              defaultOpen={groups.length === 1}
            />
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {encounters.map((enc) => (
            <EncounterCard
              key={enc.id}
              encounter={enc}
              expanded={expandedId === enc.id}
              onToggle={() => handleToggle(enc.id)}
              events={eventCache[enc.id]}
            />
          ))}
        </div>
      )}

      {/* Pagination (only in flat mode; grouped shows all fetched) */}
      {!isGrouped && total > ENCOUNTER_LIMIT && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <button
            onClick={() => {
              const newOff = Math.max(0, offset - ENCOUNTER_LIMIT);
              setOffset(newOff);
              fetchEncounters(newOff);
            }}
            disabled={offset === 0}
            className="px-3 py-1.5 bg-secondary disabled:opacity-40 hover:bg-secondary/80 transition-colors"
          >
            Prev
          </button>
          <span>
            {offset + 1}–{Math.min(offset + ENCOUNTER_LIMIT, total)} of {total}
          </span>
          <button
            onClick={() => {
              const newOff = offset + ENCOUNTER_LIMIT;
              setOffset(newOff);
              fetchEncounters(newOff);
            }}
            disabled={offset + ENCOUNTER_LIMIT >= total}
            className="px-3 py-1.5 bg-secondary disabled:opacity-40 hover:bg-secondary/80 transition-colors"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timeline visual dot component
// ---------------------------------------------------------------------------

interface TimelineDot {
  agent: string;
  date: string;
  encounters: number;
  deaths: number;
  damage: number;
}

function outcomeColor(deaths: number, encounters: number): string {
  if (deaths > 0) return "#f87171"; // red-400
  if (encounters === 0) return "#6b7280"; // gray-500
  return "#4ade80"; // green-400
}

function dotSize(encounters: number): number {
  // Scale dot radius: 6px base, up to 18px for large encounter counts
  return Math.min(18, 6 + encounters * 2);
}

function formatDateShort(date: string): string {
  // date is "YYYY-MM-DD"
  const d = new Date(date + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function VisualTimeline({ dots, agents }: { dots: TimelineDot[]; agents: string[] }) {
  const [hovered, setHovered] = useState<TimelineDot | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // Dates sorted ascending (oldest left → newest right)
  const dates = Array.from(new Set(dots.map((d) => d.date))).sort();

  // Build lookup: agent -> date -> dot
  const lookup = new Map<string, Map<string, TimelineDot>>();
  for (const dot of dots) {
    if (!lookup.has(dot.agent)) lookup.set(dot.agent, new Map());
    lookup.get(dot.agent)!.set(dot.date, dot);
  }

  if (dates.length === 0 || agents.length === 0) {
    return (
      <div className="text-xs text-muted-foreground py-4 text-center">No timeline data</div>
    );
  }

  const CELL_W = 48;
  const LANE_H = 44;
  const LABEL_W = 100;

  return (
    <div className="relative">
      {/* Tooltip */}
      {hovered && (
        <div
          className="fixed z-50 bg-card border border-border px-2 py-1.5 text-xs font-mono shadow-lg pointer-events-none"
          style={{ left: tooltipPos.x + 12, top: tooltipPos.y - 8 }}
        >
          <div className="text-foreground font-semibold">{hovered.agent}</div>
          <div className="text-muted-foreground">{hovered.date}</div>
          <div>{hovered.encounters} enc · {hovered.deaths > 0 ? <span className="text-red-400">{hovered.deaths} died</span> : "0 deaths"}</div>
          {hovered.damage > 0 && <div className="text-orange-400">{hovered.damage} dmg</div>}
        </div>
      )}

      <div className="overflow-x-auto">
        <div style={{ minWidth: LABEL_W + dates.length * CELL_W }}>
          {/* Header: date labels */}
          <div className="flex items-end gap-0 mb-1">
            <div style={{ width: LABEL_W }} className="shrink-0" />
            {dates.map((date) => (
              <div
                key={date}
                style={{ width: CELL_W }}
                className="shrink-0 text-center text-[10px] font-mono text-muted-foreground truncate px-0.5"
                title={date}
              >
                {formatDateShort(date)}
              </div>
            ))}
          </div>

          {/* Agent swim lanes */}
          {agents.map((agent) => (
            <div
              key={agent}
              className="flex items-center gap-0 border-b border-border/20"
              style={{ height: LANE_H }}
            >
              {/* Lane label */}
              <div
                style={{ width: LABEL_W }}
                className="shrink-0 text-xs font-mono text-muted-foreground pr-3 text-right whitespace-nowrap truncate"
                title={agent}
              >
                {agent.split("-").slice(0, 2).join("-")}
              </div>
              {/* Date cells */}
              {dates.map((date) => {
                const dot = lookup.get(agent)?.get(date);
                if (!dot || dot.encounters === 0) {
                  return (
                    <div key={date} style={{ width: CELL_W }} className="shrink-0 flex items-center justify-center">
                      <div className="rounded-full bg-secondary/40" style={{ width: 6, height: 6 }} />
                    </div>
                  );
                }
                const size = dotSize(dot.encounters);
                const color = outcomeColor(dot.deaths, dot.encounters);
                return (
                  <div key={date} style={{ width: CELL_W }} className="shrink-0 flex items-center justify-center">
                    <div
                      role="img"
                      aria-label={`${agent} ${date}: ${dot.encounters} encounters`}
                      className="rounded-full cursor-pointer transition-transform hover:scale-125"
                      style={{ width: size, height: size, backgroundColor: color, opacity: 0.85 }}
                      onMouseEnter={(e) => {
                        setHovered(dot);
                        setTooltipPos({ x: e.clientX, y: e.clientY });
                      }}
                      onMouseMove={(e) => setTooltipPos({ x: e.clientX, y: e.clientY })}
                      onMouseLeave={() => setHovered(null)}
                    />
                  </div>
                );
              })}
            </div>
          ))}

          {/* Legend */}
          <div className="flex items-center gap-4 mt-3 text-xs font-mono text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 rounded-full bg-green-400 opacity-85" />
              survived
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 rounded-full bg-red-400 opacity-85" />
              death
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-full bg-secondary/40" />
              no activity
            </span>
            <span className="text-muted-foreground/60">dot size = encounter count</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timeline tab
// ---------------------------------------------------------------------------

function TimelineTab({ summary }: { summary: AgentSummary[] }) {
  const [rows, setRows] = useState<TimelineRow[]>([]);
  const [dots, setDots] = useState<TimelineDot[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<TimelineView>("visual");

  useEffect(() => {
    async function fetchTimeline() {
      setLoading(true);
      try {
        const res = await fetch("/api/combat/timeline");
        const data = await res.json();
        const flat = (data.timeline ?? []) as Array<{
          agent: string; date: string; encounters: number; deaths: number; damage: number;
        }>;

        // Build table rows
        const dateMap = new Map<string, TimelineRow>();
        for (const row of flat) {
          if (!dateMap.has(row.date)) {
            dateMap.set(row.date, { date: row.date, agents: {} });
          }
          dateMap.get(row.date)!.agents[row.agent] = { encounters: row.encounters, deaths: row.deaths };
        }
        setRows(Array.from(dateMap.values()));

        // Build visual dots
        setDots(flat.map((row) => ({ ...row })));
      } finally {
        setLoading(false);
      }
    }
    fetchTimeline();
  }, []);

  const agentNames = summary.map((s) => s.agent);

  if (loading) {
    return <div className="text-xs text-muted-foreground py-4 text-center">Loading...</div>;
  }

  return (
    <div className="space-y-4">
      {/* View toggle */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground font-mono">View:</span>
        <div className="flex border border-border rounded overflow-hidden">
          {(["visual", "table"] as TimelineView[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              aria-pressed={view === v}
              className={`px-3 py-1.5 text-xs font-mono capitalize transition-colors ${
                view === v
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-muted-foreground hover:text-foreground"
              }`}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      {view === "visual" ? (
        <VisualTimeline dots={dots} agents={agentNames} />
      ) : (
        /* Table view */
        rows.length === 0 ? (
          <div className="text-xs text-muted-foreground py-4 text-center">No timeline data</div>
        ) : (
          <div className="bg-card border border-border overflow-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-muted-foreground uppercase tracking-wider">
                  <th className="text-left px-3 py-2 font-mono">Date</th>
                  {agentNames.map((a) => (
                    <th key={a} className="text-center px-3 py-2 font-mono">{a}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...rows]
                  .sort((a, b) => (a.date < b.date ? 1 : -1))
                  .map((row) => (
                    <tr key={row.date} className="border-b border-border/50">
                      <td className="px-3 py-1.5 font-mono text-muted-foreground whitespace-nowrap">
                        {row.date}
                      </td>
                      {agentNames.map((agent) => {
                        const cell = row.agents[agent];
                        if (!cell || cell.encounters === 0) {
                          return (
                            <td key={agent} className="px-3 py-1.5 text-center font-mono text-muted-foreground/30">
                              —
                            </td>
                          );
                        }
                        return (
                          <td key={agent} className="px-3 py-1.5 text-center font-mono">
                            <span>{cell.encounters}</span>
                            {cell.deaths > 0 && (
                              <span className="ml-1 text-red-400">({cell.deaths})</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Death Heatmap tab
// ---------------------------------------------------------------------------

/** Returns a Tailwind bg class based on death count for cell color intensity */
function deathCellStyle(deaths: number): React.CSSProperties {
  if (deaths === 0) return {};
  if (deaths === 1) return { backgroundColor: "rgba(234, 179, 8, 0.35)" }; // yellow-500 low opacity
  if (deaths === 2) return { backgroundColor: "rgba(249, 115, 22, 0.45)" }; // orange-500
  return { backgroundColor: `rgba(239, 68, 68, ${Math.min(0.9, 0.5 + deaths * 0.08)})` }; // red-500 scaling
}

/** Sparkline bar component: shows daily death trend for a system */
function DailySparkline({ data }: { data: { date: string; deaths: number }[] }) {
  const sorted = [...data].sort((a, b) => (a.date < b.date ? -1 : 1));
  const maxDeaths = Math.max(1, ...sorted.map((d) => d.deaths));
  return (
    <div className="flex items-end gap-0.5 h-8">
      {sorted.map((d) => {
        const pct = d.deaths / maxDeaths;
        const heightPx = Math.max(2, Math.round(pct * 28));
        return (
          <div
            key={d.date}
            title={`${d.date}: ${d.deaths} death${d.deaths !== 1 ? "s" : ""}`}
            className="w-2 shrink-0 cursor-default"
            style={{
              height: heightPx,
              backgroundColor: d.deaths >= 2 ? "#ef4444" : "#eab308",
              opacity: 0.8,
            }}
          />
        );
      })}
    </div>
  );
}

function DeathHeatmapTab({ summary }: { summary: AgentSummary[] }) {
  const [heatmap, setHeatmap] = useState<HeatmapRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [hours, setHours] = useState(168);
  const [hoveredCell, setHoveredCell] = useState<HeatmapRow | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const hoursOptions = [
    { label: "24h", value: 24 },
    { label: "7d", value: 168 },
    { label: "30d", value: 720 },
    { label: "All", value: 8760 },
  ];

  useEffect(() => {
    setLoading(true);
    fetch(`/api/combat/death-heatmap?hours=${hours}`)
      .then((r) => r.json())
      .then((data) => setHeatmap(data.heatmap ?? []))
      .catch(() => setHeatmap([]))
      .finally(() => setLoading(false));
  }, [hours]);

  if (loading) {
    return <div className="text-xs text-muted-foreground py-4 text-center">Loading...</div>;
  }

  // Collect all agents that appear in the data (not all summary agents)
  const agentsInData = Array.from(new Set(heatmap.map((r) => r.agent))).sort();

  // Build system-level aggregates: total deaths per system across all agents/days
  const systemTotals = new Map<string, number>();
  for (const row of heatmap) {
    const sys = row.system || "(unknown)";
    systemTotals.set(sys, (systemTotals.get(sys) ?? 0) + row.deaths);
  }

  // Sort systems by total deaths desc
  const systems = Array.from(systemTotals.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([sys]) => sys);

  // Build lookup: system -> agent -> aggregated {deaths, encounters, damage}
  const lookup = new Map<string, Map<string, { deaths: number; encounters: number; damage: number }>>();
  // Also build per-system daily data for sparkline
  const dailyBySystem = new Map<string, { date: string; deaths: number }[]>();

  for (const row of heatmap) {
    const sys = row.system || "(unknown)";
    // Per-cell aggregate (system x agent)
    if (!lookup.has(sys)) lookup.set(sys, new Map());
    const agentMap = lookup.get(sys)!;
    const existing = agentMap.get(row.agent) ?? { deaths: 0, encounters: 0, damage: 0 };
    agentMap.set(row.agent, {
      deaths: existing.deaths + row.deaths,
      encounters: existing.encounters + row.encounters,
      damage: existing.damage + row.damage,
    });

    // Per-system daily data (aggregated across agents)
    if (!dailyBySystem.has(sys)) dailyBySystem.set(sys, []);
    const daily = dailyBySystem.get(sys)!;
    const existingDay = daily.find((d) => d.date === row.date);
    if (existingDay) {
      existingDay.deaths += row.deaths;
    } else {
      daily.push({ date: row.date, deaths: row.deaths });
    }
  }

  if (systems.length === 0) {
    return (
      <div className="space-y-4">
        {/* Time range toggle */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground font-mono">Range:</span>
          <div className="flex border border-border rounded overflow-hidden">
            {hoursOptions.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setHours(opt.value)}
                aria-pressed={hours === opt.value}
                className={`px-3 py-1.5 text-xs font-mono transition-colors ${
                  hours === opt.value
                    ? "bg-primary text-primary-foreground"
                    : "bg-secondary text-muted-foreground hover:text-foreground"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <div className="text-xs text-muted-foreground py-8 text-center">No deaths recorded</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Tooltip */}
      {hoveredCell && (
        <div
          className="fixed z-50 bg-card border border-border px-2 py-1.5 text-xs font-mono shadow-lg pointer-events-none"
          style={{ left: tooltipPos.x + 12, top: tooltipPos.y - 8 }}
        >
          <div className="text-foreground font-semibold">{hoveredCell.system}</div>
          <div className="text-muted-foreground">{hoveredCell.agent}</div>
          <div className="text-red-400">{hoveredCell.deaths} death{hoveredCell.deaths !== 1 ? "s" : ""}</div>
          <div className="text-muted-foreground">{hoveredCell.encounters} encounters · {hoveredCell.damage} dmg</div>
        </div>
      )}

      {/* Time range toggle */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground font-mono">Range:</span>
        <div className="flex border border-border rounded overflow-hidden">
          {hoursOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setHours(opt.value)}
              aria-pressed={hours === opt.value}
              className={`px-3 py-1.5 text-xs font-mono transition-colors ${
                hours === opt.value
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-muted-foreground hover:text-foreground"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Color scale legend */}
      <div className="flex items-center gap-3 text-xs font-mono text-muted-foreground">
        <span>Low</span>
        <div
          className="h-3 w-40 rounded-sm border border-border/40 shrink-0"
          style={{ background: "linear-gradient(to right, rgba(234,179,8,0.35), rgba(249,115,22,0.55), rgba(239,68,68,0.9))" }}
        />
        <span>High</span>
        <span className="text-muted-foreground/50 ml-1">— deaths per system</span>
      </div>

      {/* Heatmap grid */}
      <div className="bg-card border border-border overflow-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="border-b border-border text-muted-foreground uppercase tracking-wider">
              <th className="text-left px-3 py-2 font-mono whitespace-nowrap">System</th>
              <th className="text-right px-3 py-2 font-mono whitespace-nowrap">Total</th>
              {agentsInData.map((agent) => (
                <th key={agent} className="text-center px-2 py-2 font-mono whitespace-nowrap" title={agent}>
                  {agent.split("-").slice(0, 2).join("-")}
                </th>
              ))}
              <th className="text-left px-3 py-2 font-mono whitespace-nowrap">Trend</th>
            </tr>
          </thead>
          <tbody>
            {systems.map((system) => {
              const agentMap = lookup.get(system) ?? new Map();
              const totalDeaths = systemTotals.get(system) ?? 0;
              const dailyData = dailyBySystem.get(system) ?? [];
              return (
                <tr key={system ?? "__unknown__"} className="border-b border-border/50 hover:bg-secondary/20 transition-colors">
                  <td className="px-3 py-2 font-mono text-foreground whitespace-nowrap">
                    {system || <span className="text-muted-foreground/50 italic text-xs">unknown</span>}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-red-400 font-semibold">{totalDeaths}</td>
                  {agentsInData.map((agent) => {
                    const cell = agentMap.get(agent);
                    const deaths = cell?.deaths ?? 0;
                    return (
                      <td
                        key={agent}
                        className="px-2 py-2 text-center font-mono cursor-default transition-colors"
                        style={deathCellStyle(deaths)}
                        onMouseEnter={deaths > 0 ? (e) => {
                          setHoveredCell({
                            system,
                            agent,
                            date: "",
                            deaths,
                            encounters: cell?.encounters ?? 0,
                            damage: cell?.damage ?? 0,
                          });
                          setTooltipPos({ x: e.clientX, y: e.clientY });
                        } : undefined}
                        onMouseMove={deaths > 0 ? (e) => setTooltipPos({ x: e.clientX, y: e.clientY }) : undefined}
                        onMouseLeave={deaths > 0 ? () => setHoveredCell(null) : undefined}
                      >
                        {deaths > 0 ? (
                          <span className={deaths >= 2 ? "text-red-300 font-semibold" : "text-yellow-300"}>
                            {deaths}
                          </span>
                        ) : (
                          <span className="text-muted-foreground/20">—</span>
                        )}
                      </td>
                    );
                  })}
                  <td className="px-3 py-2">
                    <DailySparkline data={dailyData} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

interface DateRangeOption {
  label: string;
  hours: number;
}

const DATE_RANGE_OPTIONS: DateRangeOption[] = [
  { label: "1h", hours: 1 },
  { label: "6h", hours: 6 },
  { label: "24h", hours: 24 },
  { label: "7d", hours: 7 * 24 },
  { label: "30d", hours: 30 * 24 },
  { label: "All", hours: 0 },
];

export default function CombatPage() {
  const [summary, setSummary] = useState<AgentSummary[]>([]);
  const [systems, setSystems] = useState<SystemRisk[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [agentFilter, setAgentFilter] = useState("");
  const [selectedHours, setSelectedHours] = useState(0);

  // URL hash persistence for tabs
  useEffect(() => {
    const hash = window.location.hash.replace("#", "") as TabId;
    if (hash === "overview" || hash === "battles" || hash === "timeline" || hash === "heatmap") {
      setActiveTab(hash);
    }
  }, []);

  function handleTabChange(tab: TabId) {
    setActiveTab(tab);
    setAgentFilter("");
    window.location.hash = tab;
  }

  const fetchBase = useCallback(async () => {
    setLoading(true);
    try {
      const params = selectedHours > 0 ? `?hours=${selectedHours}` : '';
      const [sumRes, sysRes] = await Promise.all([
        fetch(`/api/combat/summary${params}`),
        fetch(`/api/combat/systems${params}`),
      ]);
      const [sumData, sysData] = await Promise.all([sumRes.json(), sysRes.json()]);
      setSummary(sumData.summary ?? []);
      setSystems(sysData.systems ?? []);
    } finally {
      setLoading(false);
    }
  }, [selectedHours]);

  useEffect(() => {
    fetchBase();
  }, [fetchBase]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="border-b border-primary/20 pb-4">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-lg font-semibold text-primary uppercase tracking-wider">
            Combat Dashboard
          </h1>
          <button
            onClick={fetchBase}
            disabled={loading}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
        {/* Time range selector (affects Overview stats) */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground uppercase tracking-wider">
            Time Range:
          </span>
          <div className="flex gap-1">
            {DATE_RANGE_OPTIONS.map((option) => (
              <button
                key={option.hours}
                onClick={() => setSelectedHours(option.hours)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  selectedHours === option.hours
                    ? "bg-primary text-primary-foreground"
                    : "bg-secondary text-foreground hover:bg-secondary/80"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Tab bar */}
      <TabBar active={activeTab} onChange={handleTabChange} />

      {/* Tab content */}
      {activeTab === "overview" && (
        <OverviewTab
          summary={summary}
          systems={systems}
          loading={loading}
          agentFilter={agentFilter}
          setAgentFilter={setAgentFilter}
        />
      )}

      {activeTab === "battles" && (
        <BattleLogTab summary={summary} systems={systems} />
      )}

      {activeTab === "timeline" && (
        <TimelineTab summary={summary} />
      )}

      {activeTab === "heatmap" && (
        <DeathHeatmapTab summary={summary} />
      )}
    </div>
  );
}
