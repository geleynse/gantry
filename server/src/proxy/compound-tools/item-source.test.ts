/**
 * item-source.test.ts
 *
 * Tests for item source classification helpers.
 */

import { describe, it, expect } from "bun:test";
import { classifyItemSource, isSelfSourceable, selfSourceCost } from "./item-source.js";
import type { ItemSource } from "./item-source.js";

describe("classifyItemSource", () => {
  // ---- mine ----------------------------------------------------------------

  it("classifies *_ore as mine", () => {
    expect(classifyItemSource("iron_ore")).toBe("mine");
    expect(classifyItemSource("copper_ore")).toBe("mine");
    expect(classifyItemSource("rare_ore")).toBe("mine");
  });

  it("classifies *_crystal as mine", () => {
    expect(classifyItemSource("void_crystal")).toBe("mine");
    expect(classifyItemSource("ice_crystal")).toBe("mine");
  });

  it("classifies *_gem as mine", () => {
    expect(classifyItemSource("star_gem")).toBe("mine");
    expect(classifyItemSource("fire_gem")).toBe("mine");
  });

  it("classifies items containing 'mineral' as mine", () => {
    expect(classifyItemSource("mineral_dust")).toBe("mine");
    expect(classifyItemSource("raw_mineral")).toBe("mine");
    expect(classifyItemSource("minerals")).toBe("mine");
  });

  // ---- harvest -------------------------------------------------------------

  it("classifies *_herb as harvest", () => {
    expect(classifyItemSource("moon_herb")).toBe("harvest");
    expect(classifyItemSource("rare_herb")).toBe("harvest");
  });

  it("classifies *_fiber as harvest", () => {
    expect(classifyItemSource("silk_fiber")).toBe("harvest");
    expect(classifyItemSource("plant_fiber")).toBe("harvest");
  });

  it("classifies *_pollen as harvest", () => {
    expect(classifyItemSource("gold_pollen")).toBe("harvest");
  });

  it("classifies *_seed as harvest", () => {
    expect(classifyItemSource("crop_seed")).toBe("harvest");
    expect(classifyItemSource("wild_seed")).toBe("harvest");
  });

  // ---- salvage -------------------------------------------------------------

  it("classifies salvage_* as salvage", () => {
    expect(classifyItemSource("salvage_hull")).toBe("salvage");
    expect(classifyItemSource("salvage_parts")).toBe("salvage");
  });

  it("classifies wreck_* as salvage", () => {
    expect(classifyItemSource("wreck_metal")).toBe("salvage");
  });

  it("classifies scrap_* as salvage", () => {
    expect(classifyItemSource("scrap_iron")).toBe("salvage");
    expect(classifyItemSource("scrap_electronics")).toBe("salvage");
  });

  it("classifies *_debris as salvage", () => {
    expect(classifyItemSource("hull_debris")).toBe("salvage");
    expect(classifyItemSource("ship_debris")).toBe("salvage");
  });

  // ---- market (default) ----------------------------------------------------

  it("classifies refined/processed goods as market", () => {
    expect(classifyItemSource("steel_plate")).toBe("market");
    expect(classifyItemSource("ship_engine")).toBe("market");
    expect(classifyItemSource("copper_wire")).toBe("market");
    expect(classifyItemSource("food_ration")).toBe("market");
  });

  it("classifies unrecognised items as market", () => {
    expect(classifyItemSource("unknown_thing")).toBe("market");
    expect(classifyItemSource("")).toBe("market");
  });

  // ---- case insensitivity --------------------------------------------------

  it("is case-insensitive", () => {
    expect(classifyItemSource("Iron_Ore")).toBe("mine");
    expect(classifyItemSource("IRON_ORE")).toBe("mine");
    expect(classifyItemSource("Salvage_Hull")).toBe("salvage");
    expect(classifyItemSource("Moon_Herb")).toBe("harvest");
  });
});

describe("isSelfSourceable", () => {
  it("returns true for mine, salvage, harvest", () => {
    expect(isSelfSourceable("mine")).toBe(true);
    expect(isSelfSourceable("salvage")).toBe(true);
    expect(isSelfSourceable("harvest")).toBe(true);
  });

  it("returns false for market", () => {
    expect(isSelfSourceable("market")).toBe(false);
  });
});

describe("selfSourceCost", () => {
  it("returns 0 for self-sourceable items regardless of market price", () => {
    expect(selfSourceCost("mine", 500)).toBe(0);
    expect(selfSourceCost("salvage", 100)).toBe(0);
    expect(selfSourceCost("harvest", 250)).toBe(0);
  });

  it("returns the market buy price for market-sourced items", () => {
    expect(selfSourceCost("market", 75)).toBe(75);
    expect(selfSourceCost("market", 0)).toBe(0);
  });
});
