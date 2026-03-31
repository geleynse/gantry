/**
 * Tests for geographic zone assignments.
 *
 * Validates that:
 * - All agents have valid operating zones assigned
 * - No agents have invalid zones
 * - Faction agents use appropriate zones
 */

import { describe, it, expect } from "bun:test";
import { VALID_OPERATING_ZONES } from "../config/constants.js";

/**
 * Mock agent config for testing.
 * In the real fleet-config.json, agents are defined with name, faction, role, operatingZone, etc.
 */
const mockAgents = [
  { name: "drifter-gale", faction: "solarian", operatingZone: "sol-sirius" },
  { name: "sable-thorn", faction: "crimson", operatingZone: "crimson-zones" },
  { name: "rust-vane", faction: "solarian", operatingZone: "sol-sirius" },
  { name: "lumen-shoal", faction: "nebula", operatingZone: "nebula-deep" },
  { name: "cinder-wake", faction: "solarian", operatingZone: "sol-sirius" },
];

describe("Zone Assignments", () => {
  it("should have VALID_OPERATING_ZONES constant defined", () => {
    expect(VALID_OPERATING_ZONES).toBeDefined();
    expect(VALID_OPERATING_ZONES.length).toBeGreaterThan(0);
  });

  it("should include all expected zones", () => {
    const zones = [...VALID_OPERATING_ZONES];
    expect(zones).toContain("sol-sirius");
    expect(zones).toContain("crimson-zones");
    expect(zones).toContain("nebula-deep");
    expect(zones).toContain("outback-fringe");
    expect(zones).toContain("colonial-hub");
    expect(zones.length).toBe(5);
  });

  it("should assign operatingZone to all agents", () => {
    mockAgents.forEach((agent) => {
      expect(agent.operatingZone).toBeDefined();
      expect(typeof agent.operatingZone).toBe("string");
    });
  });

  it("should only assign valid zones", () => {
    mockAgents.forEach((agent) => {
      expect(VALID_OPERATING_ZONES).toContain(agent.operatingZone as any);
    });
  });

  it("should assign Solarian agents to sol-sirius", () => {
    const solarianAgents = mockAgents.filter((a) => a.faction === "solarian");
    expect(solarianAgents.length).toBeGreaterThan(0);
    solarianAgents.forEach((agent) => {
      expect(agent.operatingZone).toBe("sol-sirius");
    });
  });

  it("should assign Crimson agents to crimson-zones", () => {
    const crimsonAgents = mockAgents.filter((a) => a.faction === "crimson");
    expect(crimsonAgents.length).toBeGreaterThan(0);
    crimsonAgents.forEach((agent) => {
      expect(agent.operatingZone).toBe("crimson-zones");
    });
  });

  it("should assign Nebula agents to nebula-deep", () => {
    const nebulaAgents = mockAgents.filter((a) => a.faction === "nebula");
    expect(nebulaAgents.length).toBeGreaterThan(0);
    nebulaAgents.forEach((agent) => {
      expect(agent.operatingZone).toBe("nebula-deep");
    });
  });

  it("should have zone assignments that match faction boundaries", () => {
    const zoneToFactions = new Map<string, Set<string>>();

    mockAgents.forEach((agent) => {
      if (!zoneToFactions.has(agent.operatingZone)) {
        zoneToFactions.set(agent.operatingZone, new Set());
      }
      zoneToFactions.get(agent.operatingZone)!.add(agent.faction);
    });

    // Verify that each zone is assigned to consistent factions
    // (sol-sirius should only have solarian, crimson-zones only crimson, etc.)
    expect(zoneToFactions.get("sol-sirius")).toEqual(new Set(["solarian"]));
    expect(zoneToFactions.get("crimson-zones")).toEqual(new Set(["crimson"]));
    expect(zoneToFactions.get("nebula-deep")).toEqual(new Set(["nebula"]));
  });

  it("should not assign agents to unused zones (for now)", () => {
    const assignedZones = new Set(mockAgents.map((a) => a.operatingZone));

    // These zones exist but are unassigned in the current fleet
    expect(assignedZones.has("outback-fringe")).toBe(false);
    expect(assignedZones.has("colonial-hub")).toBe(false);
  });

  it("should have exactly 5 agents assigned", () => {
    expect(mockAgents.length).toBe(5);
  });

  it("should have no duplicate zone assignments within same faction", () => {
    const factionZones = new Map<string, string[]>();

    mockAgents.forEach((agent) => {
      if (!factionZones.has(agent.faction)) {
        factionZones.set(agent.faction, []);
      }
      factionZones.get(agent.faction)!.push(agent.operatingZone);
    });

    // Within each faction, all agents should be in the same zone
    factionZones.forEach((zones, faction) => {
      const uniqueZones = new Set(zones);
      expect(uniqueZones.size).toBe(1);
    });
  });
});
