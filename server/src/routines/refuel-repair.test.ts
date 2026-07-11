import { describe, it, expect } from "bun:test";
import { refuelRepairRoutine } from "./refuel-repair.js";
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

describe("refuel_repair routine", () => {
  describe("parseParams", () => {
    it("parses valid params", () => {
      const p = refuelRepairRoutine.parseParams({ station: "sirius_station" });
      expect(p.station).toBe("sirius_station");
    });

    it("rejects missing station", () => {
      expect(() => refuelRepairRoutine.parseParams({})).toThrow("station is required");
    });

    it("rejects non-object", () => {
      expect(() => refuelRepairRoutine.parseParams(null)).toThrow();
    });
  });

  describe("run", () => {
    it("reads ship fuel/hull from the v2 TEXT-dashboard get_status (regression for the string-cast bug)", async () => {
      // v2 get_status is a TEXT dashboard, not { ship }. Pre-fix, the cast made
      // ship undefined → getStatPct null → "Fuel or hull data unavailable" handoff.
      const toolsCalled: string[] = [];
      const STATUS_TEXT =
        "Rust Vane [Drifter] | 100cr | Sol\n" +
        "Hull: 70/100   Shield: 50/50   Armor: 25   Speed: 18\n" +
        "Fuel: 50/100   Cargo: 0/50   CPU: 9/12   Power: 7/10\n" +
        "Docked at: sirius_station";
      const ctx = mockContext(
        async (tool) => {
          toolsCalled.push(tool);
          if (tool === "get_status") return { result: STATUS_TEXT };
          if (tool === "refuel") return { result: { fuel_after: 100 } };
          if (tool === "repair") return { result: { hull_after: 100 } };
          return { result: {} };
        },
        { player: { current_poi: "sol_belt" } },
      );
      const result = await refuelRepairRoutine.run(ctx, { station: "sirius_station" });
      expect(result.status).toBe("completed");
      expect(result.data.did_refuel).toBe(true);  // 50% fuel < 80
      expect(result.data.did_repair).toBe(true);  // 70% hull < 90
      expect(toolsCalled).toContain("refuel");
      expect(toolsCalled).toContain("repair");
    });

    it("refuels and repairs when both needed", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(
        async (tool) => {
          toolsCalled.push(tool);
          if (tool === "travel_to") return { result: { status: "completed" } };
          if (tool === "dock") return { result: { status: "docked" } };
          if (tool === "get_status") return { result: { ship: { fuel: 50, fuel_max: 100, hull: 70, hull_max: 100 } } };
          if (tool === "refuel") return { result: { fuel_after: 100 } };
          if (tool === "repair") return { result: { hull_after: 100 } };
          return { result: {} };
        },
        { player: { current_poi: "sol_belt" } },
      );

      const result = await refuelRepairRoutine.run(ctx, { station: "sirius_station" });
      expect(result.status).toBe("completed");
      expect(result.data.did_refuel).toBe(true);
      expect(result.data.did_repair).toBe(true);
      expect(result.data.fuel_after).toBe(100);
      expect(result.data.hull_after).toBe(100);
      expect(result.summary).toContain("Refueled");
      expect(result.summary).toContain("repaired");
      expect(result.summary).toContain("sirius_station");
      expect(toolsCalled).toContain("travel_to");
      expect(toolsCalled).toContain("dock");
    });

    it("skips refuel when fuel >= 80%", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(
        async (tool) => {
          toolsCalled.push(tool);
          if (tool === "get_status") return { result: { ship: { fuel: 85, fuel_max: 100, hull: 60, hull_max: 100 } } };
          if (tool === "repair") return { result: { hull_after: 100 } };
          return { result: {} };
        },
        { player: { current_poi: "sirius_station", docked_at_base: "sirius_base" } },
      );

      const result = await refuelRepairRoutine.run(ctx, { station: "sirius_station" });
      expect(result.status).toBe("completed");
      expect(result.data.did_refuel).toBe(false);
      expect(result.data.did_repair).toBe(true);
      expect(toolsCalled).not.toContain("refuel");
    });

    it("skips repair when hull >= 90%", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(
        async (tool) => {
          toolsCalled.push(tool);
          if (tool === "get_status") return { result: { ship: { fuel: 30, fuel_max: 100, hull: 95, hull_max: 100 } } };
          if (tool === "refuel") return { result: { fuel_after: 100 } };
          return { result: {} };
        },
        { player: { current_poi: "sirius_station", docked_at_base: "sirius_base" } },
      );

      const result = await refuelRepairRoutine.run(ctx, { station: "sirius_station" });
      expect(result.status).toBe("completed");
      expect(result.data.did_refuel).toBe(true);
      expect(result.data.did_repair).toBe(false);
      expect(toolsCalled).not.toContain("repair");
    });

    it("skips both when ship is healthy", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(
        async (tool) => {
          toolsCalled.push(tool);
          if (tool === "get_status") return { result: { ship: { fuel: 90, fuel_max: 100, hull: 95, hull_max: 100 } } };
          return { result: {} };
        },
        { player: { current_poi: "sirius_station", docked_at_base: "sirius_base" } },
      );

      const result = await refuelRepairRoutine.run(ctx, { station: "sirius_station" });
      expect(result.status).toBe("completed");
      expect(result.data.did_refuel).toBe(false);
      expect(result.data.did_repair).toBe(false);
      expect(result.summary).toContain("No refuel or repair needed");
    });

    it("skips travel and dock when already docked at station", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(
        async (tool) => {
          toolsCalled.push(tool);
          if (tool === "get_status") return { result: { ship: { fuel: 50, fuel_max: 100, hull: 100, hull_max: 100 } } };
          if (tool === "refuel") return { result: { fuel_after: 100 } };
          return { result: {} };
        },
        { player: { current_poi: "sirius_station", docked_at_base: "sirius_base" } },
      );

      const result = await refuelRepairRoutine.run(ctx, { station: "sirius_station" });
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

      const result = await refuelRepairRoutine.run(ctx, { station: "sirius_station" });
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

      const result = await refuelRepairRoutine.run(ctx, { station: "sirius_station" });
      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("Could not dock");
    });

    it("treats already_docked error as success", async () => {
      const ctx = mockContext(
        async (tool) => {
          if (tool === "dock") return { error: { code: "already_docked" } };
          if (tool === "get_status") return { result: { ship: { fuel: 90, fuel_max: 100, hull: 95, hull_max: 100 } } };
          return { result: {} };
        },
        { player: { current_poi: "sirius_station" } },
      );

      const result = await refuelRepairRoutine.run(ctx, { station: "sirius_station" });
      expect(result.status).toBe("completed");
    });

    it("hands off when fuel data is missing from get_status (no false 100% report)", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(
        async (tool) => {
          toolsCalled.push(tool);
          if (tool === "get_status") return { result: { ship: { hull: 80, hull_max: 100 } } }; // fuel + fuel_max absent
          return { result: {} };
        },
        { player: { current_poi: "sirius_station", docked_at_base: "sirius_base" } },
      );

      const result = await refuelRepairRoutine.run(ctx, { station: "sirius_station" });
      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("unavailable");
      expect(toolsCalled).not.toContain("refuel"); // routine must NOT silently default to "looks fine"
      expect(toolsCalled).not.toContain("repair");
    });

    it("hands off when hull data is missing from get_status", async () => {
      const ctx = mockContext(
        async (tool) => {
          if (tool === "get_status") return { result: { ship: { fuel: 50, fuel_max: 100 } } }; // hull absent
          return { result: {} };
        },
        { player: { current_poi: "sirius_station", docked_at_base: "sirius_base" } },
      );

      const result = await refuelRepairRoutine.run(ctx, { station: "sirius_station" });
      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("unavailable");
    });
  });
});
