import { describe, it, expect } from "bun:test";
import { missionCheckRoutine } from "./mission-check.js";
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

describe("mission_check routine", () => {
  describe("parseParams", () => {
    it("parses valid params with all fields", () => {
      const p = missionCheckRoutine.parseParams({
        station: "sirius_station",
        role_filter: ["bounty", "cargo"],
        max_accept: 5,
      });
      expect(p.station).toBe("sirius_station");
      expect(p.role_filter).toEqual(["bounty", "cargo"]);
      expect(p.max_accept).toBe(5);
    });

    it("uses defaults for all optional fields", () => {
      const p = missionCheckRoutine.parseParams({});
      expect(p.station).toBeUndefined();
      expect(p.role_filter).toBeUndefined();
      expect(p.max_accept).toBeUndefined();
    });

    it("parses params with only station", () => {
      const p = missionCheckRoutine.parseParams({ station: "test_station" });
      expect(p.station).toBe("test_station");
      expect(p.role_filter).toBeUndefined();
      expect(p.max_accept).toBeUndefined();
    });

    it("parses params with only role_filter", () => {
      const p = missionCheckRoutine.parseParams({ role_filter: ["cargo"] });
      expect(p.role_filter).toEqual(["cargo"]);
      expect(p.station).toBeUndefined();
      expect(p.max_accept).toBeUndefined();
    });

    it("rejects invalid station (empty string)", () => {
      expect(() => missionCheckRoutine.parseParams({ station: "" })).toThrow("station must be a non-empty string");
    });

    it("rejects invalid role_filter (not array)", () => {
      expect(() => missionCheckRoutine.parseParams({ role_filter: "cargo" })).toThrow(
        "role_filter must be an array",
      );
    });

    it("rejects invalid max_accept (negative)", () => {
      expect(() => missionCheckRoutine.parseParams({ max_accept: -1 })).toThrow(
        "max_accept must be a non-negative number",
      );
    });

    it("rejects invalid max_accept (non-number)", () => {
      expect(() => missionCheckRoutine.parseParams({ max_accept: "5" })).toThrow(
        "max_accept must be a non-negative number",
      );
    });
  });

  describe("run", () => {
    it("completes missions and accepts new ones", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(
        async (tool, args) => {
          toolsCalled.push(tool);
          if (tool === "travel_to") return { result: { status: "completed" } };
          if (tool === "dock") return { result: { status: "docked" } };
          if (tool === "get_active_missions") {
            return {
              result: [
                { id: "mission_1", progress: 100 },
                { id: "mission_2", progress: 50 },
              ],
            };
          }
          if (tool === "complete_mission") {
            const missionId = args?.mission_id as string;
            return { result: { mission_id: missionId, credits_earned: 500 } };
          }
          if (tool === "get_missions") {
            return {
              result: [
                { id: "new_1", type: "cargo" },
                { id: "new_2", type: "bounty" },
              ],
            };
          }
          if (tool === "accept_mission") {
            const missionId = args?.mission_id as string;
            return { result: { mission_id: missionId, accepted: true } };
          }
          return { result: {} };
        },
        { player: { current_poi: "sol_belt" } },
      );

      const result = await missionCheckRoutine.run(ctx, {
        station: "sirius_station",
        max_accept: 3,
      });

      expect(result.status).toBe("completed");
      expect(result.data.missions_completed_count).toBe(1);
      expect(result.data.missions_completed).toEqual(["mission_1"]);
      expect(result.data.missions_accepted_count).toBe(2);
      expect(result.data.missions_accepted).toEqual(["new_1", "new_2"]);
      expect(result.data.credits_earned).toBe(500);
      expect(result.summary).toContain("Completed 1 mission");
      expect(result.summary).toContain("Accepted 2 mission");
      expect(toolsCalled).toContain("travel_to");
      expect(toolsCalled).toContain("dock");
      expect(toolsCalled).toContain("complete_mission");
      expect(toolsCalled).toContain("accept_mission");
    });

    it("respects max_accept limit", async () => {
      const toolsCalled: string[] = [];
      const acceptedMissions: string[] = [];
      const ctx = mockContext(
        async (tool, args) => {
          toolsCalled.push(tool);
          if (tool === "get_active_missions") return { result: [] };
          if (tool === "get_missions") {
            return {
              result: [
                { id: "new_1", type: "cargo" },
                { id: "new_2", type: "cargo" },
                { id: "new_3", type: "cargo" },
                { id: "new_4", type: "cargo" },
              ],
            };
          }
          if (tool === "accept_mission") {
            acceptedMissions.push(args?.mission_id as string);
            return { result: { mission_id: args?.mission_id, accepted: true } };
          }
          return { result: {} };
        },
        { player: { current_poi: "sirius_station", docked_at_base: "sirius_base" } },
      );

      const result = await missionCheckRoutine.run(ctx, { max_accept: 2 });

      expect(result.status).toBe("completed");
      expect(result.data.missions_accepted_count).toBe(2);
      expect(acceptedMissions).toEqual(["new_1", "new_2"]);
    });

    it("filters missions by role", async () => {
      const acceptedMissions: string[] = [];
      const ctx = mockContext(
        async (tool, args) => {
          if (tool === "get_active_missions") return { result: [] };
          if (tool === "get_missions") {
            return {
              result: [
                { id: "cargo_1", type: "cargo" },
                { id: "bounty_1", type: "bounty" },
                { id: "cargo_2", type: "cargo" },
              ],
            };
          }
          if (tool === "accept_mission") {
            acceptedMissions.push(args?.mission_id as string);
            return { result: { mission_id: args?.mission_id, accepted: true } };
          }
          return { result: {} };
        },
        { player: { current_poi: "sirius_station", docked_at_base: "sirius_base" } },
      );

      const result = await missionCheckRoutine.run(ctx, { role_filter: ["cargo"], max_accept: 5 });

      expect(result.status).toBe("completed");
      expect(result.data.missions_accepted_count).toBe(2);
      expect(acceptedMissions).toEqual(["cargo_1", "cargo_2"]);
    });

    it("skips when no missions available", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(
        async (tool) => {
          toolsCalled.push(tool);
          if (tool === "get_active_missions") return { result: [] };
          if (tool === "get_missions") return { result: [] };
          return { result: {} };
        },
        { player: { current_poi: "sirius_station", docked_at_base: "sirius_base" } },
      );

      const result = await missionCheckRoutine.run(ctx, {});

      expect(result.status).toBe("completed");
      expect(result.data.missions_completed_count).toBe(0);
      expect(result.data.missions_accepted_count).toBe(0);
      expect(result.summary).toContain("No missions completed or accepted");
    });

    it("skips travel and dock when already docked at station", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(
        async (tool) => {
          toolsCalled.push(tool);
          if (tool === "get_active_missions") return { result: [] };
          if (tool === "get_missions") return { result: [] };
          return { result: {} };
        },
        { player: { current_poi: "sirius_station", docked_at_base: "sirius_base" } },
      );

      const result = await missionCheckRoutine.run(ctx, { station: "sirius_station" });

      expect(result.status).toBe("completed");
      expect(toolsCalled).not.toContain("travel_to");
      expect(toolsCalled).not.toContain("dock");
    });

    it("hands off when travel fails", async () => {
      const ctx = mockContext(
        async (tool) => {
          if (tool === "travel_to") return { error: "blocked" };
          return { result: {} };
        },
        { player: { current_poi: "sol_belt" } },
      );

      const result = await missionCheckRoutine.run(ctx, { station: "sirius_station" });

      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("Travel to sirius_station failed");
    });

    it("hands off when dock fails", async () => {
      const ctx = mockContext(
        async (tool) => {
          if (tool === "travel_to") return { result: { status: "completed" } };
          if (tool === "dock") return { error: { code: "dock_blocked", message: "Bay full" } };
          return { result: {} };
        },
        { player: { current_poi: "sol_belt" } },
      );

      const result = await missionCheckRoutine.run(ctx, { station: "sirius_station" });

      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("Could not dock");
    });

    it("completes multiple missions with accumulated credits", async () => {
      const ctx = mockContext(
        async (tool) => {
          if (tool === "get_active_missions") {
            return {
              result: [
                { id: "m1", progress: 100 },
                { id: "m2", progress: 100 },
              ],
            };
          }
          if (tool === "complete_mission") {
            const missionId = (tool === "complete_mission" ? true : false) ? "m1" : "m2";
            return { result: { mission_id: missionId, credits_earned: 250 } };
          }
          if (tool === "get_missions") return { result: [] };
          return { result: {} };
        },
        { player: { current_poi: "sirius_station", docked_at_base: "sirius_base" } },
      );

      const result = await missionCheckRoutine.run(ctx, {});

      expect(result.status).toBe("completed");
      expect(result.data.missions_completed_count).toBe(2);
      expect(result.data.credits_earned).toBe(500);
    });
  });
});
