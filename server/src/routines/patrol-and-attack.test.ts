import { describe, it, expect } from "bun:test";
import { patrolAndAttackRoutine } from "./patrol-and-attack.js";
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

describe("patrol_and_attack routine", () => {
  describe("parseParams", () => {
    it("accepts empty params", () => {
      const params = patrolAndAttackRoutine.parseParams({});
      expect(params.systems).toBeUndefined();
      expect(params.max_targets).toBeUndefined();
    });

    it("parses systems and max_targets", () => {
      const params = patrolAndAttackRoutine.parseParams({
        systems: ["sys_0001", "sys_0002"],
        max_targets: 3,
      });
      expect(params.systems).toEqual(["sys_0001", "sys_0002"]);
      expect(params.max_targets).toBe(3);
    });

    it("rejects invalid max_targets", () => {
      expect(() => patrolAndAttackRoutine.parseParams({ max_targets: -1 })).toThrow("max_targets must be a positive number");
    });
  });

  describe("run", () => {
    it("patrols current system with victory and loot", async () => {
      const ctx = mockContext(
        async (tool) => {
          if (tool === "get_status") return { result: { ship: { hull: 100, hull_max: 100 } } };
          if (tool === "scan_and_attack") return { result: { outcome: "victory", kills: 1 } };
          if (tool === "loot_wrecks") return { result: { credits_looted: 600, total_value: 600 } };
          return { result: {} };
        },
        { player: { current_system: "sol" } },
      );

      const result = await patrolAndAttackRoutine.run(ctx, {});
      expect(result.status).toBe("completed");
      expect(result.data.total_kills).toBe(1);
      expect(result.data.total_loot).toBe(600);
      expect(result.data.systems_patrolled).toBe(1);
      expect(result.summary).toContain("1 kill");
      expect(result.summary).toContain("+600cr");
    });

    it("patrols multiple systems with jumps", async () => {
      let jumpCount = 0;
      const ctx = mockContext(
        async (tool) => {
          if (tool === "get_status") return { result: { ship: { hull: 100, hull_max: 100 } } };
          if (tool === "jump") { jumpCount++; return { result: { status: "jumped" } }; }
          if (tool === "scan_and_attack") return { result: { outcome: "victory", kills: 1 } };
          if (tool === "loot_wrecks") return { result: { credits_looted: 400, total_value: 400 } };
          return { result: {} };
        },
        { player: { current_system: "sol" } },
      );

      const result = await patrolAndAttackRoutine.run(ctx, {
        systems: ["sol", "sirius"],
        max_targets: 5,
      });
      expect(result.status).toBe("completed");
      expect(result.data.systems_patrolled).toBe(2);
      expect(result.data.total_kills).toBe(2);
      // Only jump for sirius (sol is current)
      expect(jumpCount).toBe(1);
    });

    it("hands off when hull < 30% at init", async () => {
      const ctx = mockContext(
        async (tool) => {
          if (tool === "get_status") return { result: { ship: { hull: 20, hull_max: 100 } } };
          return { result: {} };
        },
        { player: { current_system: "sol" } },
      );

      const result = await patrolAndAttackRoutine.run(ctx, {});
      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("Hull critically low");
      expect(result.handoffReason).toContain("20%");
    });

    it("hands off on defeat", async () => {
      const ctx = mockContext(
        async (tool) => {
          if (tool === "get_status") return { result: { ship: { hull: 80, hull_max: 100 } } };
          if (tool === "scan_and_attack") return { result: { outcome: "defeat", kills: 0 } };
          return { result: {} };
        },
        { player: { current_system: "sol" } },
      );

      const result = await patrolAndAttackRoutine.run(ctx, {});
      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("defeat");
    });

    it("hands off on fled", async () => {
      const ctx = mockContext(
        async (tool) => {
          if (tool === "get_status") return { result: { ship: { hull: 50, hull_max: 100 } } };
          if (tool === "scan_and_attack") return { result: { outcome: "fled", kills: 0 } };
          return { result: {} };
        },
        { player: { current_system: "sol" } },
      );

      const result = await patrolAndAttackRoutine.run(ctx, {});
      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("fled");
    });

    it("hands off when hull drops below 30% after combat", async () => {
      let statusCallCount = 0;
      const ctx = mockContext(
        async (tool) => {
          if (tool === "get_status") {
            statusCallCount++;
            // First call: hull ok; subsequent: hull low
            if (statusCallCount === 1) return { result: { ship: { hull: 80, hull_max: 100 } } };
            return { result: { ship: { hull: 25, hull_max: 100 } } };
          }
          if (tool === "scan_and_attack") return { result: { outcome: "victory", kills: 1 } };
          if (tool === "loot_wrecks") return { result: { credits_looted: 200, total_value: 200 } };
          return { result: {} };
        },
        { player: { current_system: "sol" } },
      );

      const result = await patrolAndAttackRoutine.run(ctx, {});
      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("25%");
    });

    it("handles no targets gracefully", async () => {
      const ctx = mockContext(
        async (tool) => {
          if (tool === "get_status") return { result: { ship: { hull: 100, hull_max: 100 } } };
          if (tool === "scan_and_attack") return { error: { code: "no_targets" } };
          return { result: {} };
        },
        { player: { current_system: "sol" } },
      );

      const result = await patrolAndAttackRoutine.run(ctx, {});
      expect(result.status).toBe("completed");
      expect(result.data.total_kills).toBe(0);
    });

    it("respects max_targets limit", async () => {
      let combatCalls = 0;
      const ctx = mockContext(
        async (tool) => {
          if (tool === "get_status") return { result: { ship: { hull: 100, hull_max: 100 } } };
          if (tool === "scan_and_attack") { combatCalls++; return { result: { outcome: "victory", kills: 1 } }; }
          if (tool === "loot_wrecks") return { result: { credits_looted: 100, total_value: 100 } };
          return { result: {} };
        },
        { player: { current_system: "sol" } },
      );

      // max_targets=1, but 2 systems — should stop after 1 kill
      const result = await patrolAndAttackRoutine.run(ctx, {
        systems: ["sol", "sirius"],
        max_targets: 1,
      });
      expect(result.status).toBe("completed");
      expect(result.data.total_kills).toBe(1);
      expect(combatCalls).toBe(1);
    });

    it("hands off on jump failure", async () => {
      const ctx = mockContext(
        async (tool) => {
          if (tool === "get_status") return { result: { ship: { hull: 100, hull_max: 100 } } };
          if (tool === "jump") return { error: "jump_blocked" };
          return { result: {} };
        },
        { player: { current_system: "sol" } },
      );

      const result = await patrolAndAttackRoutine.run(ctx, { systems: ["sirius"] });
      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("Jump to sirius failed");
    });
  });
});
