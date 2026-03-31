/**
 * Pure utility functions for galaxy map — extracted for testability.
 * No React/JSX dependencies.
 */

// ---------------------------------------------------------------------------
// Empire color constants
// ---------------------------------------------------------------------------

/** Fallback color for unknown agents (Nord Snow Storm) */
export const AGENT_COLOR_FALLBACK = "#d8dee9";

/** Parse a hex color string to RGB components. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

/** Canonical empire colors per design doc */
export const EMPIRE_COLORS: Record<string, string> = {
  solarian:         "#d4a017",  // gold
  voidborn:         "#7c3aed",  // purple
  crimson:          "#dc2626",  // red
  nebula:           "#0d9488",  // teal
  outerrim:         "#ea580c",  // orange
  piratestronghold: "#7f1d1d",  // dark red
  neutral:          "#4b5563",  // gray
};

export const EMPIRE_LABELS: Record<string, string> = {
  solarian:         "Solarian",
  voidborn:         "Voidborn",
  crimson:          "Crimson",
  nebula:           "Nebula",
  outerrim:         "Outer Rim",
  piratestronghold: "Pirate Stronghold",
  neutral:          "Neutral",
};

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Normalize empire string: lowercase, strip spaces/underscores/hyphens */
export function normalizeEmpire(empire?: string): string {
  if (!empire) return "neutral";
  return empire.toLowerCase().replace(/[\s_-]+/g, "");
}

export function empireColor(empire?: string): string {
  const key = normalizeEmpire(empire);
  return EMPIRE_COLORS[key] ?? EMPIRE_COLORS.neutral;
}

// ---------------------------------------------------------------------------
// Danger heatmap
// ---------------------------------------------------------------------------

export interface CombatSystemStat {
  system: string;
  encounter_count: number;
  death_count: number;
  total_damage: number;
}

// ---------------------------------------------------------------------------
// Convex hull & hull inflation (for territory shading)
// ---------------------------------------------------------------------------

type Point = { x: number; y: number };

function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/**
 * Compute the convex hull of a set of points using Andrew's monotone chain.
 * Returns points in counter-clockwise order. Collinear interior points are
 * excluded — only the two extremes of a collinear run are kept.
 */
export function convexHull(points: Point[]): Point[] {
  if (points.length <= 2) return [...points];

  const sorted = [...points].sort((a, b) => a.x !== b.x ? a.x - b.x : a.y - b.y);

  // Lower hull
  const lower: Point[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  // Upper hull
  const upper: Point[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  // Remove last point of each half (duplicates of the first of the other half)
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

/**
 * Inflate a convex hull by moving each vertex outward from the centroid.
 * Useful for drawing territory regions that extend past the node positions.
 */
export function inflateHull(hull: Point[], padding: number): Point[] {
  if (hull.length <= 1) return [...hull];

  let cx = 0, cy = 0;
  for (const p of hull) { cx += p.x; cy += p.y; }
  cx /= hull.length;
  cy /= hull.length;

  return hull.map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return { x: p.x + padding, y: p.y };
    return { x: p.x + (dx / dist) * padding, y: p.y + (dy / dist) * padding };
  });
}

/**
 * Normalize encounter counts to 0..1 using log scale.
 * Returns a map keyed by system id/name.
 */
export function buildDangerScores(
  stats: CombatSystemStat[]
): Record<string, number> {
  if (stats.length === 0) return {};
  let max = 1;
  for (const r of stats) if (r.encounter_count > max) max = r.encounter_count;
  const scores: Record<string, number> = {};
  for (const r of stats) {
    scores[r.system] = Math.log(1 + r.encounter_count) / Math.log(1 + max);
  }
  return scores;
}
