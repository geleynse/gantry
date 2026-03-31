/**
 * Ship image config tests
 * Tests URL generation and emoji fallback logic
 */

import { describe, it, expect } from "bun:test";
import { getShipImageUrl, getShipClassEmoji, SIZE_PIXELS } from "../config/shipImages.js";

describe("getShipImageUrl", () => {
  it("generates correct URL for a known ship class", () => {
    const url = getShipImageUrl("outerrim_prayer");
    expect(url).toBe("https://www.spacemolt.com/images/ships/catalog/outerrim_prayer.webp");
  });

  it("normalizes spaces to underscores", () => {
    const url = getShipImageUrl("mining barge");
    expect(url).toBe("https://www.spacemolt.com/images/ships/catalog/mining_barge.webp");
  });

  it("lowercases the class name", () => {
    const url = getShipImageUrl("Nebula_Floor_Price");
    expect(url).toBe("https://www.spacemolt.com/images/ships/catalog/nebula_floor_price.webp");
  });

  it("handles empty string", () => {
    const url = getShipImageUrl("");
    expect(url).toBe("https://www.spacemolt.com/images/ships/catalog/unknown.webp");
  });
});

describe("getShipClassEmoji", () => {
  it("matches mining prefix", () => {
    const emoji = getShipClassEmoji("mining_barge");
    expect(emoji.emoji).toBe("⛏️");
    expect(emoji.abbreviation).toBe("MIN");
  });

  it("matches outerrim prefix", () => {
    const emoji = getShipClassEmoji("outerrim_prayer");
    expect(emoji.emoji).toBe("🌌");
    expect(emoji.abbreviation).toBe("OTR");
  });

  it("matches nebula prefix", () => {
    const emoji = getShipClassEmoji("nebula_floor_price");
    expect(emoji.emoji).toBe("☁️");
    expect(emoji.abbreviation).toBe("NEB");
  });

  it("matches starter prefix", () => {
    const emoji = getShipClassEmoji("starter_mining");
    expect(emoji.emoji).toBe("🚀");
    expect(emoji.abbreviation).toBe("STR");
  });

  it("matches freighter prefix", () => {
    const emoji = getShipClassEmoji("freighter_medium");
    expect(emoji.emoji).toBe("📦");
    expect(emoji.abbreviation).toBe("FRE");
  });

  it("returns default for unknown class", () => {
    const emoji = getShipClassEmoji("totally_unknown_class");
    expect(emoji.emoji).toBe("🚀");
    expect(emoji.abbreviation).toBe("UNK");
  });

  it("handles empty string", () => {
    const emoji = getShipClassEmoji("");
    expect(emoji.abbreviation).toBe("UNK");
  });
});

describe("SIZE_PIXELS", () => {
  it("has correct size mappings", () => {
    expect(SIZE_PIXELS.icon).toBe(32);
    expect(SIZE_PIXELS.thumbnail).toBe(64);
    expect(SIZE_PIXELS.medium).toBe(200);
    expect(SIZE_PIXELS.large).toBe(400);
    expect(SIZE_PIXELS.xlarge).toBe(800);
  });
});
