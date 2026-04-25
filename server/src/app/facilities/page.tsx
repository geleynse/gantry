"use client";

import { useState, useEffect, useCallback } from "react";
import { Factory, RefreshCw, ChevronDown, AlertCircle, Radar } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiFetch, isApiError } from "@/lib/api";
import { useAgentNames } from "@/hooks/use-agent-names";
import { formatAbsolute, relativeTime } from "@/lib/time";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FacilityRecord {
  id?: string;
  name?: string;
  type?: string;
  level?: number;
  system?: string;
  poi?: string;
  owner?: string;
  status?: string;
  production?: unknown;
  upgrades?: unknown;
  raw?: unknown;
}

interface FacilitiesResponse {
  tab: string;
  agent: string | null;
  facilities: FacilityRecord[];
  cachedAt: string | null;
}

type TabId = "station" | "owned" | "build" | "faction";

const TABS: { id: TabId; label: string }[] = [
  { id: "station", label: "Station" },
  { id: "owned", label: "Owned" },
  { id: "build", label: "Buildable" },
  { id: "faction", label: "Faction" },
];

// `process.env.NODE_ENV` is inlined at build time by Next.js for client
// bundles, so this stays a simple compile-time constant.
const IS_DEV = process.env.NODE_ENV === "development";

// ---------------------------------------------------------------------------
// Error state handling
// ---------------------------------------------------------------------------

interface ErrorState {
  kind: "not_found" | "network" | "unknown";
  message: string;
  rawError: string;
}

function classifyError(err: unknown, selectedAgent: string): ErrorState {
  if (isApiError(err)) {
    if (err.status === 404) {
      return {
        kind: "not_found",
        message: `No facilities data yet for ${selectedAgent}.`,
        rawError: err.body,
      };
    }
    if (err.status >= 500) {
      return {
        kind: "network",
        message: "Facilities service unavailable. Try refresh.",
        rawError: err.body,
      };
    }
    return {
      kind: "unknown",
      message: `API error (${err.status}). Check details below.`,
      rawError: err.body,
    };
  }

  const msg = err instanceof Error ? err.message : String(err);
  return {
    kind: "unknown",
    message: "Failed to load facilities. Check details below.",
    rawError: msg,
  };
}

// ---------------------------------------------------------------------------
// Facility row
// ---------------------------------------------------------------------------

function FacilityRow({ facility }: { facility: FacilityRecord }) {
  const [expanded, setExpanded] = useState(false);
  const name = facility.name ?? facility.id ?? "Unknown Facility";
  const hasExtra = facility.production != null || facility.upgrades != null;

  return (
    <div className="border border-border/50 bg-secondary/20 hover:bg-secondary/40 transition-colors">
      <div className="flex items-center gap-3 px-3 py-2">
        <Factory className="w-3.5 h-3.5 text-primary/60 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-foreground truncate">{name}</span>
            {facility.type && (
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground bg-secondary px-1.5 py-0.5 shrink-0">
                {facility.type}
              </span>
            )}
            {facility.level != null && (
              <span className="text-[10px] text-primary/70 font-mono shrink-0">
                Lv {facility.level}
              </span>
            )}
            {facility.status && (
              <span
                className={cn(
                  "text-[10px] uppercase tracking-wider px-1.5 py-0.5 shrink-0",
                  facility.status === "active"
                    ? "text-success bg-success/10"
                    : "text-muted-foreground bg-secondary"
                )}
              >
                {facility.status}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-0.5 text-[11px] text-muted-foreground">
            {facility.system && <span>{facility.system}</span>}
            {facility.poi && <span className="truncate">{facility.poi}</span>}
            {facility.owner && <span>Owner: {facility.owner}</span>}
          </div>
        </div>
        {hasExtra && (
          <button
            onClick={() => setExpanded((e) => !e)}
            className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            <ChevronDown
              className={cn("w-3.5 h-3.5 transition-transform", expanded && "rotate-180")}
            />
          </button>
        )}
      </div>
      {expanded && hasExtra && (
        <div className="px-3 pb-2 text-[11px] text-muted-foreground font-mono border-t border-border/30 pt-2 space-y-1">
          {facility.production != null && (
            <div>
              <span className="text-foreground/50">Production: </span>
              {JSON.stringify(facility.production)}
            </div>
          )}
          {facility.upgrades != null && (
            <div>
              <span className="text-foreground/50">Upgrades: </span>
              {JSON.stringify(facility.upgrades)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Request scan button — POSTs to /api/facilities-scan, which queues a
// `list_facilities` directive into the fleet_orders queue.
// ---------------------------------------------------------------------------

type ScanState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "ok"; message: string }
  | { status: "error"; message: string };

function RequestScanButton({ agent }: { agent: string }) {
  const [state, setState] = useState<ScanState>({ status: "idle" });

  const handleClick = useCallback(async () => {
    if (state.status === "pending") return;
    setState({ status: "pending" });
    try {
      const res = await apiFetch<{ ok: boolean; orderId: number; target: string | null }>(
        "/facilities-scan",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agent }),
        }
      );
      setState({
        status: "ok",
        message: `Scan order #${res.orderId} queued for ${res.target ?? "fleet"}.`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState({ status: "error", message: msg });
    }
  }, [agent, state.status]);

  const disabled = state.status === "pending" || !agent;

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        onClick={handleClick}
        disabled={disabled}
        className={cn(
          "inline-flex items-center gap-1.5 px-3 py-1.5 text-[10px] uppercase tracking-wider",
          "text-muted-foreground hover:text-foreground border border-border hover:bg-secondary",
          "transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        )}
      >
        <Radar className={cn("w-3.5 h-3.5", state.status === "pending" && "animate-pulse")} />
        {state.status === "pending" ? "Requesting…" : "Request facility scan"}
      </button>
      {state.status === "ok" && (
        <p className="text-[11px] text-success">{state.message}</p>
      )}
      {state.status === "error" && (
        <p className="text-[11px] text-destructive">{state.message}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function FacilitiesPage() {
  const agentNames = useAgentNames();
  const [selectedAgent, setSelectedAgent] = useState<string>("");
  const [activeTab, setActiveTab] = useState<TabId>("station");
  const [data, setData] = useState<FacilitiesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ErrorState | null>(null);

  // Default to first agent once names load
  useEffect(() => {
    if (agentNames.length > 0 && !selectedAgent) {
      setSelectedAgent(agentNames[0]);
    }
  }, [agentNames, selectedAgent]);

  const fetchFacilities = useCallback(async () => {
    if (!selectedAgent) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ agent: selectedAgent, tab: activeTab });
      const res = await apiFetch<FacilitiesResponse>(`/api/facilities?${params}`);
      setData(res);
    } catch (err) {
      setError(classifyError(err, selectedAgent));
    } finally {
      setLoading(false);
    }
  }, [selectedAgent, activeTab]);

  useEffect(() => {
    fetchFacilities();
  }, [fetchFacilities]);

  const facilities = data?.facilities ?? [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-primary/20 pb-4">
        <div>
          <h1 className="text-lg font-semibold text-primary uppercase tracking-wider">
            Facilities
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            Station facilities, owned structures, and buildable options.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Agent selector */}
          {agentNames.length > 0 && (
            <select
              value={selectedAgent}
              onChange={(e) => setSelectedAgent(e.target.value)}
              className="text-[11px] uppercase tracking-wider bg-secondary border border-border text-foreground px-2 py-1.5 focus:outline-none"
            >
              {agentNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={fetchFacilities}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground border border-border hover:bg-secondary transition-colors"
          >
            <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
            Refresh
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-0 border-b border-border">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "px-4 py-2 text-[11px] uppercase tracking-wider transition-colors border-b-2 -mb-px",
              activeTab === tab.id
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Cache timestamp */}
      {data?.cachedAt && (
        <p
          className="text-[10px] text-muted-foreground/50"
          title={formatAbsolute(data.cachedAt)}
        >
          Cached {relativeTime(data.cachedAt)}
        </p>
      )}

      {/* Content */}
      {error && (
        <div className="bg-destructive/10 border border-destructive/30 rounded px-4 py-3 space-y-2">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm text-destructive font-medium">{error.message}</p>
              {error.kind === "not_found" && selectedAgent && (
                <div className="mt-3">
                  <RequestScanButton agent={selectedAgent} />
                </div>
              )}
            </div>
          </div>
          {error.rawError && IS_DEV && (
            <details className="text-[11px] text-muted-foreground/70">
              <summary className="cursor-pointer hover:text-muted-foreground">
                Debug info
              </summary>
              <div className="mt-2 p-2 bg-secondary/30 rounded font-mono text-[10px] overflow-auto max-h-32 whitespace-pre-wrap break-words">
                {error.rawError}
              </div>
            </details>
          )}
        </div>
      )}

      {!loading && !error && facilities.length === 0 && (
        <div className="text-muted-foreground text-sm italic py-12 text-center space-y-4">
          <div>
            {activeTab === "station"
              ? "No station facility data — dock at a station to populate."
              : activeTab === "owned"
              ? "No owned facilities recorded."
              : activeTab === "build"
              ? "No buildable facility types in cache."
              : "No faction facilities recorded."}
          </div>
          {selectedAgent && <RequestScanButton agent={selectedAgent} />}
        </div>
      )}

      {facilities.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/50 mb-2">
            {facilities.length} {facilities.length === 1 ? "facility" : "facilities"}
          </div>
          {facilities.map((facility, idx) => (
            <FacilityRow key={facility.id ?? idx} facility={facility} />
          ))}
        </div>
      )}
    </div>
  );
}
