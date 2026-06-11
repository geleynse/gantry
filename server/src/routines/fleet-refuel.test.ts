import { describe, it, expect } from "bun:test";
import { fleetRefuelRoutine } from "./fleet-refuel.js";
import type { RoutineContext } from "./types.js";

type ToolHandler = (tool: string, args?: Record<string, unknown>) => Promise<{ result?: unknown; error?: unknown }>;

function mockContext(toolHandler: ToolHandler, cacheData?: Record<string, unknown>): RoutineContext {
  const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
  if (cacheData) {
    statusCache.set("test-agent", { data: cacheData, fetchedAt: Date.now() });
  }
  return {
    agentName: "test-agent",
    client: { execute: toolHandler, waitForTick: async () => {} },
    statusCache,
    log: () => {},
  };
}

// Helper to build fleet status response matching real game API shape
function fleetStatus(members: Array<{ username: string; fuel: number; max_fuel: number }>, opts?: { poi_id?: string; system_id?: string }) {
  return {
    result: {
      in_fleet: true,
      poi_id: opts?.poi_id ?? "sol_station",
      system_id: opts?.system_id ?? "sol",
      members: members.map((m) => ({
        username: m.username,
        player_id: `id_${m.username}`,
        ship: { fuel: m.fuel, max_fuel: m.max_fuel, hull: 100, max_hull: 100 },
      })),
    },
  };
}

describe("fleet_refuel routine", () => {
  describe("parseParams", () => {
    it("parses valid params with station", () => {
      const p = fleetRefuelRoutine.parseParams({ station: "sol_station" });
      expect(p.station).toBe("sol_station");
    });

    it("accepts empty object (station is optional)", () => {
      const p = fleetRefuelRoutine.parseParams({});
      expect(p.station).toBeUndefined();
    });

    it("accepts null/undefined (defaults to empty params)", () => {
      const p = fleetRefuelRoutine.parseParams(null);
      expect(p.station).toBeUndefined();
    });
  });

  describe("run", () => {
    it("refuels self and reports all members healthy when fleet fuel is fine", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(async (tool) => {
        toolsCalled.push(tool);
        if (tool === "spacemolt_fleet") {
          return fleetStatus([
            { username: "test-agent", fuel: 90, max_fuel: 100 },
            { username: "ally-1", fuel: 85, max_fuel: 100 },
          ]);
        }
        if (tool === "get_status") {
          return {
            result: {
              player: { current_poi: "sol_station", docked_at_base: "sol_base" },
              ship: { fuel: 90, fuel_max: 100 },
            },
          };
        }
        // Bunker check — no room so no deposit
        if (tool === "view_faction_storage") {
          return { result: { fuel_bunker_has_room: false } };
        }
        return { result: {} };
      });

      const result = await fleetRefuelRoutine.run(ctx, { station: "sol_station" });
      expect(result.status).toBe("completed");
      expect(result.summary).toContain("sufficient fuel");
      expect(result.data.self_refueled).toBe(false);
      expect(toolsCalled).toContain("spacemolt_fleet");
      expect(toolsCalled).toContain("get_status");
      expect(toolsCalled).not.toContain("refuel");
    });

    it("refuels self when own fuel is low and all fleet members have enough (no faction bunker)", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(async (tool, args) => {
        toolsCalled.push(tool);
        if (tool === "spacemolt_fleet") {
          return fleetStatus([
            { username: "test-agent", fuel: 30, max_fuel: 100 },
            { username: "ally-1", fuel: 90, max_fuel: 100 },
          ]);
        }
        if (tool === "get_status") {
          return {
            result: {
              player: { current_poi: "sol_station", docked_at_base: "sol_base" },
              ship: { fuel: 30, fuel_max: 100 },
            },
          };
        }
        // Simulate no faction bunker at this station
        if (tool === "spacemolt_storage" && (args as any)?.action === "withdraw") {
          return { error: { code: "no_bunker", message: "No faction fuel bunker" } };
        }
        if (tool === "refuel") return { result: { fuel_after: 100 } };
        return { result: {} };
      });

      const result = await fleetRefuelRoutine.run(ctx, { station: "sol_station" });
      expect(result.status).toBe("completed");
      expect(result.data.self_refueled).toBe(true);
      expect(result.data.used_faction_bunker).toBe(false);
      expect(toolsCalled).toContain("refuel");
    });

    it("hands off when other fleet members need fuel", async () => {
      const ctx = mockContext(async (tool) => {
        if (tool === "spacemolt_fleet") {
          return fleetStatus([
            { username: "test-agent", fuel: 90, max_fuel: 100 },
            { username: "ally-low", fuel: 20, max_fuel: 100 },
          ]);
        }
        if (tool === "get_status") {
          return {
            result: {
              player: { current_poi: "sol_station", docked_at_base: "sol_base" },
              ship: { fuel: 90, fuel_max: 100 },
            },
          };
        }
        // Bunker: no room so no deposit
        if (tool === "view_faction_storage") {
          return { result: { fuel_bunker_has_room: false } };
        }
        return { result: {} };
      });

      const result = await fleetRefuelRoutine.run(ctx, { station: "sol_station" });
      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("ally-low");
      expect(result.handoffReason).toContain("still need fuel");
      expect((result.data.members_needing_fuel as any[]).length).toBe(1);
    });

    it("hands off when fleet(status) fails (not in fleet)", async () => {
      const ctx = mockContext(async (tool) => {
        if (tool === "spacemolt_fleet") return { error: { code: "no_fleet", message: "Not in a fleet" } };
        return { result: {} };
      });

      const result = await fleetRefuelRoutine.run(ctx, {});
      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("spacemolt_fleet(status) failed");
    });

    it("travels to station when not already there", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(async (tool) => {
        toolsCalled.push(tool);
        if (tool === "spacemolt_fleet") {
          return fleetStatus(
            [{ username: "test-agent", fuel: 90, max_fuel: 100 }],
            { poi_id: "asteroid_belt", system_id: "sol" },
          );
        }
        if (tool === "get_status") {
          return {
            result: {
              player: { current_poi: "asteroid_belt" },
              ship: { fuel: 90, fuel_max: 100 },
            },
          };
        }
        if (tool === "travel_to") return { result: { status: "completed" } };
        if (tool === "dock") return { result: { status: "docked" } };
        // Bunker: no room
        if (tool === "view_faction_storage") {
          return { result: { fuel_bunker_has_room: false } };
        }
        return { result: {} };
      });

      const result = await fleetRefuelRoutine.run(ctx, { station: "sol_station" });
      expect(result.status).toBe("completed");
      expect(toolsCalled).toContain("travel_to");
      expect(toolsCalled).toContain("dock");
    });

    it("hands off when travel fails", async () => {
      const ctx = mockContext(async (tool) => {
        if (tool === "spacemolt_fleet") {
          return fleetStatus(
            [{ username: "test-agent", fuel: 50, max_fuel: 100 }],
            { poi_id: "deep_space" },
          );
        }
        if (tool === "get_status") {
          return {
            result: {
              player: { current_poi: "deep_space" },
              ship: { fuel: 50, fuel_max: 100 },
            },
          };
        }
        if (tool === "travel_to") return { error: "route_blocked" };
        return { result: {} };
      });

      const result = await fleetRefuelRoutine.run(ctx, { station: "sol_station" });
      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("Travel to sol_station failed");
    });

    it("uses current station when no station param provided and docked", async () => {
      const ctx = mockContext(async (tool) => {
        if (tool === "spacemolt_fleet") {
          return fleetStatus(
            [{ username: "test-agent", fuel: 95, max_fuel: 100 }],
            { poi_id: "mars_dock" },
          );
        }
        if (tool === "get_status") {
          return {
            result: {
              player: { current_poi: "mars_dock", docked_at_base: "mars_dock" },
              ship: { fuel: 95, fuel_max: 100 },
            },
          };
        }
        if (tool === "view_faction_storage") {
          return { result: { fuel_bunker_has_room: false } };
        }
        return { result: {} };
      });

      const result = await fleetRefuelRoutine.run(ctx, {});
      expect(result.status).toBe("completed");
      expect(result.data.station).toBe("mars_dock");
    });

    it("handles legacy top-level fuel fields as fallback", async () => {
      const ctx = mockContext(async (tool) => {
        if (tool === "spacemolt_fleet") {
          // Legacy shape without ship sub-object
          return {
            result: {
              members: [
                { username: "test-agent", fuel: 90, fuel_max: 100 },
              ],
              poi_id: "sol_hub",
              system_id: "sol",
            },
          };
        }
        if (tool === "get_status") {
          return {
            result: {
              player: { current_poi: "sol_hub", docked_at_base: "sol_hub" },
              ship: { fuel: 90, fuel_max: 100 },
            },
          };
        }
        if (tool === "view_faction_storage") {
          return { result: { fuel_bunker_has_room: false } };
        }
        return { result: {} };
      });

      const result = await fleetRefuelRoutine.run(ctx, { station: "sol_hub" });
      expect(result.status).toBe("completed");
    });

    it("does not count self in othersNeedFuel when self needs fuel", async () => {
      const ctx = mockContext(async (tool) => {
        if (tool === "spacemolt_fleet") {
          return fleetStatus([{ username: "test-agent", fuel: 30, max_fuel: 100 }]);
        }
        if (tool === "get_status") {
          return {
            result: {
              player: { current_poi: "sol_station", docked_at_base: "sol_base" },
              ship: { fuel: 30, fuel_max: 100 },
            },
          };
        }
        // Faction bunker unavailable → fall back to paid refuel
        if (tool === "spacemolt_storage") return { error: { code: "no_bunker" } };
        if (tool === "refuel") return { result: { fuel_after: 100 } };
        return { result: {} };
      });

      // Only self needs fuel — should complete, not handoff
      const result = await fleetRefuelRoutine.run(ctx, { station: "sol_station" });
      expect(result.status).toBe("completed");
      expect(result.data.self_refueled).toBe(true);
    });

    // --- Faction bunker tests (v0.334.0) ---

    it("refuels from faction bunker when available and marks used_faction_bunker=true", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(async (tool, args) => {
        toolsCalled.push(tool);
        if (tool === "spacemolt_fleet") {
          return fleetStatus([{ username: "test-agent", fuel: 30, max_fuel: 100 }]);
        }
        if (tool === "get_status") {
          return {
            result: {
              player: { current_poi: "sol_station", docked_at_base: "sol_base" },
              ship: { fuel: 30, fuel_max: 100 },
            },
          };
        }
        // Faction bunker withdraw succeeds
        if (tool === "spacemolt_storage" && (args as any)?.action === "withdraw") {
          return { result: { fuel_added: 70, fuel_after: 100 } };
        }
        // view_faction_storage: bunker has no room (so no deposit attempt)
        if (tool === "view_faction_storage") {
          return { result: { fuel_bunker_has_room: false } };
        }
        return { result: {} };
      });

      const result = await fleetRefuelRoutine.run(ctx, { station: "sol_station" });
      expect(result.status).toBe("completed");
      expect(result.data.self_refueled).toBe(true);
      expect(result.data.used_faction_bunker).toBe(true);
      expect(toolsCalled).toContain("spacemolt_storage");
      // Should NOT have called paid refuel
      expect(toolsCalled).not.toContain("refuel");
    });

    it("falls back to paid refuel when faction bunker withdraw fails", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(async (tool, args) => {
        toolsCalled.push(tool);
        if (tool === "spacemolt_fleet") {
          return fleetStatus([{ username: "test-agent", fuel: 30, max_fuel: 100 }]);
        }
        if (tool === "get_status") {
          return {
            result: {
              player: { current_poi: "sol_station", docked_at_base: "sol_base" },
              ship: { fuel: 30, fuel_max: 100 },
            },
          };
        }
        // Faction bunker withdraw fails
        if (tool === "spacemolt_storage" && (args as any)?.action === "withdraw") {
          return { error: { code: "no_bunker", message: "No faction fuel bunker at this station" } };
        }
        // Paid refuel succeeds
        if (tool === "refuel") return { result: { fuel_after: 100 } };
        return { result: {} };
      });

      const result = await fleetRefuelRoutine.run(ctx, { station: "sol_station" });
      expect(result.status).toBe("completed");
      expect(result.data.self_refueled).toBe(true);
      expect(result.data.used_faction_bunker).toBe(false);
      expect(toolsCalled).toContain("refuel");
    });

    it("deposits spare fuel into faction bunker when tank is full and bunker has room", async () => {
      const toolsCalled: string[] = [];
      const depositArgs: Record<string, unknown>[] = [];
      const ctx = mockContext(async (tool, args) => {
        toolsCalled.push(tool);
        if (tool === "spacemolt_fleet") {
          // Agent is already at 95% fuel — above threshold, no self-refuel needed
          return fleetStatus([{ username: "test-agent", fuel: 95, max_fuel: 100 }]);
        }
        if (tool === "get_status") {
          return {
            result: {
              player: { current_poi: "sol_station", docked_at_base: "sol_base" },
              ship: { fuel: 95, fuel_max: 100 },
            },
          };
        }
        // view_faction_storage: bunker has room
        if (tool === "view_faction_storage") {
          return { result: { fuel_bunker_has_room: true, fuel_bunker_capacity_remaining: 200 } };
        }
        if (tool === "spacemolt_storage" && (args as any)?.action === "deposit") {
          depositArgs.push(args as Record<string, unknown>);
          return { result: { fuel_deposited: 5 } };
        }
        return { result: {} };
      });

      const result = await fleetRefuelRoutine.run(ctx, { station: "sol_station" });
      expect(result.status).toBe("completed");
      // Self-refuel not needed (fuel >= 80%)
      expect(result.data.self_refueled).toBe(false);
      // Bunker deposit was attempted
      expect(toolsCalled).toContain("spacemolt_storage");
      expect(depositArgs.length).toBeGreaterThan(0);
      expect(depositArgs[0]).toMatchObject({ action: "deposit", target: "faction", item_id: "fuel" });
    });

    it("skips bunker deposit when view_faction_storage shows no room", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(async (tool) => {
        toolsCalled.push(tool);
        if (tool === "spacemolt_fleet") {
          return fleetStatus([{ username: "test-agent", fuel: 95, max_fuel: 100 }]);
        }
        if (tool === "get_status") {
          return {
            result: {
              player: { current_poi: "sol_station", docked_at_base: "sol_base" },
              ship: { fuel: 95, fuel_max: 100 },
            },
          };
        }
        // Bunker is full (no room)
        if (tool === "view_faction_storage") {
          return { result: { fuel_bunker_has_room: false } };
        }
        return { result: {} };
      });

      const result = await fleetRefuelRoutine.run(ctx, { station: "sol_station" });
      expect(result.status).toBe("completed");
      // spacemolt_storage deposit should NOT have been called
      const depositCalls = toolsCalled.filter(t => t === "spacemolt_storage");
      expect(depositCalls.length).toBe(0);
    });

    it("mentions faction bunker in handoff when other members need fuel", async () => {
      const ctx = mockContext(async (tool, args) => {
        if (tool === "spacemolt_fleet") {
          return fleetStatus([
            { username: "test-agent", fuel: 95, max_fuel: 100 },
            { username: "ally-low", fuel: 20, max_fuel: 100 },
          ]);
        }
        if (tool === "get_status") {
          return {
            result: {
              player: { current_poi: "sol_station", docked_at_base: "sol_base" },
              ship: { fuel: 95, fuel_max: 100 },
            },
          };
        }
        if (tool === "view_faction_storage") {
          return { result: { fuel_bunker_has_room: true } };
        }
        if (tool === "spacemolt_storage" && (args as any)?.action === "deposit") {
          return { result: { fuel_deposited: 0 } };
        }
        return { result: {} };
      });

      const result = await fleetRefuelRoutine.run(ctx, { station: "sol_station" });
      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("faction");
      expect(result.handoffReason).toContain("ally-low");
    });
  });
});
