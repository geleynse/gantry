import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { GalaxyGraph } from "./pathfinder.js";
import { createPoiValidator } from "./poi-validator.js";
import { systemPoiCache } from "./poi-resolver.js";

function buildTestGraph(): GalaxyGraph {
  const g = new GalaxyGraph();
  g.addSystem("sys_alpha", "Alpha");
  g.addSystem("sys_beta", "Beta Prime");
  g.addSystem("sys_gamma", "Gamma Station");
  g.addEdge("sys_alpha", "sys_beta");
  g.addEdge("sys_beta", "sys_gamma");
  return g;
}

describe("PoiValidator — isValidSystem", () => {
  it("accepts known system by display name", () => {
    const validator = createPoiValidator(buildTestGraph());
    expect(validator.isValidSystem("Alpha")).toBe(true);
    expect(validator.isValidSystem("Beta Prime")).toBe(true);
  });

  it("accepts known system by ID", () => {
    const validator = createPoiValidator(buildTestGraph());
    expect(validator.isValidSystem("sys_alpha")).toBe(true);
  });

  it("rejects unknown system name", () => {
    const validator = createPoiValidator(buildTestGraph());
    expect(validator.isValidSystem("Zorgon IV")).toBe(false);
  });

  it("returns true when graph is empty (not loaded yet)", () => {
    const validator = createPoiValidator(new GalaxyGraph());
    expect(validator.isValidSystem("anything")).toBe(true);
  });
});

describe("PoiValidator — isValidPoi", () => {
  beforeEach(() => {
    systemPoiCache.set("sys_alpha", [
      { id: "poi_alpha_station", name: "Alpha Station", type: "station" },
      { id: "poi_alpha_belt", name: "Alpha Belt", type: "asteroid_belt" },
    ]);
  });

  afterEach(() => {
    systemPoiCache.clear();
  });

  it("accepts known POI by name", () => {
    const validator = createPoiValidator(buildTestGraph());
    expect(validator.isValidPoi("Alpha", "Alpha Station")).toBe(true);
  });

  it("accepts known POI by ID", () => {
    const validator = createPoiValidator(buildTestGraph());
    expect(validator.isValidPoi("sys_alpha", "poi_alpha_belt")).toBe(true);
  });

  it("rejects unknown POI when system has cached POI data", () => {
    const validator = createPoiValidator(buildTestGraph());
    expect(validator.isValidPoi("Alpha", "Hallucinated Outpost")).toBe(false);
  });

  it("returns true for unknown POI when no cache data for system", () => {
    const validator = createPoiValidator(buildTestGraph());
    // sys_beta has no cached POIs — should not flag
    expect(validator.isValidPoi("Beta Prime", "anything")).toBe(true);
  });
});

describe("PoiValidator — getSuggestions", () => {
  it("returns close substring matches", () => {
    const validator = createPoiValidator(buildTestGraph());
    const suggestions = validator.getSuggestions("Alph");
    expect(suggestions).toContain("Alpha");
  });

  it("returns close Levenshtein matches", () => {
    const validator = createPoiValidator(buildTestGraph());
    // "Betta" is one edit away from "Beta" (part of "Beta Prime")
    const suggestions = validator.getSuggestions("Betta Prime");
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0]).toBe("Beta Prime");
  });

  it("returns empty array when graph is empty", () => {
    const validator = createPoiValidator(new GalaxyGraph());
    expect(validator.getSuggestions("anything")).toEqual([]);
  });
});
