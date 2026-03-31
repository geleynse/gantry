import { describe, it, expect } from "bun:test";
import { getModRecommendations, ROLE_MOD_PRIORITIES } from "./mod-policy.js";

describe("getModRecommendations", () => {
  it("returns combat mods for combat role", () => {
    const recs = getModRecommendations("combat");
    expect(recs).toBe(ROLE_MOD_PRIORITIES.combat);
    expect(recs[0].priority).toBe(1);
  });

  it("returns explorer mods for explorer role", () => {
    const recs = getModRecommendations("explorer");
    expect(recs).toBe(ROLE_MOD_PRIORITIES.explorer);
  });

  it("returns trader mods for trader role", () => {
    const recs = getModRecommendations("trader");
    expect(recs).toBe(ROLE_MOD_PRIORITIES.trader);
  });

  it("returns miner mods for miner role", () => {
    const recs = getModRecommendations("miner");
    expect(recs).toBe(ROLE_MOD_PRIORITIES.miner);
  });

  it("returns crafter mods for crafter role", () => {
    const recs = getModRecommendations("crafter");
    expect(recs).toBe(ROLE_MOD_PRIORITIES.crafter);
  });

  it("returns hauler mods for hauler role", () => {
    const recs = getModRecommendations("hauler");
    expect(recs).toBe(ROLE_MOD_PRIORITIES.hauler);
  });

  it("returns default mods for undefined role", () => {
    const recs = getModRecommendations(undefined);
    expect(recs.length).toBeGreaterThan(0);
    expect(recs[0]).toHaveProperty("mod_type");
    expect(recs[0]).toHaveProperty("priority");
    expect(recs[0]).toHaveProperty("reason");
  });

  it("returns default mods for unknown role string", () => {
    const recs = getModRecommendations("diplomat");
    // diplomat not in ROLE_MOD_PRIORITIES → default
    expect(recs.length).toBeGreaterThan(0);
  });

  it("each recommendation has required fields", () => {
    for (const [, recs] of Object.entries(ROLE_MOD_PRIORITIES)) {
      for (const rec of recs) {
        expect(typeof rec.mod_type).toBe("string");
        expect(typeof rec.priority).toBe("number");
        expect(typeof rec.reason).toBe("string");
        expect(rec.priority).toBeGreaterThan(0);
      }
    }
  });

  it("priorities are sorted 1, 2, 3 within each role", () => {
    for (const [, recs] of Object.entries(ROLE_MOD_PRIORITIES)) {
      for (let i = 0; i < recs.length; i++) {
        expect(recs[i].priority).toBe(i + 1);
      }
    }
  });
});
