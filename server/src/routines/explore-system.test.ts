import { describe, it, expect } from "bun:test";
import { exploreSystemRoutine } from "./explore-system.js";
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

describe("explore_system routine", () => {
  describe("parseParams", () => {
    it("parses valid params", () => {
      const p = exploreSystemRoutine.parseParams({ target_system: "sol", max_pois: 3, next_system: "sirius" });
      expect(p.target_system).toBe("sol");
      expect(p.max_pois).toBe(3);
      expect(p.next_system).toBe("sirius");
    });

    it("defaults max_pois to undefined", () => {
      const p = exploreSystemRoutine.parseParams({ target_system: "sol" });
      expect(p.max_pois).toBeUndefined();
    });

    it("rejects missing target_system", () => {
      expect(() => exploreSystemRoutine.parseParams({})).toThrow("target_system is required");
    });
  });

  describe("run", () => {
    it("completes exploration: jump + survey + scan + get_system", async () => {
      const toolsCalled: string[] = [];
      const scannedIds: string[] = [];
      const ctx = mockContext(
        async (tool, args) => {
          toolsCalled.push(tool);
          if (tool === "jump_route") return { result: { status: "jumped" } };
          if (tool === "survey_system") return { result: { pois: [{ id: "p1" }, { id: "p2" }, { id: "p3" }] } };
          if (tool === "scan") {
            scannedIds.push(args?.id as string);
            return { result: { scanned: args?.id } };
          }
          if (tool === "get_system") return { result: { id: "sol", name: "Sol" } };
          return { result: {} };
        },
        { player: { current_system: "other" } },
      );

      const result = await exploreSystemRoutine.run(ctx, { target_system: "sol", max_pois: 2 });
      expect(result.status).toBe("handoff");
      expect(result.summary).toContain("Explored sol");
      expect(result.summary).toContain("scanned 2");
      expect(toolsCalled).toContain("jump_route");
      expect(toolsCalled).toContain("survey_system");
      expect(toolsCalled).toContain("get_system");
      expect(scannedIds).toEqual(["p1", "p2"]);
    });

    it("completes exploration with jump to next system", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(
        async (tool) => {
          toolsCalled.push(tool);
          if (tool === "jump_route") return { result: { status: "jumped" } };
          if (tool === "survey_system") return { result: { pois: [{ id: "p1" }] } };
          if (tool === "scan") return { result: {} };
          if (tool === "get_system") return { result: {} };
          return { result: {} };
        },
        { player: { current_system: "sol" } },
      );

      const result = await exploreSystemRoutine.run(ctx, { target_system: "sol", next_system: "sirius" });
      expect(result.status).toBe("completed");
      expect(result.summary).toContain("jumped to sirius");
      expect(toolsCalled).toContain("jump_route");
      expect(toolsCalled).toContain("survey_system");
    });

    it("aborts on combat during scanning", async () => {
      const ctx = mockContext(
        async (tool) => {
          if (tool === "survey_system") return { result: { pois: [{ id: "p1" }, { id: "p2" }] } };
          if (tool === "scan") {
            return { result: { battle_started: true } };
          }
          return { result: {} };
        },
        { player: { current_system: "sol" } },
      );

      const result = await exploreSystemRoutine.run(ctx, { target_system: "sol" });
      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("Combat detected");
    });

    it("aborts on combat via event buffer", async () => {
        let scanCount = 0;
        const ctx = mockContext(
          async (tool) => {
            if (tool === "survey_system") return { result: { pois: [{ id: "p1" }, { id: "p2" }] } };
            if (tool === "scan") {
              scanCount++;
              if (scanCount === 1) {
                  // Mock that scanning triggers combat
                  ctx.statusCache.set("test-agent", { 
                      data: { events: [{ type: "battle_started" }] }, 
                      fetchedAt: Date.now() 
                  });
              }
              return { result: {} };
            }
            return { result: {} };
          },
          { player: { current_system: "sol" } },
        );
  
        const result = await exploreSystemRoutine.run(ctx, { target_system: "sol" });
        expect(result.status).toBe("handoff");
        expect(result.handoffReason).toContain("Combat detected");
        expect(scanCount).toBe(1);
      });

    it("hands off on jump failure", async () => {
      const ctx = mockContext(
        async (tool) => {
          if (tool === "jump_route") return { error: "no_fuel" };
          return { result: {} };
        },
        { player: { current_system: "other" } },
      );

      const result = await exploreSystemRoutine.run(ctx, { target_system: "sol" });
      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("Jump to sol failed");
    });
  });
});
