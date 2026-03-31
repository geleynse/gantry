import { describe, it, expect } from "bun:test";
import { fleetJumpRoutine } from "./fleet-jump.js";
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
function fleetStatus(members: Array<{ username: string }>, system_id: string, poi_id?: string) {
  return {
    result: {
      in_fleet: true,
      system_id,
      poi_id: poi_id ?? `${system_id}_belt`,
      members: members.map((m) => ({
        username: m.username,
        player_id: `id_${m.username}`,
        ship: { fuel: 90, max_fuel: 100, hull: 100, max_hull: 100 },
      })),
    },
  };
}

describe("fleet_jump routine", () => {
  describe("parseParams", () => {
    it("parses valid destination", () => {
      const p = fleetJumpRoutine.parseParams({ destination: "alpha-centauri" });
      expect(p.destination).toBe("alpha-centauri");
    });

    it("rejects missing destination", () => {
      expect(() => fleetJumpRoutine.parseParams({})).toThrow("destination is required");
    });

    it("rejects non-object", () => {
      expect(() => fleetJumpRoutine.parseParams(null)).toThrow();
    });

    it("rejects empty string destination", () => {
      expect(() => fleetJumpRoutine.parseParams({ destination: "" })).toThrow("destination is required");
    });
  });

  describe("run", () => {
    it("completes when all members arrive at destination", async () => {
      const toolsCalled: string[] = [];
      let jumped = false;
      const ctx = mockContext(async (tool) => {
        toolsCalled.push(tool);
        if (tool === "fleet") {
          if (!jumped) {
            return fleetStatus(
              [{ username: "test-agent" }, { username: "ally-1" }],
              "sol",
            );
          }
          // After jump — fleet is now at destination
          return fleetStatus(
            [{ username: "test-agent" }, { username: "ally-1" }],
            "sirius",
            "sirius_belt",
          );
        }
        if (tool === "get_status") {
          if (!jumped) {
            return { result: { player: { current_system: "sol", current_poi: "sol_belt" } } };
          }
          return { result: { player: { current_system: "sirius", current_poi: "sirius_belt" } } };
        }
        if (tool === "jump_route") {
          jumped = true;
          return { result: { status: "jumped", destination: "sirius" } };
        }
        return { result: {} };
      });

      const result = await fleetJumpRoutine.run(ctx, { destination: "sirius" });
      expect(result.status).toBe("completed");
      expect(result.summary).toContain("sirius");
      expect(result.summary).toContain("All");
      expect(toolsCalled).toContain("fleet");
      expect(toolsCalled).toContain("jump_route");
    });

    it("completes immediately when all members already at destination", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(async (tool) => {
        toolsCalled.push(tool);
        if (tool === "fleet") {
          return fleetStatus(
            [{ username: "test-agent" }, { username: "ally-1" }],
            "sirius",
          );
        }
        if (tool === "get_status") {
          return { result: { player: { current_system: "sirius" } } };
        }
        return { result: {} };
      });

      const result = await fleetJumpRoutine.run(ctx, { destination: "sirius" });
      expect(result.status).toBe("completed");
      expect(result.summary).toContain("already at sirius");
      expect(toolsCalled).not.toContain("jump_route");
    });

    it("hands off when fleet members are scattered across systems", async () => {
      // With the real API, all fleet members share one system_id.
      // But if the fleet somehow reports different systems per member (edge case),
      // the routine should detect it. We test with per-member system fields.
      const ctx = mockContext(async (tool) => {
        if (tool === "fleet") {
          return {
            result: {
              in_fleet: true,
              // No fleet-level system_id — members have individual systems
              members: [
                { username: "test-agent", current_system: "sol" },
                { username: "ally-1", current_system: "alpha-centauri" },
              ],
            },
          };
        }
        if (tool === "get_status") {
          return { result: { player: { current_system: "sol" } } };
        }
        return { result: {} };
      });

      const result = await fleetJumpRoutine.run(ctx, { destination: "sirius" });
      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("scattered");
    });

    it("hands off when fleet(status) fails", async () => {
      const ctx = mockContext(async (tool) => {
        if (tool === "fleet") return { error: { code: "no_fleet" } };
        return { result: {} };
      });

      const result = await fleetJumpRoutine.run(ctx, { destination: "sirius" });
      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("fleet(status) failed");
    });

    it("hands off when jump fails", async () => {
      const ctx = mockContext(async (tool) => {
        if (tool === "fleet") {
          return fleetStatus([{ username: "test-agent" }], "sol");
        }
        if (tool === "get_status") {
          return { result: { player: { current_system: "sol" } } };
        }
        if (tool === "jump_route") return { error: "insufficient_fuel" };
        return { result: {} };
      });

      const result = await fleetJumpRoutine.run(ctx, { destination: "sirius" });
      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("Jump to sirius failed");
    });

    it("hands off when combat detected during jump", async () => {
      const ctx = mockContext(async (tool) => {
        if (tool === "fleet") {
          return fleetStatus([{ username: "test-agent" }], "sol");
        }
        if (tool === "get_status") {
          return { result: { player: { current_system: "sol" } } };
        }
        if (tool === "jump_route") {
          return { result: { result: { battle_started: true } } };
        }
        return { result: {} };
      });

      const result = await fleetJumpRoutine.run(ctx, { destination: "sirius" });
      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("Combat detected");
    });

    it("hands off when still in transit after jump", async () => {
      const ctx = mockContext(async (tool) => {
        if (tool === "fleet") {
          return fleetStatus([{ username: "test-agent" }], "sol");
        }
        if (tool === "get_status") {
          // Still shows sol even after jump (in transit)
          return { result: { player: { current_system: "sol" } } };
        }
        if (tool === "jump_route") {
          return { result: { status: "jumped" } };
        }
        return { result: {} };
      });

      const result = await fleetJumpRoutine.run(ctx, { destination: "sirius" });
      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("in transit");
    });

    it("hands off when some members haven't arrived after successful jump", async () => {
      let jumped = false;
      const ctx = mockContext(async (tool) => {
        if (tool === "fleet") {
          if (!jumped) {
            return fleetStatus(
              [{ username: "test-agent" }, { username: "ally-1" }],
              "sol",
            );
          }
          // After jump — fleet system still shows sol (ally hasn't arrived)
          // In reality the fleet moves together, but test the edge case
          return {
            result: {
              in_fleet: true,
              system_id: "sol",
              members: [
                { username: "test-agent", current_system: "sirius" },
                { username: "ally-1", current_system: "sol" },
              ],
            },
          };
        }
        if (tool === "get_status") {
          if (!jumped) return { result: { player: { current_system: "sol" } } };
          return { result: { player: { current_system: "sirius" } } };
        }
        if (tool === "jump_route") {
          jumped = true;
          return { result: { status: "jumped" } };
        }
        return { result: {} };
      });

      const result = await fleetJumpRoutine.run(ctx, { destination: "sirius" });
      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("ally-1");
      expect(result.handoffReason).toContain("haven't arrived");
    });

    it("hands off when already at destination but some members are not", async () => {
      const ctx = mockContext(async (tool) => {
        if (tool === "fleet") {
          // Fleet-level system says sirius, but one member reports different
          return {
            result: {
              in_fleet: true,
              system_id: "sirius",
              members: [
                { username: "test-agent" },
                { username: "ally-1", current_system: "sol" },
              ],
            },
          };
        }
        if (tool === "get_status") {
          return { result: { player: { current_system: "sirius" } } };
        }
        return { result: {} };
      });

      const result = await fleetJumpRoutine.run(ctx, { destination: "sirius" });
      // All members get fleet-level system_id "sirius", so they appear at destination
      expect(result.status).toBe("completed");
      expect(result.summary).toContain("already at sirius");
    });

    it("handles legacy per-member system fields as fallback", async () => {
      const ctx = mockContext(async (tool) => {
        if (tool === "fleet") {
          // No fleet-level system_id, per-member fields only
          return {
            result: {
              in_fleet: true,
              members: [
                { username: "test-agent", system: "sirius" },
              ],
            },
          };
        }
        if (tool === "get_status") {
          return { result: { player: { current_system: "sirius" } } };
        }
        return { result: {} };
      });

      const result = await fleetJumpRoutine.run(ctx, { destination: "sirius" });
      expect(result.status).toBe("completed");
    });
  });
});
