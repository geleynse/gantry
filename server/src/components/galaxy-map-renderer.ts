/**
 * galaxy-map-renderer.ts
 *
 * Canvas rendering functions for the galaxy map:
 * - nodeCanvasObject — draws nodes, agent dots, danger glow, labels
 * - renderTerritoryShading — empire territory fill drawn before nodes
 * - renderTrails — agent path trails drawn before nodes
 * - renderFogOfWar — semi-transparent overlay hiding unexplored systems
 * - renderWormholeLink — gradient dashed line for wormhole connections
 *
 * These are pure functions (no React) so they can be used as stable
 * useCallback dependencies in galaxy-map.tsx.
 */

import { AGENT_COLORS } from "@/lib/utils";
import {
  EMPIRE_COLORS,
  AGENT_COLOR_FALLBACK,
  hexToRgb,
  empireColor,
  convexHull,
  inflateHull,
} from "./galaxy-map-utils";
import type { OverlayToggles } from "./galaxy-map-overlays";
import type { GraphNode } from "./galaxy-map-types";

// ---------------------------------------------------------------------------
// Sprite cache — offscreen canvases for base node circles
// ---------------------------------------------------------------------------

const spriteCache = new Map<string, HTMLCanvasElement>();

function getSpriteKey(empire: string, hasAgents: boolean, isHighlighted: boolean, r: number): string {
  return `${empire}:${hasAgents ? 1 : 0}:${isHighlighted ? 1 : 0}:${Math.round(r)}`;
}

function getOrCreateSprite(
  empire: string,
  hasAgents: boolean,
  isHighlighted: boolean,
  r: number,
  globalScale: number,
): HTMLCanvasElement {
  const key = getSpriteKey(empire, hasAgents, isHighlighted, r);
  const cached = spriteCache.get(key);
  if (cached) return cached;

  const rRounded = Math.round(r);
  // Canvas size: node diameter + highlight ring clearance (5px each side)
  const pad = isHighlighted ? Math.ceil(4 / globalScale) + 2 : 2;
  const size = (rRounded + pad) * 2;
  const canvas = new OffscreenCanvas(size, size) as unknown as HTMLCanvasElement;
  const ctx = (canvas as unknown as OffscreenCanvas).getContext("2d") as OffscreenCanvasRenderingContext2D;
  const cx = size / 2;
  const cy = size / 2;

  const color = empireColor(empire);

  // Highlight ring
  if (isHighlighted) {
    ctx.beginPath();
    ctx.arc(cx, cy, rRounded + 4 / globalScale, 0, 2 * Math.PI);
    ctx.strokeStyle = "#88c0d0";
    ctx.lineWidth = 1.5 / globalScale;
    ctx.stroke();
  }

  // Node fill
  ctx.beginPath();
  ctx.arc(cx, cy, rRounded, 0, 2 * Math.PI);
  ctx.fillStyle = color;
  ctx.fill();

  spriteCache.set(key, canvas);
  return canvas;
}

/** Clear the sprite cache (call on theme change or when globalScale changes drastically). */
export function clearSpriteCache(): void {
  spriteCache.clear();
}

// ---------------------------------------------------------------------------
// nodeCanvasObject
// ---------------------------------------------------------------------------

export interface NodeCanvasObjectParams {
  node: GraphNode;
  ctx: CanvasRenderingContext2D;
  globalScale: number;
  highlightSystem: string | null;
  highlightAgent?: string | null;
  overlays: OverlayToggles;
  dangerScores: Record<string, number>;
}

export function drawNode({
  node,
  ctx,
  globalScale,
  highlightSystem,
  highlightAgent = null,
  overlays,
  dangerScores,
}: NodeCanvasObjectParams): void {
  const x = node.x ?? 0;
  const y = node.y ?? 0;
  const isHighlighted = highlightSystem === node.id;

  const minScreenPx = node.hasAgents ? 5 : 3;
  const baseR = node.hasAgents ? 8 : 5;
  const r = Math.max(baseR, minScreenPx / globalScale);

  // --- Danger heatmap glow ---
  const danger = overlays.dangerHeatmap ? (dangerScores[node.id] ?? 0) : 0;
  if (overlays.dangerHeatmap && danger > 0.05) {
    const glowR = r * (2 + danger * 3);
    const grad = ctx.createRadialGradient(x, y, r * 0.5, x, y, glowR);
    grad.addColorStop(0, `rgba(220,38,38,${danger * 0.45})`);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, glowR, 0, 2 * Math.PI);
    ctx.fill();

    // --- Battle marker: crossed lines on high-danger systems ---
    if (danger > 0.5 && globalScale >= 0.4) {
      const iconSize = Math.max(3, 6 * Math.min(globalScale, 1.5));
      const ix = x + r + iconSize * 0.6;
      const iy = y - r - iconSize * 0.6;
      ctx.save();
      ctx.strokeStyle = "rgba(220,38,38,0.8)";
      ctx.lineWidth = Math.max(0.8, 1.5 / globalScale);
      ctx.lineCap = "round";
      // First diagonal: top-left to bottom-right
      ctx.beginPath();
      ctx.moveTo(ix - iconSize / 2, iy - iconSize / 2);
      ctx.lineTo(ix + iconSize / 2, iy + iconSize / 2);
      ctx.stroke();
      // Second diagonal: top-right to bottom-left
      ctx.beginPath();
      ctx.moveTo(ix + iconSize / 2, iy - iconSize / 2);
      ctx.lineTo(ix - iconSize / 2, iy + iconSize / 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  // --- Node fill color (via sprite cache) ---
  const empire = overlays.empireColors ? node.empire : "neutral";

  try {
    const sprite = getOrCreateSprite(empire, node.hasAgents, isHighlighted, r, globalScale);
    const pad = isHighlighted ? Math.ceil(4 / globalScale) + 2 : 2;
    const size = (Math.round(r) + pad) * 2;
    ctx.drawImage(sprite as unknown as CanvasImageSource, x - size / 2, y - size / 2, size, size);
  } catch {
    // Fallback: draw directly if OffscreenCanvas is unavailable (e.g., test env)
    const color = overlays.empireColors ? empireColor(node.empire) : EMPIRE_COLORS.neutral;
    if (isHighlighted) {
      ctx.beginPath();
      ctx.arc(x, y, r + 4 / globalScale, 0, 2 * Math.PI);
      ctx.strokeStyle = "#88c0d0";
      ctx.lineWidth = 1.5 / globalScale;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
  }

  // Agent dots orbiting around the node
  if (node.agents.length > 0) {
    const orbitR = r + Math.max(6, 4 / globalScale);
    const dotR = Math.max(4, 2.5 / globalScale);
    node.agents.forEach((agent, idx) => {
      const angle = (2 * Math.PI * idx) / node.agents.length - Math.PI / 2;
      const ax = x + orbitR * Math.cos(angle);
      const ay = y + orbitR * Math.sin(angle);
      const agentColor = AGENT_COLORS[agent] ?? AGENT_COLOR_FALLBACK;
      const isHighlightedAgent = highlightAgent === agent;

      // Draw highlight ring around the current agent's dot
      if (isHighlightedAgent) {
        ctx.beginPath();
        ctx.arc(ax, ay, dotR + 3 / globalScale, 0, 2 * Math.PI);
        ctx.strokeStyle = agentColor;
        ctx.lineWidth = 1.5 / globalScale;
        ctx.stroke();
      }

      // Draw a small triangle/arrow shape pointing right instead of a plain circle
      const sr = isHighlightedAgent ? dotR * 1.4 : dotR;
      ctx.beginPath();
      ctx.moveTo(ax + sr, ay);
      ctx.lineTo(ax - sr * 0.7, ay - sr * 0.85);
      ctx.lineTo(ax - sr * 0.7, ay + sr * 0.85);
      ctx.closePath();
      ctx.fillStyle = agentColor;
      ctx.fill();

      if (globalScale > 0.6) {
        const firstName = agent.split(/[-_\s]/)[0];
        const fontSize = Math.max(8, 8 / globalScale);
        ctx.font = `${isHighlightedAgent ? "bold " : ""}${fontSize}px "JetBrains Mono", monospace`;
        ctx.fillStyle = agentColor;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(firstName, ax, ay + (isHighlightedAgent ? dotR * 1.4 : dotR) + 1 / globalScale);
        ctx.textBaseline = "alphabetic";
      }
    });
  }

  // --- System name labels — zoom-dependent LOD (no manual toggle) ---
  if (globalScale > 1.5 || (node.hasAgents && globalScale > 0.8)) {
    const fontSize = Math.max(8, 10 / globalScale);
    ctx.font = `${fontSize}px "JetBrains Mono", monospace`;
    ctx.fillStyle = AGENT_COLOR_FALLBACK;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(node.name, x, y - r - 2 / globalScale);
    ctx.textBaseline = "alphabetic";
  }
}

// ---------------------------------------------------------------------------
// renderTerritoryShading
// ---------------------------------------------------------------------------

export interface TerritoryRenderParams {
  ctx: CanvasRenderingContext2D;
  nodes: GraphNode[];
  enabled: boolean;
}

export function renderTerritoryShading({ ctx, nodes, enabled }: TerritoryRenderParams): void {
  if (!enabled) return;

  const byEmpire: Record<string, GraphNode[]> = {};
  for (const node of nodes) {
    if (node.empire === "neutral") continue;
    (byEmpire[node.empire] ??= []).push(node);
  }

  ctx.save();

  for (const [empire, empireNodes] of Object.entries(byEmpire)) {
    const hex = EMPIRE_COLORS[empire] ?? EMPIRE_COLORS.neutral;
    const { r, g, b } = hexToRgb(hex);
    ctx.fillStyle = `rgba(${r},${g},${b},0.12)`;
    ctx.strokeStyle = `rgba(${r},${g},${b},0.22)`;
    ctx.lineWidth = 1;

    if (empireNodes.length <= 2) {
      for (const n of empireNodes) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, 40, 0, 2 * Math.PI);
        ctx.fill();
        ctx.stroke();
      }
    } else {
      // Circle-union pass: draw a filled circle around every system so
      // outlier nodes that fall outside the convex hull are still shaded
      for (const n of empireNodes) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, 55, 0, 2 * Math.PI);
        ctx.fill();
      }

      const pts = empireNodes.map((n) => ({ x: n.x, y: n.y }));
      const hull = convexHull(pts);
      const inflated = inflateHull(hull, 55);
      if (inflated.length < 3) continue;

      ctx.beginPath();
      for (let i = 0; i < inflated.length; i++) {
        const curr = inflated[i];
        const next = inflated[(i + 1) % inflated.length];
        const mid = { x: (curr.x + next.x) / 2, y: (curr.y + next.y) / 2 };
        if (i === 0) {
          ctx.moveTo(mid.x, mid.y);
        }
        const nextNext = inflated[(i + 2) % inflated.length];
        const midNext = { x: (next.x + nextNext.x) / 2, y: (next.y + nextNext.y) / 2 };
        ctx.quadraticCurveTo(next.x, next.y, midNext.x, midNext.y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// renderTrails
// ---------------------------------------------------------------------------

export interface TrailsRenderParams {
  ctx: CanvasRenderingContext2D;
  enabled: boolean;
  agentTrails: Record<string, string[]>;
  nodeById: Record<string, GraphNode>;
}

export function renderTrails({ ctx, enabled, agentTrails, nodeById }: TrailsRenderParams): void {
  if (!enabled) return;

  for (const agent of Object.keys(agentTrails)) {
    const systems = agentTrails[agent];
    if (systems.length < 2) continue;

    const color = AGENT_COLORS[agent] ?? AGENT_COLOR_FALLBACK;
    const { r, g, b } = hexToRgb(color);

    for (let i = 0; i < systems.length - 1; i++) {
      const fromNode = nodeById[systems[i]];
      const toNode = nodeById[systems[i + 1]];
      if (!fromNode || !toNode) continue;
      const alpha = 0.5 * (1 - i / systems.length);
      ctx.beginPath();
      ctx.moveTo(fromNode.x, fromNode.y);
      ctx.lineTo(toNode.x, toNode.y);
      ctx.strokeStyle = `rgba(${r},${g},${b},${alpha.toFixed(2)})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}

// ---------------------------------------------------------------------------
// renderFogOfWar — semi-transparent overlay hiding unexplored systems
// ---------------------------------------------------------------------------

export interface FogOfWarRenderParams {
  ctx: CanvasRenderingContext2D;
  nodes: GraphNode[];
  enabled: boolean;
  exploredSystems: Set<string>;
}

/**
 * Draw a fog-of-war overlay. Unexplored systems get a dark semi-transparent
 * circle overlay. Explored systems are left clear.
 */
export function renderFogOfWar({ ctx, nodes, enabled, exploredSystems }: FogOfWarRenderParams): void {
  if (!enabled || exploredSystems.size === 0) return;

  ctx.save();

  for (const node of nodes) {
    if (exploredSystems.has(node.id)) continue;

    // Draw a dark fog circle over unexplored systems
    const x = node.x;
    const y = node.y;
    const fogR = 30;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, fogR);
    grad.addColorStop(0, "rgba(10, 12, 18, 0.7)");
    grad.addColorStop(0.6, "rgba(10, 12, 18, 0.5)");
    grad.addColorStop(1, "rgba(10, 12, 18, 0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, fogR, 0, 2 * Math.PI);
    ctx.fill();
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// renderWormholeLink — gradient dashed line for wormhole connections
// ---------------------------------------------------------------------------

export interface WormholeLinkRenderParams {
  source: { x: number; y: number };
  target: { x: number; y: number };
  ctx: CanvasRenderingContext2D;
  globalScale: number;
}

/**
 * Draw a visually distinctive wormhole connection:
 * - Two-pass rendering: glow pass (wide, low opacity) + main line pass
 * - Linear gradient that fades in the middle for a "tunnel" effect
 * - Longer dashes that scale with zoom
 */
export function renderWormholeLink({ source, target, ctx, globalScale }: WormholeLinkRenderParams): void {
  const grad = ctx.createLinearGradient(source.x, source.y, target.x, target.y);
  grad.addColorStop(0,   "rgba(136,192,208,0.6)");
  grad.addColorStop(0.5, "rgba(136,192,208,0.2)");
  grad.addColorStop(1,   "rgba(136,192,208,0.6)");

  const dashPattern = [6 / globalScale, 3 / globalScale];
  const mainWidth = Math.max(1.5, 2 / globalScale);

  ctx.save();

  // --- Glow pass ---
  ctx.beginPath();
  ctx.moveTo(source.x, source.y);
  ctx.lineTo(target.x, target.y);
  ctx.strokeStyle = "rgba(136,192,208,0.12)";
  ctx.lineWidth = mainWidth * 3;
  ctx.setLineDash(dashPattern);
  ctx.stroke();

  // --- Main line pass ---
  ctx.beginPath();
  ctx.moveTo(source.x, source.y);
  ctx.lineTo(target.x, target.y);
  ctx.strokeStyle = grad;
  ctx.lineWidth = mainWidth;
  ctx.setLineDash(dashPattern);
  ctx.stroke();

  ctx.setLineDash([]);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// renderRoutePath — highlight a planned route path
// ---------------------------------------------------------------------------

/**
 * Draw highlighted route path edges in gold/amber color with thicker lines.
 * routePath is an ordered array of system IDs forming the route.
 */
export function renderRoutePath(
  ctx: CanvasRenderingContext2D,
  routePath: string[],
  nodeById: Record<string, GraphNode>,
  globalScale: number
): void {
  if (routePath.length < 2) return;

  ctx.save();
  ctx.strokeStyle = "#f59e0b";
  ctx.lineWidth = Math.max(2, 2.5 / globalScale);
  ctx.setLineDash([]);
  ctx.globalAlpha = 0.85;

  for (let i = 0; i < routePath.length - 1; i++) {
    const a = nodeById[routePath[i]];
    const b = nodeById[routePath[i + 1]];
    if (!a || !b) continue;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  // Draw amber dots at each route node
  for (const id of routePath) {
    const n = nodeById[id];
    if (!n) continue;
    ctx.beginPath();
    ctx.arc(n.x, n.y, Math.max(3, 3 / globalScale), 0, 2 * Math.PI);
    ctx.fillStyle = "#f59e0b";
    ctx.fill();
  }

  ctx.restore();
}
