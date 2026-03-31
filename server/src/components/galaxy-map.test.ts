/**
 * Unit tests for galaxy-map utility functions.
 * Tests empire color normalization, danger score computation, and graph data building.
 */
import { describe, it, expect } from "bun:test";
import { EMPIRE_COLORS, buildDangerScores, convexHull, inflateHull } from "./galaxy-map-utils.js";

// Re-export normalizeEmpire indirectly via EMPIRE_COLORS lookup
// (normalization is baked into buildGraphData; we test the public exports)

describe("EMPIRE_COLORS", () => {
  it("has all 7 canonical empires", () => {
    const expected = [
      "solarian",
      "voidborn",
      "crimson",
      "nebula",
      "outerrim",
      "piratestronghold",
      "neutral",
    ];
    for (const key of expected) {
      expect(EMPIRE_COLORS[key]).toBeDefined();
    }
  });

  it("uses canonical hex colors", () => {
    expect(EMPIRE_COLORS.solarian).toBe("#d4a017");
    expect(EMPIRE_COLORS.voidborn).toBe("#7c3aed");
    expect(EMPIRE_COLORS.crimson).toBe("#dc2626");
    expect(EMPIRE_COLORS.nebula).toBe("#0d9488");
    expect(EMPIRE_COLORS.outerrim).toBe("#ea580c");
    expect(EMPIRE_COLORS.piratestronghold).toBe("#7f1d1d");
    expect(EMPIRE_COLORS.neutral).toBe("#4b5563");
  });
});

describe("buildDangerScores", () => {
  it("returns empty object for empty input", () => {
    expect(buildDangerScores([])).toEqual({});
  });

  it("assigns score 1.0 to highest encounter system", () => {
    const stats = [
      { system: "krynn", encounter_count: 10, death_count: 1, total_damage: 100 },
      { system: "sol",   encounter_count: 2,  death_count: 0, total_damage: 20 },
    ];
    const scores = buildDangerScores(stats);
    expect(scores["krynn"]).toBeCloseTo(1.0);
  });

  it("assigns lower scores to less-active systems", () => {
    const stats = [
      { system: "krynn",   encounter_count: 100, death_count: 5, total_damage: 500 },
      { system: "sol",     encounter_count: 10,  death_count: 1, total_damage: 50 },
      { system: "neutral", encounter_count: 1,   death_count: 0, total_damage: 5 },
    ];
    const scores = buildDangerScores(stats);
    // Monotonically decreasing
    expect(scores["krynn"]).toBeGreaterThan(scores["sol"]);
    expect(scores["sol"]).toBeGreaterThan(scores["neutral"]);
  });

  it("all scores are between 0 and 1 (inclusive)", () => {
    const stats = [
      { system: "a", encounter_count: 0,   death_count: 0, total_damage: 0 },
      { system: "b", encounter_count: 1,   death_count: 0, total_damage: 10 },
      { system: "c", encounter_count: 999, death_count: 5, total_damage: 999 },
    ];
    const scores = buildDangerScores(stats);
    for (const score of Object.values(scores)) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it("single system gets score 1.0", () => {
    const stats = [
      { system: "only", encounter_count: 5, death_count: 0, total_damage: 50 },
    ];
    const scores = buildDangerScores(stats);
    expect(scores["only"]).toBeCloseTo(1.0);
  });
});

// ---------------------------------------------------------------------------
// convexHull
// ---------------------------------------------------------------------------

describe("convexHull", () => {
  it("returns empty array for empty input", () => {
    expect(convexHull([])).toEqual([]);
  });

  it("returns single point unchanged", () => {
    const pts = [{ x: 1, y: 2 }];
    expect(convexHull(pts)).toEqual(pts);
  });

  it("returns both points for two-point input", () => {
    const pts = [{ x: 0, y: 0 }, { x: 3, y: 4 }];
    const hull = convexHull(pts);
    expect(hull).toHaveLength(2);
    expect(hull).toContainEqual({ x: 0, y: 0 });
    expect(hull).toContainEqual({ x: 3, y: 4 });
  });

  it("finds hull of triangle — returns all 3 vertices", () => {
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }];
    const hull = convexHull(pts);
    expect(hull).toHaveLength(3);
    for (const p of pts) expect(hull).toContainEqual(p);
  });

  it("includes only extremes for collinear points", () => {
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }];
    const hull = convexHull(pts);
    expect(hull).toHaveLength(2);
    expect(hull).toContainEqual({ x: 0, y: 0 });
    expect(hull).toContainEqual({ x: 3, y: 0 });
  });

  it("excludes interior point for square with center", () => {
    const pts = [
      { x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 },
      { x: 1, y: 1 }, // interior
    ];
    const hull = convexHull(pts);
    expect(hull).toHaveLength(4);
    expect(hull).not.toContainEqual({ x: 1, y: 1 });
  });

  it("excludes interior point from irregular polygon", () => {
    const pts = [
      { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 2, y: 4 },
      { x: 2, y: 1.5 }, // clearly interior
    ];
    const hull = convexHull(pts);
    expect(hull).toHaveLength(3);
    expect(hull).not.toContainEqual({ x: 2, y: 1.5 });
  });

  it("all returned points exist in the input", () => {
    const pts = [
      { x: 0, y: 0 }, { x: 5, y: 1 }, { x: 3, y: 4 },
      { x: 1, y: 2 }, { x: 4, y: 2 }, { x: 2, y: 3 },
    ];
    const hull = convexHull(pts);
    for (const h of hull) {
      expect(pts).toContainEqual(h);
    }
  });
});

// ---------------------------------------------------------------------------
// inflateHull
// ---------------------------------------------------------------------------

describe("inflateHull", () => {
  it("returns empty array for empty input", () => {
    expect(inflateHull([], 10)).toEqual([]);
  });

  it("returns single point unchanged (cannot inflate without direction)", () => {
    expect(inflateHull([{ x: 5, y: 5 }], 10)).toEqual([{ x: 5, y: 5 }]);
  });

  it("preserves vertex count", () => {
    const hull = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }];
    expect(inflateHull(hull, 5)).toHaveLength(3);
  });

  it("moves each vertex further from centroid", () => {
    const hull = [
      { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 0 }, { x: 0, y: -1 },
    ];
    // centroid = (0, 0)
    const inflated = inflateHull(hull, 1);
    for (let i = 0; i < hull.length; i++) {
      const origDist = Math.hypot(hull[i].x, hull[i].y);
      const newDist = Math.hypot(inflated[i].x, inflated[i].y);
      expect(newDist).toBeGreaterThan(origDist);
    }
  });

  it("larger padding produces a larger hull", () => {
    const hull = [{ x: -1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }];
    const cx = 0;
    const cy = 1 / 3;
    const small = inflateHull(hull, 1);
    const large = inflateHull(hull, 10);
    const smallDist = Math.hypot(small[0].x - cx, small[0].y - cy);
    const largeDist = Math.hypot(large[0].x - cx, large[0].y - cy);
    expect(largeDist).toBeGreaterThan(smallDist);
  });

  it("inflates two-point hull outward from midpoint", () => {
    const hull = [{ x: 0, y: 0 }, { x: 2, y: 0 }];
    const inflated = inflateHull(hull, 1);
    expect(inflated[0].x).toBeCloseTo(-1);
    expect(inflated[1].x).toBeCloseTo(3);
  });
});
