/**
 * Tests for MCP preset per role tool filtering (#214).
 */

import { describe, it, expect } from "bun:test";
import { getToolsForRolePreset } from "./fleet.js";

const SAMPLE_PRESETS: Record<string, string[]> = {
  combat: ["spacemolt", "spacemolt_ship", "spacemolt_social", "spacemolt_catalog"],
  hauler: ["spacemolt", "spacemolt_market", "spacemolt_storage", "spacemolt_social"],
  explorer: ["spacemolt", "spacemolt_social", "spacemolt_catalog"],
  trader: ["spacemolt", "spacemolt_market", "spacemolt_storage", "spacemolt_social", "spacemolt_catalog"],
  standard: ["spacemolt", "spacemolt_social", "spacemolt_ship", "spacemolt_market", "spacemolt_storage", "spacemolt_catalog"],
};

describe("getToolsForRolePreset (#214)", () => {
  it("returns tools for a known roleType", () => {
    const tools = getToolsForRolePreset(SAMPLE_PRESETS, "combat");
    expect(tools).not.toBeNull();
    expect(tools!).toContain("spacemolt");
    expect(tools!).toContain("spacemolt_ship");
    expect(tools!).toContain("spacemolt_social");
    // combat preset does NOT include market/storage
    expect(tools!).not.toContain("spacemolt_market");
    expect(tools!).not.toContain("spacemolt_storage");
  });

  it("always includes login and logout regardless of preset", () => {
    const tools = getToolsForRolePreset(SAMPLE_PRESETS, "explorer");
    expect(tools).not.toBeNull();
    expect(tools!).toContain("login");
    expect(tools!).toContain("logout");
  });

  it("falls back to standard when roleType has no specific preset", () => {
    const tools = getToolsForRolePreset(SAMPLE_PRESETS, "unknown-role");
    const standard = getToolsForRolePreset(SAMPLE_PRESETS, "standard");
    expect(tools).not.toBeNull();
    // Should match standard preset (plus login/logout which standard already gets)
    expect(new Set(tools!)).toEqual(new Set(standard!));
  });

  it("returns null when no mcpPresets are defined (no filtering)", () => {
    const tools = getToolsForRolePreset(undefined, "combat");
    expect(tools).toBeNull();
  });

  it("returns null when roleType is undefined and no standard preset exists", () => {
    const tools = getToolsForRolePreset({}, undefined);
    expect(tools).toBeNull();
  });

  it("hauler preset includes market and storage", () => {
    const tools = getToolsForRolePreset(SAMPLE_PRESETS, "hauler");
    expect(tools!).toContain("spacemolt_market");
    expect(tools!).toContain("spacemolt_storage");
    // hauler does not need ship or catalog
    expect(tools!).not.toContain("spacemolt_ship");
    expect(tools!).not.toContain("spacemolt_catalog");
  });

  it("standard preset includes all major tool groups", () => {
    const tools = getToolsForRolePreset(SAMPLE_PRESETS, "standard");
    expect(tools!).toContain("spacemolt");
    expect(tools!).toContain("spacemolt_social");
    expect(tools!).toContain("spacemolt_ship");
    expect(tools!).toContain("spacemolt_market");
    expect(tools!).toContain("spacemolt_storage");
    expect(tools!).toContain("spacemolt_catalog");
  });
});
