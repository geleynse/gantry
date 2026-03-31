import { describe, it, expect } from "bun:test";
import { manageStorageRoutine } from "./manage-storage.js";
import type { RoutineContext } from "./types.js";

type ToolHandler = (tool: string, args?: Record<string, unknown>) => Promise<{ result?: unknown; error?: unknown }>;

function mockContext(toolHandler: ToolHandler): RoutineContext {
  return {
    agentName: "test-agent",
    client: { execute: toolHandler, waitForTick: async () => {} },
    statusCache: new Map(),
    log: () => {},
  };
}

describe("manage_storage routine", () => {
  describe("parseParams", () => {
    it("parses deposit_all", () => {
      const p = manageStorageRoutine.parseParams({ action: "deposit_all" });
      expect(p.action).toBe("deposit_all");
    });

    it("parses deposit with items", () => {
      const p = manageStorageRoutine.parseParams({ action: "deposit", items: ["item_1", "item_2"] });
      expect(p.action).toBe("deposit");
      expect(p.items).toEqual(["item_1", "item_2"]);
    });

    it("rejects deposit without items", () => {
      expect(() => manageStorageRoutine.parseParams({ action: "deposit" })).toThrow("items array is required");
    });

    it("rejects invalid action", () => {
      expect(() => manageStorageRoutine.parseParams({ action: "sell" })).toThrow("action must be");
    });
  });

  describe("run", () => {
    it("deposits all cargo items", async () => {
      const deposited: string[] = [];
      const ctx = mockContext(async (tool, args) => {
        if (tool === "get_status") return {
          result: { player: { docked_at_base: "nexus_base" } },
        };
        if (tool === "get_cargo") return {
          result: { cargo: [{ id: "ore_1" }, { id: "ore_2" }, { id: "ore_3" }] },
        };
        if (tool === "deposit_items") {
          deposited.push(String((args as any)?.id));
          return { result: { deposited: true } };
        }
        return { result: {} };
      });

      const result = await manageStorageRoutine.run(ctx, { action: "deposit_all" });
      expect(result.status).toBe("completed");
      expect(result.data.deposited).toBe(3);
      expect(deposited).toEqual(["ore_1", "ore_2", "ore_3"]);
      expect(result.summary).toContain("deposited 3 items");
    });

    it("withdraws specified items", async () => {
      const withdrawn: string[] = [];
      const ctx = mockContext(async (tool, args) => {
        if (tool === "get_status") return {
          result: { player: { docked_at_base: "nexus_base" } },
        };
        if (tool === "get_cargo") return { result: { cargo: [] } };
        if (tool === "withdraw_items") {
          withdrawn.push(String((args as any)?.id));
          return { result: { withdrawn: true } };
        }
        return { result: {} };
      });

      const result = await manageStorageRoutine.run(ctx, {
        action: "withdraw",
        items: ["mod_1", "mod_2"],
      });
      expect(result.status).toBe("completed");
      expect(result.data.withdrawn).toBe(2);
      expect(withdrawn).toEqual(["mod_1", "mod_2"]);
    });

    it("hands off when not docked", async () => {
      const ctx = mockContext(async (tool) => {
        if (tool === "get_status") return {
          result: { player: { docked_at_base: null } },
        };
        return { result: {} };
      });

      const result = await manageStorageRoutine.run(ctx, { action: "deposit_all" });
      expect(result.status).toBe("handoff");
      expect(result.summary).toContain("docked");
    });

    it("handles partial deposit failures", async () => {
      let callCount = 0;
      const ctx = mockContext(async (tool) => {
        if (tool === "get_status") return {
          result: { player: { docked_at_base: "station_1" } },
        };
        if (tool === "get_cargo") return {
          result: { cargo: [{ id: "a" }, { id: "b" }, { id: "c" }] },
        };
        if (tool === "deposit_items") {
          callCount++;
          if (callCount === 2) return { error: "storage_full" };
          return { result: { ok: true } };
        }
        return { result: {} };
      });

      const result = await manageStorageRoutine.run(ctx, { action: "deposit_all" });
      expect(result.status).toBe("completed");
      expect(result.data.deposited).toBe(2); // 3 attempted, 1 failed
    });
  });
});
