import { describe, it, expect } from "bun:test";
import { upgradeShipRoutine } from "./upgrade-ship.js";
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

/** A market with a tier-2 engine and a tier-1 weapon. */
const SAMPLE_MARKET = {
  modules: [
    { id: "engine_mk2", name: "Engine Mk2", type: "engine", tier: 2, price: 5000 },
    { id: "weapon_basic", name: "Basic Laser", type: "weapon", tier: 1, price: 2000 },
    { id: "shield_mk3", name: "Shield Mk3", type: "shield", tier: 3, price: 8000 },
  ],
};

/** Status with a tier-1 engine installed, 20000 credits. */
const DOCKED_STATUS = {
  player: { credits: 20000, docked_at_base: "sirius_base", current_poi: "sirius_station" },
  ship: {
    hull_max: 100,
    module_slots: 4,
    modules: [
      { id: "engine_mk1", type: "engine", tier: 1 },
    ],
  },
};

describe("upgrade_ship routine", () => {
  // ---------------------------------------------------------------------------
  // parseParams
  // ---------------------------------------------------------------------------
  describe("parseParams", () => {
    it("accepts empty object with all defaults", () => {
      const p = upgradeShipRoutine.parseParams({});
      expect(p.station).toBeUndefined();
      expect(p.budget).toBeUndefined();
      expect(p.priorities).toEqual([]);
      expect(p.blacklist).toEqual([]);
    });

    it("parses all fields", () => {
      const p = upgradeShipRoutine.parseParams({
        station: "alpha_station",
        budget: 10000,
        priorities: ["weapon", "shield"],
        blacklist: ["broken_mod_id"],
      });
      expect(p.station).toBe("alpha_station");
      expect(p.budget).toBe(10000);
      expect(p.priorities).toEqual(["weapon", "shield"]);
      expect(p.blacklist).toEqual(["broken_mod_id"]);
    });

    it("rejects non-object params", () => {
      expect(() => upgradeShipRoutine.parseParams(null)).toThrow();
      expect(() => upgradeShipRoutine.parseParams("bad")).toThrow();
    });

    it("rejects negative budget", () => {
      expect(() => upgradeShipRoutine.parseParams({ budget: -100 })).toThrow("non-negative");
    });

    it("rejects non-string-array priorities", () => {
      expect(() => upgradeShipRoutine.parseParams({ priorities: [1, 2] })).toThrow("priorities");
    });

    it("rejects non-string-array blacklist", () => {
      expect(() => upgradeShipRoutine.parseParams({ blacklist: [true] })).toThrow("blacklist");
    });
  });

  // ---------------------------------------------------------------------------
  // run — travel/dock
  // ---------------------------------------------------------------------------
  describe("run — travel and dock", () => {
    it("skips travel and dock when already docked at target station", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(
        async (tool) => {
          toolsCalled.push(tool);
          if (tool === "get_status") return { result: DOCKED_STATUS };
          if (tool === "view_market") return { result: SAMPLE_MARKET };
          if (tool === "install_mod") return { result: { success: true } };
          if (tool === "browse_ships") return { result: { ships: [] } };
          return { result: {} };
        },
        { player: DOCKED_STATUS.player, ship: DOCKED_STATUS.ship },
      );

      const result = await upgradeShipRoutine.run(ctx, { station: "sirius_station" });
      expect(result.status).toBe("completed");
      expect(toolsCalled).not.toContain("travel_to");
      expect(toolsCalled).not.toContain("dock");
    });

    it("hands off when not docked and no station provided", async () => {
      const ctx = mockContext(
        async () => ({ result: {} }),
        { player: { current_poi: "deep_space" } }, // no docked_at_base
      );

      const result = await upgradeShipRoutine.run(ctx, {});
      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("Not docked");
    });

    it("hands off when travel fails", async () => {
      const ctx = mockContext(
        async (tool) => {
          if (tool === "travel_to") return { error: "route_blocked" };
          return { result: {} };
        },
        { player: { current_poi: "sol_belt" } },
      );

      const result = await upgradeShipRoutine.run(ctx, { station: "sirius_station" });
      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("Travel to sirius_station failed");
    });

    it("hands off when dock fails", async () => {
      const ctx = mockContext(
        async (tool) => {
          if (tool === "travel_to") return { result: { status: "completed" } };
          if (tool === "dock") return { error: { code: "bay_full", message: "No berths" } };
          return { result: {} };
        },
        { player: { current_poi: "sol_belt" } },
      );

      const result = await upgradeShipRoutine.run(ctx, { station: "sirius_station" });
      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("Could not dock");
    });
  });

  // ---------------------------------------------------------------------------
  // run — upgrade evaluation
  // ---------------------------------------------------------------------------
  describe("run — evaluate and install", () => {
    it("installs a higher-tier module", async () => {
      const toolsCalled: string[] = [];
      const installArgs: Array<Record<string, unknown>> = [];
      // Use a market with only the engine upgrade so the result is predictable
      const engineOnlyMarket = {
        modules: [
          { id: "engine_mk2", name: "Engine Mk2", type: "engine", tier: 2, price: 5000 },
        ],
      };

      const ctx = mockContext(
        async (tool, args) => {
          toolsCalled.push(tool);
          if (tool === "get_status") return { result: DOCKED_STATUS };
          if (tool === "view_market") return { result: engineOnlyMarket };
          if (tool === "install_mod") {
            installArgs.push(args ?? {});
            return { result: { success: true } };
          }
          if (tool === "browse_ships") return { result: { ships: [] } };
          return { result: {} };
        },
        { player: DOCKED_STATUS.player, ship: DOCKED_STATUS.ship },
      );

      const result = await upgradeShipRoutine.run(ctx, {});
      expect(result.status).toBe("completed");
      expect(result.data.modules_upgraded as number).toBeGreaterThan(0);
      expect(result.data.credits_spent as number).toBeGreaterThan(0);
      // Engine Mk2 should be installed (tier 2 > current tier 1)
      const upgrades = result.data.upgrades as Array<{ id: string }>;
      expect(upgrades.some((u) => u.id === "engine_mk2")).toBe(true);
    });

    it("does not install same-tier or lower-tier module", async () => {
      const installArgs: Array<Record<string, unknown>> = [];
      const ctx = mockContext(
        async (tool, args) => {
          if (tool === "get_status") {
            // Already have tier-3 engine
            return {
              result: {
                player: { credits: 20000, docked_at_base: "base", current_poi: "station" },
                ship: {
                  hull_max: 100,
                  module_slots: 4,
                  modules: [{ id: "engine_mk3", type: "engine", tier: 3 }],
                },
              },
            };
          }
          if (tool === "view_market") return { result: SAMPLE_MARKET }; // Market has tier 2 engine
          if (tool === "install_mod") { installArgs.push(args ?? {}); return { result: { success: true } }; }
          if (tool === "browse_ships") return { result: { ships: [] } };
          return { result: {} };
        },
        { player: { credits: 20000, docked_at_base: "base", current_poi: "station" } },
      );

      const result = await upgradeShipRoutine.run(ctx, {});
      expect(result.status).toBe("completed");
      // engine_mk2 (tier 2) should NOT be installed since we already have tier 3
      expect(installArgs.every((a) => a.item_id !== "engine_mk2")).toBe(true);
    });

    it("respects budget limit", async () => {
      const installArgs: Array<Record<string, unknown>> = [];
      const ctx = mockContext(
        async (tool, args) => {
          if (tool === "get_status") return { result: DOCKED_STATUS };
          if (tool === "view_market") return { result: SAMPLE_MARKET };
          if (tool === "install_mod") { installArgs.push(args ?? {}); return { result: { success: true } }; }
          if (tool === "browse_ships") return { result: { ships: [] } };
          return { result: {} };
        },
        { player: DOCKED_STATUS.player, ship: DOCKED_STATUS.ship },
      );

      // Budget of 3000 — engine_mk2 costs 5000 (too expensive), weapon_basic costs 2000 (ok)
      const result = await upgradeShipRoutine.run(ctx, { budget: 3000 });
      expect(result.status).toBe("completed");
      expect(installArgs.every((a) => a.item_id !== "engine_mk2")).toBe(true);
    });

    it("respects blacklist", async () => {
      const installArgs: Array<Record<string, unknown>> = [];
      const ctx = mockContext(
        async (tool, args) => {
          if (tool === "get_status") return { result: DOCKED_STATUS };
          if (tool === "view_market") return { result: SAMPLE_MARKET };
          if (tool === "install_mod") { installArgs.push(args ?? {}); return { result: { success: true } }; }
          if (tool === "browse_ships") return { result: { ships: [] } };
          return { result: {} };
        },
        { player: DOCKED_STATUS.player, ship: DOCKED_STATUS.ship },
      );

      const result = await upgradeShipRoutine.run(ctx, { blacklist: ["engine_mk2", "shield_mk3"] });
      expect(result.status).toBe("completed");
      expect(installArgs.every((a) => a.item_id !== "engine_mk2")).toBe(true);
      expect(installArgs.every((a) => a.item_id !== "shield_mk3")).toBe(true);
    });

    it("returns 0 upgrades when market is empty", async () => {
      const ctx = mockContext(
        async (tool) => {
          if (tool === "get_status") return { result: DOCKED_STATUS };
          if (tool === "view_market") return { result: { modules: [] } };
          if (tool === "browse_ships") return { result: { ships: [] } };
          return { result: {} };
        },
        { player: DOCKED_STATUS.player, ship: DOCKED_STATUS.ship },
      );

      const result = await upgradeShipRoutine.run(ctx, {});
      expect(result.status).toBe("completed");
      expect(result.data.modules_upgraded).toBe(0);
      expect(result.data.credits_spent).toBe(0);
      expect(result.summary).toContain("No upgrades available");
    });
  });

  // ---------------------------------------------------------------------------
  // run — ship recommendation
  // ---------------------------------------------------------------------------
  describe("run — ship recommendation", () => {
    it("reports ship recommendation without buying", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(
        async (tool) => {
          toolsCalled.push(tool);
          if (tool === "get_status") return { result: DOCKED_STATUS };
          if (tool === "view_market") return { result: { modules: [] } }; // No module upgrades
          if (tool === "browse_ships") {
            return {
              result: {
                ships: [
                  {
                    id: "hauler_xl",
                    name: "Hauler XL",
                    price: 15000, // affordable with 20000 credits
                    hull_max: 200, // better than current 100
                    module_slots: 8, // more than current 4
                  },
                ],
              },
            };
          }
          return { result: {} };
        },
        { player: DOCKED_STATUS.player, ship: DOCKED_STATUS.ship },
      );

      const result = await upgradeShipRoutine.run(ctx, {});
      expect(result.status).toBe("completed");
      expect(toolsCalled).toContain("browse_ships");
      // Should recommend but NOT call buy_listed_ship
      expect(toolsCalled).not.toContain("buy_listed_ship");
      expect(result.data.ship_recommendation).toBeTruthy();
      const rec = result.data.ship_recommendation as Record<string, unknown>;
      expect(rec.id).toBe("hauler_xl");
      expect(result.summary).toContain("Hauler XL");
    });

    it("does not recommend ship that costs more than available credits", async () => {
      const ctx = mockContext(
        async (tool) => {
          if (tool === "get_status") return { result: DOCKED_STATUS };
          if (tool === "view_market") return { result: { modules: [] } };
          if (tool === "browse_ships") {
            return {
              result: {
                ships: [
                  {
                    id: "luxury_cruiser",
                    name: "Luxury Cruiser",
                    price: 999999, // way too expensive
                    hull_max: 500,
                    module_slots: 10,
                  },
                ],
              },
            };
          }
          return { result: {} };
        },
        { player: DOCKED_STATUS.player, ship: DOCKED_STATUS.ship },
      );

      const result = await upgradeShipRoutine.run(ctx, {});
      expect(result.status).toBe("completed");
      expect(result.data.ship_recommendation).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // run — priority scoring
  // ---------------------------------------------------------------------------
  describe("run — priority scoring", () => {
    it("installs priority modules first when budget is tight", async () => {
      // Budget just enough for one module. With priorities=["shield"], shield should be chosen
      // over engine even if engine has same tier, because shield scores higher via priority bonus.
      const marketWithTiedTiers = {
        modules: [
          { id: "engine_mk2", name: "Engine Mk2", type: "engine", tier: 2, price: 3000 },
          { id: "shield_mk2", name: "Shield Mk2", type: "shield", tier: 2, price: 3000 },
        ],
      };

      const installArgs: Array<Record<string, unknown>> = [];
      const ctx = mockContext(
        async (tool, args) => {
          if (tool === "get_status") {
            return {
              result: {
                player: { credits: 20000, docked_at_base: "base", current_poi: "station" },
                ship: { hull_max: 100, module_slots: 4, modules: [] },
              },
            };
          }
          if (tool === "view_market") return { result: marketWithTiedTiers };
          if (tool === "install_mod") { installArgs.push(args ?? {}); return { result: { success: true } }; }
          if (tool === "browse_ships") return { result: { ships: [] } };
          return { result: {} };
        },
        { player: { credits: 20000, docked_at_base: "base", current_poi: "station" } },
      );

      // Budget of 4000 — enough for exactly one 3000-credit module
      const result = await upgradeShipRoutine.run(ctx, { budget: 4000, priorities: ["shield"] });
      expect(result.status).toBe("completed");
      // Shield should be first since it has priority bonus
      expect(installArgs[0]?.item_id).toBe("shield_mk2");
    });
  });
});
