"use client";

import { useCallback, useEffect, useState } from "react";
import { GalaxyMap } from "@/components/galaxy-map";
import type { MapData, MapSystem, AgentPositions } from "@/components/galaxy-map";
import { SystemView } from "@/components/system-view";
import { apiFetch } from "@/lib/api";
import { cn, AGENT_COLORS } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SelectedSystemInfo {
  system: MapSystem;
  agentsHere: string[];
  connectedNames: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function empireLabel(empire?: string): string {
  if (!empire) return "Neutral";
  return empire.charAt(0).toUpperCase() + empire.slice(1);
}

const EMPIRE_COLORS_HEX: Record<string, string> = {
  solarian: "#5e81ac",
  crimson: "#bf616a",
  nebula: "#b48ead",
  neutral: "#4c566a",
};

function EmpireDot({ empire }: { empire?: string }) {
  const color = EMPIRE_COLORS_HEX[empire ?? "neutral"] ?? EMPIRE_COLORS_HEX.neutral;
  return (
    <span
      className="inline-block w-2 h-2 rounded-full shrink-0"
      style={{ background: color }}
    />
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type ViewMode = "galaxy" | "system";

export default function MapPage() {
  const [mapData, setMapData] = useState<MapData | null>(null);
  const [positions, setPositions] = useState<AgentPositions>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("galaxy");
  const [mapError, setMapError] = useState<string | null>(null);
  const [mapHeight, setMapHeight] = useState(600);
  const [knownPois, setKnownPois] = useState<Record<string, string[]>>({});

  // Calculate viewport-aware map height after mount
  useEffect(() => {
    function updateHeight() {
      // total viewport minus: topbar (48px), page padding (24px), legend (~56px), heading (~36px), gaps (~16px)
      setMapHeight(Math.max(400, window.innerHeight - 48 - 24 - 56 - 36 - 16));
    }
    updateHeight();
    window.addEventListener("resize", updateHeight);
    return () => window.removeEventListener("resize", updateHeight);
  }, []);

  // Fetch map data for side panel lookups
  useEffect(() => {
    apiFetch<MapData>("/map")
      .then((d) => setMapData(d))
      .catch((err) =>
        setMapError(err instanceof Error ? err.message : "Failed to load map")
      );
  }, []);

  // Poll agent positions for side panel
  useEffect(() => {
    const fetchPositions = async () => {
      try {
        const data = await apiFetch<AgentPositions>("/map/positions");
        setPositions(data);
      } catch {
        // Non-fatal
      }
    };
    fetchPositions();
    const id = setInterval(fetchPositions, 15_000);
    return () => clearInterval(id);
  }, []);

  const handleSystemClick = useCallback((systemId: string) => {
    setSelectedId((prev) => {
      if (prev === systemId) {
        // Click on already-selected system → enter system view
        setViewMode("system");
        apiFetch<Record<string, string[]>>(`/analytics-db/system-pois?system=${systemId}`)
          .then(setKnownPois)
          .catch(() => {});
        return prev;
      }
      return systemId;
    });
  }, []);

  const handleViewSystem = useCallback(() => {
    if (selectedId) {
      setViewMode("system");
      apiFetch<Record<string, string[]>>(`/analytics-db/system-pois?system=${selectedId}`)
        .then(setKnownPois)
        .catch(() => {});
    }
  }, [selectedId]);

  const handleBack = useCallback(() => {
    setViewMode("galaxy");
  }, []);

  // Derive selected system info
  const selectedInfo: SelectedSystemInfo | null = (() => {
    if (!selectedId || !mapData) return null;
    const system = mapData.systems.find((s) => s.id === selectedId);
    if (!system) return null;

    const agentsHere = Object.entries(positions)
      .filter(([, pos]) => pos.system === selectedId)
      .map(([agent]) => agent);

    const systemById = Object.fromEntries(mapData.systems.map((s) => [s.id, s]));
    const connectedNames = system.connections
      .map((id) => systemById[id]?.name ?? id)
      .sort((a, b) => a.localeCompare(b));

    return { system, agentsHere, connectedNames };
  })();

  // Build a systemNames lookup for the SystemView component
  const systemNames: Record<string, string> = mapData
    ? Object.fromEntries(mapData.systems.map((s) => [s.id, s.name]))
    : {};

  // Reusable system detail panel content
  function SystemDetailPanel({ info }: { info: SelectedSystemInfo }) {
    return (
      <>
        {/* System header */}
        <div className="space-y-1 border-b border-border pb-3">
          <div className="text-base font-semibold text-foreground">
            {info.system.name}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <EmpireDot empire={info.system.empire} />
            <span>{empireLabel(info.system.empire)}</span>
            <span className="opacity-40">·</span>
            <span className="font-mono text-[10px]">{info.system.id}</span>
          </div>
        </div>

        {/* Stats */}
        <div className="flex gap-6 text-xs">
          <div className="space-y-0.5">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Connections
            </div>
            <div className="font-mono text-foreground">
              {info.system.connections.length}
            </div>
          </div>
          <div className="space-y-0.5">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Agents Here
            </div>
            <div className="font-mono text-foreground">
              {info.agentsHere.length}
            </div>
          </div>
        </div>

        {/* Agents in system */}
        {info.agentsHere.length > 0 && (
          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Agents in System
            </div>
            <ul className="space-y-1">
              {info.agentsHere.map((agent) => {
                const pos = positions[agent];
                return (
                  <li key={agent} className="flex items-center gap-2 text-xs">
                    <span
                      className="inline-block w-2 h-2 rounded-full shrink-0"
                      style={{ background: AGENT_COLORS[agent] ?? "#d8dee9" }}
                    />
                    <span className="text-foreground">{agent}</span>
                    {pos?.poi && (
                      <span className="text-muted-foreground text-[10px] truncate">
                        @ {pos.poi}
                      </span>
                    )}
                    {pos?.docked && (
                      <span className="text-success text-[10px]">[docked]</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* Connected systems */}
        <div className="space-y-1 flex-1 min-h-0">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Connected Systems ({info.connectedNames.length})
          </div>
          <ul className="space-y-0.5 text-xs text-muted-foreground max-h-48 overflow-y-auto">
            {info.connectedNames.map((name) => (
              <li key={name} className="font-mono truncate">
                {name}
              </li>
            ))}
          </ul>
        </div>
      </>
    );
  }

  // System view mode: show full-width SVG drill-down
  if (viewMode === "system" && selectedInfo) {
    return (
      <div className="flex flex-col md:flex-row gap-4" style={{ minHeight: mapHeight + 56 + 36 + 16 }}>
        {/* System SVG column */}
        <div
          className="flex flex-col flex-1 min-w-0 border border-border bg-card p-4"
          style={{ height: mapHeight + 56 + 36 + 16 }}
        >
          <SystemView
            system={selectedInfo.system}
            systemNames={systemNames}
            agentPositions={positions}
            onBack={handleBack}
            knownPois={knownPois}
            onSystemNavigate={(id) => {
              setSelectedId(id);
              apiFetch<Record<string, string[]>>(`/analytics-db/system-pois?system=${id}`)
                .then(setKnownPois)
                .catch(() => {});
            }}
          />
        </div>

        {/* Side panel */}
        <aside className="w-full md:w-[300px] shrink-0 flex flex-col gap-3 md:border-l border-border md:pl-4 overflow-y-auto">
          <SystemDetailPanel info={selectedInfo} />
        </aside>
      </div>
    );
  }

  return (
    <div className="flex flex-col md:flex-row gap-4" style={{ minHeight: mapHeight + 56 + 36 + 16 }}>
      {/* Map + legend column */}
      <div className="flex flex-col flex-1 min-w-0 gap-3">
        {/* Page heading */}
        <div className="flex items-center gap-4 shrink-0">
          <h1 className="text-lg font-semibold text-primary uppercase tracking-wider">
            Galaxy Map
          </h1>
          {mapData && (
            <span className="text-xs text-muted-foreground font-mono">
              {mapData.systems.length} systems
            </span>
          )}
          {mapError && (
            <span className="text-xs text-error">{mapError}</span>
          )}
        </div>

        {/* Map canvas */}
        <GalaxyMap
          onSystemClick={handleSystemClick}
          highlightSystem={selectedId}
          height={mapHeight}
        />

        {/* Agent legend */}
        <div className="shrink-0 flex flex-wrap items-center gap-3 md:gap-4 text-[11px] text-muted-foreground border-t border-border pt-2">
          <span className="uppercase tracking-wider text-[10px] text-muted-foreground">
            Agents
          </span>
          {Object.entries(AGENT_COLORS).map(([agent, color]) => {
            const pos = positions[agent];
            // pos.system is the system name from current_system
            const systemDisplayName = pos?.system
              ? (systemNames[pos.system] ?? pos.system)
              : null;
            return (
              <span key={agent} className="flex items-center gap-1.5">
                <span
                  className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ background: color, opacity: pos ? 1 : 0.4 }}
                />
                <span className={cn(pos ? "text-foreground" : "text-muted-foreground")}>
                  {agent}
                </span>
                {systemDisplayName && (
                  <span className="text-muted-foreground font-mono hidden sm:inline">{systemDisplayName}</span>
                )}
                {!pos && (
                  <span className="text-muted-foreground/40 text-[9px] hidden sm:inline">offline</span>
                )}
              </span>
            );
          })}
        </div>
      </div>

      {/* Side panel — below map on mobile when selected, hidden when nothing selected */}
      {selectedInfo && (
        <aside className="w-full md:w-[300px] shrink-0 flex flex-col gap-3 border-t md:border-t-0 md:border-l border-border pt-4 md:pt-0 md:pl-4 overflow-y-auto">
          <SystemDetailPanel info={selectedInfo} />
          <button
            className="w-full border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-secondary py-1.5 transition-colors uppercase tracking-wider"
            onClick={handleViewSystem}
          >
            View System
          </button>
        </aside>
      )}
      {!selectedInfo && (
        <aside className="hidden md:flex w-[300px] shrink-0 flex-col gap-3 border-l border-border pl-4 overflow-y-auto">
          <div className="flex items-start justify-center pt-12 text-xs text-muted-foreground text-center">
            <span>Click a system to view details</span>
          </div>
        </aside>
      )}
    </div>
  );
}
