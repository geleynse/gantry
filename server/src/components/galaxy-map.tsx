"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { apiFetch } from "@/lib/api";
import {
  buildDangerScores,
  normalizeEmpire,
  type CombatSystemStat,
} from "./galaxy-map-utils";
import {
  drawNode,
  renderTerritoryShading,
  renderTrails,
  renderFogOfWar,
  renderWormholeLink,
  renderRoutePath,
} from "./galaxy-map-renderer";
import { OverlayBar, EmpireLegend, type OverlayToggles } from "./galaxy-map-overlays";
import { MapTooltip } from "./galaxy-map-tooltip";
import { SystemPopup } from "./SystemPopup";
import type { GraphNode, SystemPopupData, WormholePair } from "./galaxy-map-types";

// Re-export for convenience
export { EMPIRE_COLORS, buildDangerScores } from "./galaxy-map-utils";

// Dynamic import required — react-force-graph-2d uses canvas APIs that do not
// exist during Next.js static generation.
const ForceGraph2D = dynamic(
  () => import("react-force-graph-2d").then((m) => m.default),
  { ssr: false }
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MapSystem {
  id: string;
  name: string;
  x: number;
  y: number;
  empire?: string;
  connections: string[];
}

export interface MapData {
  systems: MapSystem[];
}

export type AgentPositions = Record<
  string,
  { system: string; poi: string | null; docked: boolean; shipClass?: string | null }
>;

interface GraphNodeInternal extends GraphNode {
  fx: number;
  fy: number;
}

interface GraphLink {
  source: string;
  target: string;
}

interface GraphData {
  nodes: GraphNodeInternal[];
  links: GraphLink[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Inlined from config/env.ts to avoid importing node:fs/node:path into client bundle
const POSITION_POLL_INTERVAL_MS = 15000;
const DANGER_POLL_INTERVAL_MS = 300000;

const LINK_COLOR = "rgba(136, 147, 167, 0.35)";

// ---------------------------------------------------------------------------
// Data conversion
// ---------------------------------------------------------------------------

function buildGraphData(
  systems: MapSystem[],
  positions: AgentPositions
): GraphData {
  const nameToId: Record<string, string> = {};
  for (const s of systems) {
    nameToId[s.name.toLowerCase()] = s.id;
  }

  const agentsBySystem: Record<string, string[]> = {};
  for (const [agent, pos] of Object.entries(positions)) {
    const systemKey =
      systems.some((s) => s.id === pos.system)
        ? pos.system
        : (nameToId[pos.system.toLowerCase()] ?? pos.system);
    if (!agentsBySystem[systemKey]) agentsBySystem[systemKey] = [];
    agentsBySystem[systemKey].push(agent);
  }

  const nodes: GraphNodeInternal[] = systems.map((s) => ({
    id: s.id,
    name: s.name,
    x: s.x,
    y: s.y,
    fx: s.x,
    fy: s.y,
    empire: normalizeEmpire(s.empire),
    hasAgents: (agentsBySystem[s.id]?.length ?? 0) > 0,
    agents: agentsBySystem[s.id] ?? [],
  }));

  const seen = new Set<string>();
  const links: GraphLink[] = [];

  for (const s of systems) {
    for (const conn of s.connections) {
      const key = s.id < conn ? `${s.id}::${conn}` : `${conn}::${s.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        links.push({ source: s.id, target: conn });
      }
    }
  }

  return { nodes, links };
}

// ---------------------------------------------------------------------------
// BFS shortest path (Task 5)
// ---------------------------------------------------------------------------

function bfsPath(
  startId: string,
  endId: string,
  links: GraphLink[]
): string[] {
  if (startId === endId) return [startId];

  // Build adjacency list — links may already be resolved objects by ForceGraph
  const adj: Record<string, string[]> = {};
  for (const link of links) {
    const s = typeof link.source === "object" ? ((link.source as { id?: string }).id ?? String(link.source)) : String(link.source);
    const t = typeof link.target === "object" ? ((link.target as { id?: string }).id ?? String(link.target)) : String(link.target);
    (adj[s] ??= []).push(t);
    (adj[t] ??= []).push(s);
  }

  const visited = new Set<string>([startId]);
  const queue: Array<{ id: string; path: string[] }> = [{ id: startId, path: [startId] }];

  while (queue.length > 0) {
    const entry = queue.shift()!;
    for (const neighbor of (adj[entry.id] ?? [])) {
      if (visited.has(neighbor)) continue;
      const newPath = [...entry.path, neighbor];
      if (neighbor === endId) return newPath;
      visited.add(neighbor);
      queue.push({ id: neighbor, path: newPath });
    }
  }

  return []; // No path found
}

// ---------------------------------------------------------------------------
// Minimap (Task 4)
// ---------------------------------------------------------------------------

interface MinimapProps {
  nodes: GraphNodeInternal[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  graphRef: React.RefObject<any>;
  containerWidth: number;
  containerHeight: number;
}

const MINIMAP_EMPIRE_COLORS: Record<string, string> = {
  solarian: "#d4a017",
  voidborn: "#7c3aed",
  crimson: "#dc2626",
  nebula: "#0d9488",
  outerrim: "#ea580c",
  piratestronghold: "#7f1d1d",
  neutral: "#4b5563",
};

function Minimap({ nodes, graphRef, containerWidth, containerHeight }: MinimapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let animId: number;

    function draw() {
      const canvas = canvasRef.current;
      if (!canvas || !graphRef.current || nodes.length === 0) {
        animId = requestAnimationFrame(draw);
        return;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) { animId = requestAnimationFrame(draw); return; }

      const W = canvas.width;
      const H = canvas.height;

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of nodes) {
        if (n.fx < minX) minX = n.fx;
        if (n.fy < minY) minY = n.fy;
        if (n.fx > maxX) maxX = n.fx;
        if (n.fy > maxY) maxY = n.fy;
      }
      const graphW = maxX - minX || 1;
      const graphH = maxY - minY || 1;

      const pad = 6;
      const scaleX = (W - pad * 2) / graphW;
      const scaleY = (H - pad * 2) / graphH;
      function toMini(gx: number, gy: number) {
        return { x: pad + (gx - minX) * scaleX, y: pad + (gy - minY) * scaleY };
      }

      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = "rgba(14, 17, 26, 0.85)";
      ctx.fillRect(0, 0, W, H);

      for (const n of nodes) {
        const { x, y } = toMini(n.fx, n.fy);
        ctx.beginPath();
        ctx.arc(x, y, n.hasAgents ? 2.5 : 1.5, 0, 2 * Math.PI);
        ctx.fillStyle = MINIMAP_EMPIRE_COLORS[n.empire] ?? MINIMAP_EMPIRE_COLORS.neutral;
        ctx.fill();
      }

      // Draw viewport rectangle
      try {
        const tl = graphRef.current.screen2GraphCoords(0, 0);
        const br = graphRef.current.screen2GraphCoords(containerWidth, containerHeight);
        const vTL = toMini(tl.x, tl.y);
        const vBR = toMini(br.x, br.y);
        const rx = Math.min(vTL.x, vBR.x);
        const ry = Math.min(vTL.y, vBR.y);
        const rw = Math.abs(vBR.x - vTL.x);
        const rh = Math.abs(vBR.y - vTL.y);
        ctx.strokeStyle = "rgba(255,255,255,0.65)";
        ctx.lineWidth = 1;
        ctx.strokeRect(rx, ry, rw, rh);
      } catch {
        // graph not initialized yet
      }

      ctx.strokeStyle = "rgba(255,255,255,0.15)";
      ctx.lineWidth = 1;
      ctx.strokeRect(0, 0, W, H);

      animId = requestAnimationFrame(draw);
    }

    animId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animId);
  }, [nodes, graphRef, containerWidth, containerHeight]);

  return (
    <canvas
      ref={canvasRef}
      width={140}
      height={100}
      className="absolute bottom-2 right-2 z-10 pointer-events-none"
    />
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface GalaxyMapProps {
  onSystemClick?: (systemId: string) => void;
  highlightSystem?: string | null;
  highlightAgent?: string | null;
  height?: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function GalaxyMap({
  onSystemClick,
  highlightSystem = null,
  highlightAgent = null,
  height = 600,
}: GalaxyMapProps) {
  const [mapData, setMapData] = useState<MapData | null>(null);
  const [positions, setPositions] = useState<AgentPositions>({});
  const [mapError, setMapError] = useState<string | null>(null);
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  });
  const [dangerScores, setDangerScores] = useState<Record<string, number>>({});
  const [agentTrails, setAgentTrails] = useState<Record<string, string[]>>({});
  const [exploredSystems, setExploredSystems] = useState<Set<string>>(new Set());
  const [wormholes, setWormholes] = useState<WormholePair[]>([]);
  const [popupData, setPopupData] = useState<SystemPopupData | null>(null);
  const [popupScreenPos, setPopupScreenPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [overlays, setOverlays] = useState<OverlayToggles>({
    empireColors: true,
    dangerHeatmap: true,
    agentTrails: false,
    territoryShading: true,
    fogOfWar: false,
    wormholes: false,
  });

  // --- Search state (Task 1) ---
  const [searchQuery, setSearchQuery] = useState("");
  const [searchNoMatch, setSearchNoMatch] = useState(false);
  const [searchDropdown, setSearchDropdown] = useState<Array<{ id: string; name: string }>>([]);
  const [internalHighlight, setInternalHighlight] = useState<string | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noMatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- Route planner state (Task 5) ---
  const [routePlanActive, setRoutePlanActive] = useState(false);
  const [routeStart, setRouteStart] = useState<string | null>(null);
  const [routeEnd, setRouteEnd] = useState<string | null>(null);
  const [routePath, setRoutePath] = useState<string[]>([]);

  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const graphRef = useRef<any>(undefined);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dangerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch explored systems once on mount (for fog-of-war)
  useEffect(() => {
    apiFetch<string[]>("/map/explored-systems")
      .then((data) => setExploredSystems(new Set(data)))
      .catch(() => {});
  }, []);

  // Fetch wormholes once on mount
  useEffect(() => {
    apiFetch<WormholePair[]>("/map/wormholes")
      .then((data) => setWormholes(data))
      .catch(() => {});
  }, []);

  // Fetch map topology once on mount
  useEffect(() => {
    apiFetch<MapData>("/map")
      .then((data) => setMapData(data))
      .catch((err) => {
        setMapError(
          err instanceof Error ? err.message : "Failed to load map"
        );
      });
  }, []);

  // Fetch and poll agent positions
  const fetchPositions = useCallback(async () => {
    try {
      const data = await apiFetch<AgentPositions>("/map/positions");
      setPositions(data);
    } catch {
      // Non-fatal; map renders without agent markers
    }
  }, []);

  useEffect(() => {
    fetchPositions();
    intervalRef.current = setInterval(fetchPositions, POSITION_POLL_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchPositions]);

  // Fetch agent trails alongside positions
  const fetchTrails = useCallback(async () => {
    try {
      const data = await apiFetch<Array<{ agent: string; systems: string[] }>>("/analytics-db/agent-trails");
      const byAgent: Record<string, string[]> = {};
      for (const { agent, systems } of data) {
        byAgent[agent] = systems;
      }
      setAgentTrails(byAgent);
    } catch {
      // Non-fatal
    }
  }, []);

  useEffect(() => {
    fetchTrails();
    const ref = setInterval(fetchTrails, POSITION_POLL_INTERVAL_MS);
    return () => clearInterval(ref);
  }, [fetchTrails]);

  // Fetch and poll danger scores from combat API
  const fetchDanger = useCallback(async () => {
    try {
      const data = await apiFetch<{ systems: CombatSystemStat[] }>("/combat/systems");
      setDangerScores(buildDangerScores(data.systems));
    } catch {
      // Non-fatal; danger overlay stays empty
    }
  }, []);

  useEffect(() => {
    fetchDanger();
    dangerIntervalRef.current = setInterval(fetchDanger, DANGER_POLL_INTERVAL_MS);
    return () => {
      if (dangerIntervalRef.current) clearInterval(dangerIntervalRef.current);
    };
  }, [fetchDanger]);

  const graphData = useMemo(
    () => mapData ? buildGraphData(mapData.systems, positions) : null,
    [mapData, positions]
  );

  // Build node lookup by id AND name for trail rendering
  // (trails use system names like "Mimosa", graph uses IDs like "mimosa")
  const nodeById = useMemo(() => {
    const map: Record<string, GraphNode> = {};
    if (graphData) {
      for (const n of graphData.nodes) {
        map[n.id] = n;
        if (n.name) map[n.name] = n;
      }
    }
    return map;
  }, [graphData]);

  // Derive the set of empires present in the map for the legend
  const presentEmpires = useMemo(
    () => mapData ? Array.from(new Set(mapData.systems.map((s) => normalizeEmpire(s.empire)))).sort() : [],
    [mapData]
  );

  // Build wormhole lookup set for link rendering
  const wormholeSet = useMemo(() => {
    const s = new Set<string>();
    for (const w of wormholes) {
      const key = w.systemA < w.systemB ? `${w.systemA}:${w.systemB}` : `${w.systemB}:${w.systemA}`;
      s.add(key);
    }
    return s;
  }, [wormholes]);

  // ---------------------------------------------------------------------------
  // Search (Task 1)
  // ---------------------------------------------------------------------------

  const effectiveHighlight = internalHighlight ?? highlightSystem;

  const navigateToSystem = useCallback((sysId: string) => {
    const node = graphData?.nodes.find((n) => n.id === sysId);
    if (!node || !graphRef.current) return;
    setInternalHighlight(sysId);
    setSearchDropdown([]);
    graphRef.current.centerAt(node.fx, node.fy, 500);
    graphRef.current.zoom(3, 500);
  }, [graphData]);

  const performSearch = useCallback((query: string) => {
    if (!graphData || !query.trim()) { setSearchDropdown([]); return; }
    const q = query.trim().toLowerCase();
    const matches = graphData.nodes
      .filter((n) => n.name.toLowerCase().includes(q))
      .slice(0, 5)
      .map((n) => ({ id: n.id, name: n.name }));

    if (matches.length === 0) {
      setSearchDropdown([]);
      setSearchNoMatch(true);
      if (noMatchTimerRef.current) clearTimeout(noMatchTimerRef.current);
      noMatchTimerRef.current = setTimeout(() => setSearchNoMatch(false), 1500);
      return;
    }
    if (matches.length === 1) {
      navigateToSystem(matches[0].id);
      setSearchDropdown([]);
    } else {
      setSearchDropdown(matches);
    }
  }, [graphData, navigateToSystem]);

  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setSearchQuery(val);
    setSearchNoMatch(false);
    setSearchDropdown([]);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (val.trim()) {
      searchTimerRef.current = setTimeout(() => performSearch(val), 500);
    }
  }, [performSearch]);

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      performSearch(searchQuery);
    } else if (e.key === "Escape") {
      setSearchQuery("");
      setSearchDropdown([]);
      setInternalHighlight(null);
    }
  }, [searchQuery, performSearch]);

  // ---------------------------------------------------------------------------
  // Route planner (Task 5)
  // ---------------------------------------------------------------------------

  const handleRoutePlanToggle = useCallback(() => {
    setRoutePlanActive((prev) => {
      if (prev) {
        setRouteStart(null);
        setRouteEnd(null);
        setRoutePath([]);
      }
      return !prev;
    });
  }, []);

  const handleRouteClear = useCallback(() => {
    setRouteStart(null);
    setRouteEnd(null);
    setRoutePath([]);
  }, []);

  // ---------------------------------------------------------------------------
  // Canvas renderers
  // ---------------------------------------------------------------------------

  // Node canvas renderer — delegates to galaxy-map-renderer.ts
  const nodeCanvasObject = useCallback(
    (node: object, ctx: CanvasRenderingContext2D, globalScale: number) => {
      drawNode({
        node: node as GraphNode,
        ctx,
        globalScale,
        highlightSystem: effectiveHighlight,
        highlightAgent,
        overlays,
        dangerScores,
      });
    },
    [effectiveHighlight, highlightAgent, overlays, dangerScores]
  );

  // Larger invisible hit area for easier hover/click
  const nodePointerAreaPaint = useCallback(
    (node: object, color: string, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const n = node as GraphNode;
      const x = n.x ?? 0;
      const y = n.y ?? 0;
      const minHitScreenPx = n.hasAgents ? 16 : 12;
      const baseHitR = n.hasAgents ? 14 : 10;
      const hitR = Math.max(baseHitR, minHitScreenPx / globalScale);
      ctx.beginPath();
      ctx.arc(x, y, hitR, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();
    },
    []
  );

  // Combined pre-render: fog, territory shading, agent trails, then route path
  const renderFramePre = useCallback(
    (ctx: CanvasRenderingContext2D, globalScale: number) => {
      renderFogOfWar({
        ctx,
        nodes: graphData?.nodes ?? [],
        enabled: overlays.fogOfWar,
        exploredSystems,
      });
      renderTerritoryShading({
        ctx,
        nodes: graphData?.nodes ?? [],
        enabled: overlays.territoryShading,
      });
      renderTrails({
        ctx,
        enabled: overlays.agentTrails,
        agentTrails,
        nodeById,
      });
      // Route path drawn before nodes so nodes render on top
      if (routePath.length >= 2) {
        renderRoutePath(ctx, routePath, nodeById, globalScale);
      }
    },
    [overlays.fogOfWar, overlays.territoryShading, overlays.agentTrails, graphData, agentTrails, nodeById, exploredSystems, routePath]
  );

  const linkColor = useCallback(() => LINK_COLOR, []);

  // Custom link rendering: wormholes get dashed cyan lines
  const linkCanvasObject = useCallback(
    (link: object, ctx: CanvasRenderingContext2D, globalScale: number) => {
      if (!overlays.wormholes) return false; // Fall back to default rendering
      const l = link as { source: { id?: string; x: number; y: number }; target: { id?: string; x: number; y: number } };
      const srcId = typeof l.source === "object" ? l.source.id : String(l.source);
      const tgtId = typeof l.target === "object" ? l.target.id : String(l.target);
      if (!srcId || !tgtId) return false;

      const key = srcId < tgtId ? `${srcId}:${tgtId}` : `${tgtId}:${srcId}`;
      if (!wormholeSet.has(key)) return false; // Not a wormhole — use default rendering

      const source = typeof l.source === "object" ? l.source : { x: 0, y: 0 };
      const target = typeof l.target === "object" ? l.target : { x: 0, y: 0 };
      renderWormholeLink({ source, target, ctx, globalScale });
      return true; // We handled it
    },
    [overlays.wormholes, wormholeSet],
  );

  // linkCanvasObjectMode: wormholes replace default, others use default
  const linkCanvasObjectMode = useCallback(
    (link: object) => {
      if (!overlays.wormholes) return undefined;
      const l = link as { source: { id?: string } | string; target: { id?: string } | string };
      const srcId = typeof l.source === "object" ? l.source.id : String(l.source);
      const tgtId = typeof l.target === "object" ? l.target.id : String(l.target);
      if (!srcId || !tgtId) return undefined;
      const key = srcId < tgtId ? `${srcId}:${tgtId}` : `${tgtId}:${srcId}`;
      return wormholeSet.has(key) ? "replace" : undefined;
    },
    [overlays.wormholes, wormholeSet],
  );

  const handleNodeHover = useCallback(
    (node: object | null, _prev: object | null) => {
      setHoveredNode(node ? (node as GraphNode) : null);
    },
    []
  );

  const handleNodeClick = useCallback(
    (node: object) => {
      const n = node as GraphNode;

      // Route planner mode: first click = start, second = end → compute path
      if (routePlanActive) {
        if (!routeStart) {
          setRouteStart(n.id);
          setRoutePath([]);
        } else if (n.id !== routeStart) {
          setRouteEnd(n.id);
          const path = bfsPath(routeStart, n.id, graphData?.links ?? []);
          setRoutePath(path);
        }
        return;
      }

      onSystemClick?.(n.id);
      setInternalHighlight(null); // Clear search highlight on manual click

      // Fetch system detail and show popup
      if (graphRef.current) {
        const screenCoords = graphRef.current.graph2ScreenCoords(n.x, n.y);
        setPopupScreenPos(screenCoords);
      }
      apiFetch<SystemPopupData>(`/map/system-detail?system=${n.id}`)
        .then((data) => setPopupData(data))
        .catch(() => {});
    },
    [onSystemClick, routePlanActive, routeStart, graphData]
  );

  const handlePopupClose = useCallback(() => {
    setPopupData(null);
  }, []);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setTooltipPos({
        x: e.clientX - rect.left + 12,
        y: e.clientY - rect.top - 10,
      });
    },
    []
  );

  const toggleOverlay = useCallback(
    (key: keyof OverlayToggles) => {
      setOverlays((prev) => ({ ...prev, [key]: !prev[key] }));
    },
    []
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (mapError) {
    return (
      <div
        className="flex items-center justify-center border border-border bg-card text-error text-sm"
        style={{ height }}
      >
        Map unavailable: {mapError}
      </div>
    );
  }

  if (!graphData) {
    return (
      <div
        className="flex items-center justify-center border border-border bg-card text-muted-foreground text-sm animate-pulse"
        style={{ height }}
      >
        Loading galaxy map…
      </div>
    );
  }

  // Danger score for hovered node (for tooltip)
  const hoveredDanger = hoveredNode ? (dangerScores[hoveredNode.id] ?? 0) : 0;
  const dangerTier =
    hoveredDanger > 0.66 ? "High" :
    hoveredDanger > 0.33 ? "Medium" :
    hoveredDanger > 0.05 ? "Low" : null;

  const containerWidth = containerRef.current?.offsetWidth ?? 800;

  return (
    <div
      ref={containerRef}
      className="relative border border-border overflow-hidden"
      style={{ height, background: "transparent" }}
      onMouseMove={handleMouseMove}
    >
      {/* Hover tooltip */}
      {hoveredNode && (
        <MapTooltip
          node={hoveredNode}
          pos={tooltipPos}
          dangerTier={dangerTier}
          showDanger={overlays.dangerHeatmap}
        />
      )}

      {/* Overlay toggle bar — top-right */}
      <OverlayBar overlays={overlays} onToggle={toggleOverlay} />

      {/* Search input — top-left (Task 1) */}
      <div className="absolute top-2 left-2 z-10 flex flex-col gap-1">
        <div className="flex items-center gap-1">
          <input
            type="text"
            value={searchQuery}
            onChange={handleSearchChange}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search system..."
            className="w-40 px-2 py-1 text-xs font-mono bg-card/90 border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
          />
          {searchQuery && (
            <button
              onClick={() => { setSearchQuery(""); setSearchDropdown([]); setInternalHighlight(null); }}
              className="text-muted-foreground hover:text-foreground text-xs px-1"
              aria-label="Clear search"
            >
              x
            </button>
          )}
        </div>
        {searchNoMatch && (
          <div className="px-2 py-0.5 text-[10px] font-mono bg-card/90 border border-border text-destructive">
            No match
          </div>
        )}
        {searchDropdown.length > 0 && (
          <div className="bg-card/95 border border-border text-xs font-mono">
            {searchDropdown.map((item) => (
              <button
                key={item.id}
                className="w-full text-left px-2 py-1 hover:bg-secondary text-foreground truncate block"
                onClick={() => { navigateToSystem(item.id); setSearchQuery(item.name); setSearchDropdown([]); }}
              >
                {item.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Route planner controls (Task 5) — below search */}
      <div className="absolute top-12 left-2 z-10 flex flex-col gap-1">
        <div className="flex items-center gap-1 flex-wrap">
          <button
            onClick={handleRoutePlanToggle}
            className={[
              "px-2 py-1 text-xs font-mono border transition-colors",
              routePlanActive
                ? "bg-card border-amber-600 text-amber-300"
                : "bg-card/90 text-muted-foreground border-border hover:text-foreground hover:border-foreground",
            ].join(" ")}
            title="Plan route between two systems"
          >
            {routePlanActive ? "Route: ON" : "Route"}
          </button>
          {routePlanActive && !routeStart && (
            <span className="text-[10px] font-mono text-muted-foreground">Click start</span>
          )}
          {routePlanActive && routeStart && !routeEnd && (
            <span className="text-[10px] font-mono text-amber-400">Click end</span>
          )}
          {routePath.length > 0 && (
            <>
              <span className="px-1.5 py-0.5 text-[10px] font-mono bg-card/90 border border-border text-amber-400">
                {routePath.length - 1} hop{routePath.length - 1 !== 1 ? "s" : ""}
              </span>
              <button
                onClick={handleRouteClear}
                className="px-1.5 py-0.5 text-[10px] font-mono bg-card/90 border border-border text-muted-foreground hover:text-foreground"
              >
                Clear
              </button>
            </>
          )}
          {routeStart && routeEnd && routePath.length === 0 && (
            <span className="text-[10px] font-mono text-destructive">No path</span>
          )}
        </div>
      </div>

      {/* Empire legend — bottom-left */}
      {overlays.empireColors && presentEmpires.length > 0 && (
        <EmpireLegend empires={presentEmpires} />
      )}

      {/* System detail popup */}
      {popupData && (
        <SystemPopup
          data={popupData}
          screenPos={popupScreenPos}
          containerSize={{
            width: containerWidth,
            height,
          }}
          onClose={handlePopupClose}
        />
      )}

      {/* Minimap — bottom-right (Task 4) */}
      <Minimap
        nodes={graphData.nodes}
        graphRef={graphRef}
        containerWidth={containerWidth}
        containerHeight={height}
      />

      <ForceGraph2D
        ref={graphRef}
        graphData={graphData}
        width={containerWidth}
        height={height}
        d3AlphaDecay={1}
        cooldownTicks={0}
        nodeCanvasObject={nodeCanvasObject}
        nodeCanvasObjectMode={() => "replace"}
        linkColor={linkColor}
        linkWidth={0.5}
        linkCanvasObject={linkCanvasObject}
        linkCanvasObjectMode={linkCanvasObjectMode}
        nodePointerAreaPaint={nodePointerAreaPaint}
        onNodeHover={handleNodeHover}
        onNodeClick={handleNodeClick}
        backgroundColor="transparent"
        enableNodeDrag={false}
        onRenderFramePre={renderFramePre}
      />
    </div>
  );
}
