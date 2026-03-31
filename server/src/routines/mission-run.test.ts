import { describe, it, expect } from "bun:test";
import { missionRunRoutine } from "./mission-run.js";
import { getTradeMissionCost } from "./routine-utils.js";
import type { RoutineContext } from "./types.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

type ToolHandler = (tool: string, args?: Record<string, unknown>) => Promise<{ result?: unknown; error?: unknown }>;

function mockContext(toolHandler: ToolHandler, cacheData?: Record<string, unknown>): RoutineContext {
  const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
  if (cacheData) {
    statusCache.set("test-agent", { data: cacheData, fetchedAt: Date.now() });
  }
  return {
    agentName: "test-agent",
    client: {
      execute: toolHandler,
      waitForTick: async () => {},
    },
    statusCache,
    log: () => {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mission_run routine", () => {
  describe("parseParams", () => {
    it("parses valid params", () => {
      const params = missionRunRoutine.parseParams({ station: "sol_station" });
      expect(params.station).toBe("sol_station");
    });

    it("rejects missing station", () => {
      expect(() => missionRunRoutine.parseParams({})).toThrow("station is required");
    });

    it("rejects non-object", () => {
      expect(() => missionRunRoutine.parseParams("bad")).toThrow();
    });
  });

  describe("run", () => {
    it("completes missions and accepts new ones", async () => {
      const completedIds: string[] = [];
      const acceptedIds: string[] = [];

      const ctx = mockContext(
        async (tool, args) => {
          if (tool === "get_active_missions") {
            return {
              result: {
                missions: [
                  { id: "m1", progress: 100, type: "mining" },
                  { id: "m2", progress: 50, type: "mining" },
                ],
              },
            };
          }
          if (tool === "complete_mission") {
            completedIds.push(args?.mission_id as string);
            return { result: { credits: 2500 } };
          }
          if (tool === "get_missions") {
            return {
              result: {
                missions: [
                  { id: "m3", type: "mining" },
                  { id: "m4", type: "trading" },
                  { id: "m5", type: "combat" }, // should be filtered out
                ],
              },
            };
          }
          if (tool === "accept_mission") {
            acceptedIds.push(args?.mission_id as string);
            return { result: { accepted: true } };
          }
          return { result: {} };
        },
        { player: { current_poi: "sol_station", docked_at_base: "sol_station_base" } },
      );

      const result = await missionRunRoutine.run(ctx, { station: "sol_station" });
      expect(result.status).toBe("completed");
      expect(result.data.missions_completed).toBe(1);
      expect(result.data.credits_earned).toBe(2500);
      expect(result.data.missions_accepted).toBe(2);
      expect(completedIds).toEqual(["m1"]);
      expect(acceptedIds).toEqual(["m3", "m4"]);
      expect(result.summary).toContain("Completed 1 mission");
      expect(result.summary).toContain("+2,500cr");
      expect(result.summary).toContain("accepted 2 new missions");
    });

    it("travels and docks when not at station", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(
        async (tool) => {
          toolsCalled.push(tool);
          if (tool === "travel_to") return { result: { status: "completed" } };
          if (tool === "dock") return { result: { status: "docked" } };
          if (tool === "get_active_missions") return { result: { missions: [] } };
          if (tool === "get_missions") return { result: { missions: [] } };
          return { result: {} };
        },
        { player: { current_poi: "sol_belt" } },
      );

      const result = await missionRunRoutine.run(ctx, { station: "sol_station" });
      expect(result.status).toBe("completed");
      expect(toolsCalled).toContain("travel_to");
      expect(toolsCalled).toContain("dock");
    });

    it("skips travel and dock when already docked at station", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(
        async (tool) => {
          toolsCalled.push(tool);
          if (tool === "get_active_missions") return { result: { missions: [] } };
          if (tool === "get_missions") return { result: { missions: [] } };
          return { result: {} };
        },
        { player: { current_poi: "sol_station", docked_at_base: "sol_station_base" } },
      );

      const result = await missionRunRoutine.run(ctx, { station: "sol_station" });
      expect(result.status).toBe("completed");
      expect(toolsCalled).not.toContain("travel_to");
      expect(toolsCalled).not.toContain("dock");
    });

    it("hands off on travel failure", async () => {
      const ctx = mockContext(
        async (tool) => {
          if (tool === "travel_to") return { error: "navigation_blocked" };
          return { result: {} };
        },
        { player: { current_poi: "some_belt" } },
      );

      const result = await missionRunRoutine.run(ctx, { station: "sol_station" });
      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("Travel to sol_station failed");
    });

    it("hands off on dock failure", async () => {
      const ctx = mockContext(
        async (tool) => {
          if (tool === "travel_to") return { result: { status: "completed" } };
          if (tool === "dock") return { error: { code: "dock_blocked" } };
          return { result: {} };
        },
        { player: { current_poi: "some_belt" } },
      );

      const result = await missionRunRoutine.run(ctx, { station: "sol_station" });
      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("Could not dock");
    });

    it("handles no missions gracefully", async () => {
      const ctx = mockContext(
        async (tool) => {
          if (tool === "get_active_missions") return { result: { missions: [] } };
          if (tool === "get_missions") return { result: { missions: [] } };
          return { result: {} };
        },
        { player: { current_poi: "sol_station", docked_at_base: "sol_station_base" } },
      );

      const result = await missionRunRoutine.run(ctx, { station: "sol_station" });
      expect(result.status).toBe("completed");
      expect(result.summary).toContain("No missions");
      expect(result.data.missions_completed).toBe(0);
      expect(result.data.missions_accepted).toBe(0);
    });

    it("handles missions with progress as 1.0 (fractional)", async () => {
      const completedIds: string[] = [];
      const ctx = mockContext(
        async (tool, args) => {
          if (tool === "get_active_missions") {
            return { result: { missions: [{ id: "m1", progress: 1.0, type: "mining" }] } };
          }
          if (tool === "complete_mission") {
            completedIds.push(args?.mission_id as string);
            return { result: { credits: 1000 } };
          }
          if (tool === "get_missions") return { result: { missions: [] } };
          return { result: {} };
        },
        { player: { current_poi: "sol_station", docked_at_base: "sol_station_base" } },
      );

      const result = await missionRunRoutine.run(ctx, { station: "sol_station" });
      expect(result.status).toBe("completed");
      expect(completedIds).toEqual(["m1"]);
    });

    it("accepts delivery type missions", async () => {
      const acceptedIds: string[] = [];
      const ctx = mockContext(
        async (tool, args) => {
          if (tool === "get_active_missions") return { result: { missions: [] } };
          if (tool === "get_missions") {
            return {
              result: {
                missions: [
                  { id: "m1", type: "delivery" },
                  { id: "m2", type: "trade" },
                  { id: "m3", type: "haul" },
                ],
              },
            };
          }
          if (tool === "accept_mission") {
            acceptedIds.push(args?.mission_id as string);
            return { result: { accepted: true } };
          }
          return { result: {} };
        },
        { player: { current_poi: "sol_station", docked_at_base: "sol_station_base" } },
      );

      const result = await missionRunRoutine.run(ctx, { station: "sol_station" });
      expect(result.status).toBe("completed");
      expect(acceptedIds).toEqual(["m1", "m2", "m3"]);
    });

    it("continues when complete_mission fails for one mission", async () => {
      let completeCallCount = 0;
      const ctx = mockContext(
        async (tool) => {
          if (tool === "get_active_missions") {
            return {
              result: {
                missions: [
                  { id: "m1", progress: 100 },
                  { id: "m2", progress: 100 },
                ],
              },
            };
          }
          if (tool === "complete_mission") {
            completeCallCount++;
            if (completeCallCount === 1) return { error: "server_error" };
            return { result: { credits: 500 } };
          }
          if (tool === "get_missions") return { result: { missions: [] } };
          return { result: {} };
        },
        { player: { current_poi: "sol_station", docked_at_base: "sol_station_base" } },
      );

      const result = await missionRunRoutine.run(ctx, { station: "sol_station" });
      expect(result.status).toBe("completed");
      expect(result.data.missions_completed).toBe(1); // only second succeeded
    });
  });
});

// ---------------------------------------------------------------------------
// getTradeMissionCost — unit tests
// ---------------------------------------------------------------------------

describe("getTradeMissionCost", () => {
  it("returns null for mission with no cost fields", () => {
    expect(getTradeMissionCost({ id: "m1", type: "trade", name: "Buy stuff" })).toBeNull();
  });

  it("extracts required_credits directly", () => {
    expect(getTradeMissionCost({ required_credits: 5000 })).toBe(5000);
  });

  it("extracts total_cost directly", () => {
    expect(getTradeMissionCost({ total_cost: 3200 })).toBe(3200);
  });

  it("extracts buy_total directly", () => {
    expect(getTradeMissionCost({ buy_total: 1800 })).toBe(1800);
  });

  it("computes quantity × buy_price", () => {
    expect(getTradeMissionCost({ quantity: 19, buy_price: 350 })).toBe(6650);
  });

  it("computes quantity × price_each", () => {
    expect(getTradeMissionCost({ quantity: 10, price_each: 200 })).toBe(2000);
  });

  it("computes quantity × unit_price", () => {
    expect(getTradeMissionCost({ quantity: 5, unit_price: 100 })).toBe(500);
  });

  it("computes quantity × item_price", () => {
    expect(getTradeMissionCost({ quantity: 4, item_price: 250 })).toBe(1000);
  });

  it("uses item_count when quantity is absent", () => {
    expect(getTradeMissionCost({ item_count: 8, buy_price: 125 })).toBe(1000);
  });

  it("computes cost from nested items array", () => {
    const mission = {
      items: [
        { quantity: 10, buy_price: 100 },
        { quantity: 5, buy_price: 200 },
      ],
    };
    expect(getTradeMissionCost(mission)).toBe(2000);
  });

  it("returns null for nested items with missing price", () => {
    const mission = {
      items: [
        { quantity: 10 }, // no price
      ],
    };
    expect(getTradeMissionCost(mission)).toBeNull();
  });

  it("returns null for empty items array", () => {
    expect(getTradeMissionCost({ items: [] })).toBeNull();
  });

  it("prefers required_credits over quantity × price", () => {
    // pre-computed total takes precedence
    expect(getTradeMissionCost({ required_credits: 9999, quantity: 10, buy_price: 100 })).toBe(9999);
  });
});

// ---------------------------------------------------------------------------
// mission_run: pre-flight credit check tests
// ---------------------------------------------------------------------------

describe("mission_run credit check", () => {
  it("accepts trade mission when agent has enough credits (can-afford path)", async () => {
    const acceptedIds: string[] = [];

    const ctx = mockContext(
      async (tool, args) => {
        if (tool === "get_active_missions") return { result: { missions: [] } };
        if (tool === "get_missions") {
          return {
            result: {
              missions: [
                // trade mission costs 5,000cr; agent has 10,000cr
                { id: "m1", type: "trade", name: "Buy Authenticators", quantity: 10, buy_price: 500 },
              ],
            },
          };
        }
        if (tool === "accept_mission") {
          acceptedIds.push(args?.mission_id as string);
          return { result: { accepted: true } };
        }
        return { result: {} };
      },
      { player: { current_poi: "sol_station", docked_at_base: "sol_station_base", credits: 10000 } },
    );

    const result = await missionRunRoutine.run(ctx, { station: "sol_station" });
    expect(result.status).toBe("completed");
    expect(acceptedIds).toEqual(["m1"]);
    expect(result.data.missions_accepted).toBe(1);
    expect(result.data.missions_skipped_cost).toBe(0);
    expect(result.summary).not.toContain("insufficient credits");
  });

  it("skips trade mission when agent cannot afford it (can't-afford path)", async () => {
    const acceptedIds: string[] = [];
    const warnings: string[] = [];

    const ctx = mockContext(
      async (tool, args) => {
        if (tool === "get_active_missions") return { result: { missions: [] } };
        if (tool === "get_missions") {
          return {
            result: {
              missions: [
                // trade mission costs 6,650cr; agent only has 1,000cr
                { id: "m1", type: "trade", name: "Buy Authenticators", quantity: 19, buy_price: 350 },
              ],
            },
          };
        }
        if (tool === "accept_mission") {
          acceptedIds.push(args?.mission_id as string);
          return { result: { accepted: true } };
        }
        return { result: {} };
      },
      { player: { current_poi: "sol_station", docked_at_base: "sol_station_base", credits: 1000 } },
    );
    // Capture logs
    (ctx as any).log = (level: string, msg: string) => { if (level === "warn") warnings.push(msg); };

    const result = await missionRunRoutine.run(ctx, { station: "sol_station" });
    expect(result.status).toBe("completed");
    expect(acceptedIds).toHaveLength(0); // mission was NOT accepted
    expect(result.data.missions_accepted).toBe(0);
    expect(result.data.missions_skipped_cost).toBe(1);
    expect(result.summary).toContain("skipped 1 trade mission (insufficient credits)");
    // cost_warnings injected into result data
    const dataWarnings = result.data.cost_warnings as string[];
    expect(Array.isArray(dataWarnings)).toBe(true);
    expect(dataWarnings[0]).toContain("_cost_warning");
    expect(dataWarnings[0]).toContain("6,650");
    expect(dataWarnings[0]).toContain("1,000");
  });

  it("accepts affordable missions and skips unaffordable ones (partial-afford edge case)", async () => {
    const acceptedIds: string[] = [];

    const ctx = mockContext(
      async (tool, args) => {
        if (tool === "get_active_missions") return { result: { missions: [] } };
        if (tool === "get_missions") {
          return {
            result: {
              missions: [
                // affordable: 500cr total
                { id: "cheap", type: "trading", name: "Small Run", quantity: 5, buy_price: 100 },
                // unaffordable: 20,000cr total
                { id: "expensive", type: "trade", name: "Big Run", quantity: 100, buy_price: 200 },
                // mining mission: no cost check, always accepted
                { id: "mine1", type: "mining", name: "Mine Some Ore" },
              ],
            },
          };
        }
        if (tool === "accept_mission") {
          acceptedIds.push(args?.mission_id as string);
          return { result: { accepted: true } };
        }
        return { result: {} };
      },
      { player: { current_poi: "sol_station", docked_at_base: "sol_station_base", credits: 3000 } },
    );

    const result = await missionRunRoutine.run(ctx, { station: "sol_station" });
    expect(result.status).toBe("completed");
    // cheap trade + mining accepted; expensive trade skipped
    expect(acceptedIds).toContain("cheap");
    expect(acceptedIds).toContain("mine1");
    expect(acceptedIds).not.toContain("expensive");
    expect(result.data.missions_accepted).toBe(2);
    expect(result.data.missions_skipped_cost).toBe(1);
  });

  it("accepts trade mission when credits are unknown (no statusCache)", async () => {
    // When we can't determine credits, we should not block the mission
    const acceptedIds: string[] = [];

    const ctx = mockContext(
      async (tool, args) => {
        if (tool === "get_active_missions") return { result: { missions: [] } };
        if (tool === "get_missions") {
          return {
            result: {
              missions: [
                { id: "m1", type: "trade", name: "Buy Stuff", quantity: 50, buy_price: 1000 },
              ],
            },
          };
        }
        if (tool === "accept_mission") {
          acceptedIds.push(args?.mission_id as string);
          return { result: { accepted: true } };
        }
        return { result: {} };
      },
      // no credits in cache
      { player: { current_poi: "sol_station", docked_at_base: "sol_station_base" } },
    );

    const result = await missionRunRoutine.run(ctx, { station: "sol_station" });
    expect(result.status).toBe("completed");
    expect(acceptedIds).toEqual(["m1"]); // mission allowed through
    expect(result.data.missions_skipped_cost).toBe(0);
  });

  it("accepts trade mission when cost cannot be determined from mission data", async () => {
    // If we have credits but the mission has no cost fields, allow it
    const acceptedIds: string[] = [];

    const ctx = mockContext(
      async (tool, args) => {
        if (tool === "get_active_missions") return { result: { missions: [] } };
        if (tool === "get_missions") {
          return {
            result: {
              missions: [
                // trade mission but no cost fields — let it through
                { id: "m1", type: "trade", name: "Mystery Run" },
              ],
            },
          };
        }
        if (tool === "accept_mission") {
          acceptedIds.push(args?.mission_id as string);
          return { result: { accepted: true } };
        }
        return { result: {} };
      },
      { player: { current_poi: "sol_station", docked_at_base: "sol_station_base", credits: 500 } },
    );

    const result = await missionRunRoutine.run(ctx, { station: "sol_station" });
    expect(result.status).toBe("completed");
    expect(acceptedIds).toEqual(["m1"]);
    expect(result.data.missions_skipped_cost).toBe(0);
  });
});
