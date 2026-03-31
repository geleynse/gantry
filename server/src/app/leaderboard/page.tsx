"use client";

import { useState } from "react";
import { Trophy, RefreshCw } from "lucide-react";
import { useLeaderboard } from "@/hooks/use-leaderboard";
import { LeaderboardTable, LeaderboardSkeleton } from "@/components/leaderboard-table";
import { AGENT_NAMES, AGENT_COLORS, relativeTime, cn } from "@/lib/utils";
import type { LeaderboardEntry, LeaderboardCategory, LeaderboardTimeRange } from "@/hooks/use-leaderboard";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MainTab = "players" | "factions" | "exchanges";

interface StatColumn {
  key: string;
  label: string;
}

interface TabGroup {
  id: string;
  label: string;
  columns: StatColumn[];
}

// ---------------------------------------------------------------------------
// Tab config — keys match upstream API stat categories
// ---------------------------------------------------------------------------

const PLAYER_TABS: TabGroup[] = [
  {
    id: "economy",
    label: "Economy",
    columns: [
      { key: "total_wealth", label: "Total Wealth" },
      { key: "credits_earned", label: "Credits Earned" },
      { key: "credits_spent", label: "Credits Spent" },
    ],
  },
  {
    id: "combat",
    label: "Combat",
    columns: [
      { key: "ships_destroyed", label: "Ships Destroyed" },
      { key: "ships_lost", label: "Ships Lost" },
      { key: "pirates_destroyed", label: "Pirates Destroyed" },
    ],
  },
  {
    id: "industry",
    label: "Industry",
    columns: [
      { key: "items_crafted", label: "Items Crafted" },
      { key: "trades_completed", label: "Trades Completed" },
      { key: "systems_explored", label: "Systems Explored" },
    ],
  },
  {
    id: "assets",
    label: "Assets",
    columns: [
      { key: "ship_value", label: "Ship Value" },
      { key: "facility_investment", label: "Facility Investment" },
      { key: "storage_value", label: "Storage Value" },
    ],
  },
];

const FACTION_TABS: TabGroup[] = [
  {
    id: "faction_stats",
    label: "Stats",
    columns: [
      { key: "total_wealth", label: "Total Wealth" },
      { key: "member_count", label: "Members" },
      { key: "facility_investment", label: "Facility Investment" },
      { key: "storage_value", label: "Storage Value" },
    ],
  },
];

const EXCHANGE_TABS: TabGroup[] = [
  {
    id: "exchange_stats",
    label: "Stats",
    columns: [
      { key: "items_listed", label: "Items Listed" },
      { key: "active_orders", label: "Active Orders" },
      { key: "sell_order_value", label: "Sell Order Value" },
      { key: "escrow_value", label: "Escrow Value" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------



/** Get the entries array for a given stat key from a category */
function getEntries(category: LeaderboardCategory | undefined, statKey: string): LeaderboardEntry[] {
  return category?.[statKey] ?? [];
}

// ---------------------------------------------------------------------------
// Fleet summary panel — finds best rank per agent across all player stats
// ---------------------------------------------------------------------------

interface AgentBestRank {
  agent: string;
  color: string;
  category: string;
  statLabel: string;
  rank: number;
}

function FleetSummaryPanel({ players }: { players: LeaderboardCategory }) {
  const agentBests: AgentBestRank[] = [];

  for (const agentSlug of AGENT_NAMES as readonly string[]) {
    const color = AGENT_COLORS[agentSlug] ?? "#888";
    const displayName = agentSlug
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");

    let bestRank: number | null = null;
    let bestCategory = "";
    let bestStatLabel = "";

    for (const tabGroup of PLAYER_TABS) {
      for (const col of tabGroup.columns) {
        const entries = players[col.key] ?? [];
        const entry = entries.find(
          (e) => String(e.username ?? "").toLowerCase() === displayName.toLowerCase()
        );
        if (entry) {
          const rank = entry.rank;
          if (bestRank === null || rank < bestRank) {
            bestRank = rank;
            bestCategory = tabGroup.label;
            bestStatLabel = col.label;
          }
        }
      }
    }

    if (bestRank !== null) {
      agentBests.push({ agent: displayName, color, category: bestCategory, statLabel: bestStatLabel, rank: bestRank });
    }
  }

  if (agentBests.length === 0) return null;

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
      {agentBests.map(({ agent, color, category, statLabel, rank }) => (
        <div
          key={agent}
          className="bg-card border border-border p-3 space-y-1"
          style={{ borderLeftColor: color, borderLeftWidth: 3 }}
        >
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider truncate">
            {agent}
          </div>
          <div className="text-lg font-bold font-mono" style={{ color }}>
            #{rank}
          </div>
          <div className="text-[10px] text-muted-foreground truncate">
            {category} · {statLabel}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main tab bar
// ---------------------------------------------------------------------------

function MainTabBar({
  active,
  onChange,
}: {
  active: MainTab;
  onChange: (t: MainTab) => void;
}) {
  const tabs: { id: MainTab; label: string }[] = [
    { id: "players", label: "Players" },
    { id: "factions", label: "Factions" },
    { id: "exchanges", label: "Exchanges" },
  ];
  return (
    <div className="flex gap-0 border-b border-border">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`px-4 py-2 text-xs uppercase tracking-wider transition-colors ${
            active === t.id
              ? "border-b-2 border-primary text-primary"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat selector — category tabs + stat buttons
// ---------------------------------------------------------------------------

function StatSelector({
  tabs,
  activeTab,
  statKey,
  onTabChange,
  onStatChange,
}: {
  tabs: TabGroup[];
  activeTab: string;
  statKey: string;
  onTabChange: (id: string) => void;
  onStatChange: (key: string) => void;
}) {
  const activeGroup = tabs.find((t) => t.id === activeTab) ?? tabs[0];

  return (
    <div className="space-y-2">
      {tabs.length > 1 && (
        <div className="flex gap-0 border-b border-border/50">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => onTabChange(t.id)}
              className={`px-3 py-1.5 text-xs uppercase tracking-wider transition-colors ${
                activeTab === t.id
                  ? "border-b-2 border-primary/60 text-primary/80"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      <div className="flex gap-2 flex-wrap">
        {activeGroup.columns.map((col) => (
          <button
            key={col.key}
            onClick={() => onStatChange(col.key)}
            className={`px-2 py-1 text-xs rounded transition-colors ${
              statKey === col.key
                ? "bg-primary/10 text-primary border border-primary/30"
                : "text-muted-foreground hover:text-foreground border border-transparent"
            }`}
          >
            {col.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const TIME_RANGES: { id: LeaderboardTimeRange; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "week", label: "This Week" },
  { id: "all", label: "All Time" },
];

export default function LeaderboardPage() {
  const [mainTab, setMainTab] = useState<MainTab>("players");
  const [playerTab, setPlayerTab] = useState("economy");
  const [playerStat, setPlayerStat] = useState("total_wealth");
  const [factionStat, setFactionStat] = useState("total_wealth");
  const [exchangeStat, setExchangeStat] = useState("items_listed");
  const [timeRange, setTimeRange] = useState<LeaderboardTimeRange>("all");
  const { data, fetchedAt, loading, error, refresh } = useLeaderboard(undefined, timeRange);

  const allTabs = PLAYER_TABS.flatMap((t) => t.columns);
  const statLabel = allTabs.find((c) => c.key === playerStat)?.label ?? playerStat;
  const factionLabel = FACTION_TABS.flatMap((t) => t.columns).find((c) => c.key === factionStat)?.label ?? factionStat;
  const exchangeLabel = EXCHANGE_TABS.flatMap((t) => t.columns).find((c) => c.key === exchangeStat)?.label ?? exchangeStat;

  const playerEntries = getEntries(data?.players, playerStat);
  const factionEntries = getEntries(data?.factions, factionStat);
  const exchangeEntries = getEntries(data?.exchanges, exchangeStat);

  function handlePlayerTabChange(tabId: string) {
    setPlayerTab(tabId);
    const group = PLAYER_TABS.find((t) => t.id === tabId)!;
    setPlayerStat(group.columns[0].key);
  }

  const hasPlayers = data?.players != null && Object.keys(data.players).length > 0;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Trophy className="w-5 h-5 text-primary" />
          <h1 className="text-lg font-semibold">Leaderboard</h1>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {/* Time range toggles */}
          <div className="flex items-center gap-0 border border-border rounded-sm overflow-hidden">
            {TIME_RANGES.map((tr) => (
              <button
                key={tr.id}
                onClick={() => setTimeRange(tr.id)}
                className={cn(
                  "px-3 py-1 text-[11px] uppercase tracking-wider font-mono transition-colors",
                  timeRange === tr.id
                    ? "bg-primary/15 text-primary border-r border-primary/20 last:border-r-0"
                    : "text-muted-foreground hover:text-foreground border-r border-border last:border-r-0"
                )}
              >
                {tr.label}
              </button>
            ))}
          </div>

          {fetchedAt && (
            <span className="text-xs text-muted-foreground">
              Updated {relativeTime(fetchedAt)}
            </span>
          )}
          <button
            onClick={refresh}
            disabled={loading}
            className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:text-foreground border border-border hover:border-border/80 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-destructive/10 border border-destructive/30 text-destructive text-sm px-4 py-3">
          {error}
        </div>
      )}

      {/* Fleet summary */}
      {hasPlayers && <FleetSummaryPanel players={data!.players!} />}

      {/* Main tabs */}
      <div className="space-y-4">
        <MainTabBar active={mainTab} onChange={setMainTab} />

        {mainTab === "players" && (
          <div className="space-y-4">
            <StatSelector
              tabs={PLAYER_TABS}
              activeTab={playerTab}
              statKey={playerStat}
              onTabChange={handlePlayerTabChange}
              onStatChange={setPlayerStat}
            />
            {loading && playerEntries.length === 0 ? (
              <LeaderboardSkeleton />
            ) : (
              <LeaderboardTable
                entries={playerEntries}
                statKey="value"
                statLabel={statLabel}
                loading={loading}
              />
            )}
          </div>
        )}

        {mainTab === "factions" && (
          <div className="space-y-4">
            <StatSelector
              tabs={FACTION_TABS}
              activeTab="faction_stats"
              statKey={factionStat}
              onTabChange={() => {}}
              onStatChange={setFactionStat}
            />
            {loading && factionEntries.length === 0 ? (
              <LeaderboardSkeleton />
            ) : (
              <LeaderboardTable
                entries={factionEntries}
                statKey="value"
                statLabel={factionLabel}
                nameKey="name"
                loading={loading}
              />
            )}
          </div>
        )}

        {mainTab === "exchanges" && (
          <div className="space-y-4">
            <StatSelector
              tabs={EXCHANGE_TABS}
              activeTab="exchange_stats"
              statKey={exchangeStat}
              onTabChange={() => {}}
              onStatChange={setExchangeStat}
            />
            {loading && exchangeEntries.length === 0 ? (
              <LeaderboardSkeleton />
            ) : (
              <LeaderboardTable
                entries={exchangeEntries}
                statKey="value"
                statLabel={exchangeLabel}
                loading={loading}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
