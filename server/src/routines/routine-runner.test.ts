import { describe, it, expect, beforeEach } from "bun:test";
import { runRoutine, formatRoutineResult, hasRoutine, getAvailableRoutines, getRoutineTools, withRetry, _resetRegistryForTest } from "./routine-runner.js";
import type { RoutineContext, RoutineResult } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockContext(overrides: Partial<RoutineContext> = {}): RoutineContext {
  return {
    agentName: "test-agent",
    client: {
      execute: async () => ({ result: { ok: true } }),
      waitForTick: async () => {},
    },
    statusCache: new Map(),
    log: () => {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("routine-runner", () => {
  beforeEach(() => { _resetRegistryForTest(); });

  describe("registry", () => {
    it("has sell_cycle registered", () => {
      expect(hasRoutine("sell_cycle")).toBe(true);
    });

    it("reports available routines", () => {
      const routines = getAvailableRoutines();
      expect(routines).toContain("sell_cycle");
    });

    it("returns false for unknown routines", () => {
      expect(hasRoutine("nonexistent")).toBe(false);
    });
  });

  describe("runRoutine", () => {
    it("returns error for unknown routine", async () => {
      const ctx = mockContext();
      const result = await runRoutine("nonexistent", {}, ctx);
      expect(result.status).toBe("error");
      expect(result.summary).toContain("Unknown routine");
    });

    it("returns error for invalid params", async () => {
      const ctx = mockContext();
      const result = await runRoutine("sell_cycle", {}, ctx);
      expect(result.status).toBe("error");
      expect(result.summary).toContain("Invalid params");
    });

    it("respects timeout", async () => {
      const ctx = mockContext({
        client: {
          execute: async () => {
            await new Promise((r) => setTimeout(r, 5000));
            return { result: {} };
          },
          waitForTick: async () => {},
        },
      });
      const result = await runRoutine("sell_cycle", { station: "test" }, ctx, 100);
      expect(result.status).toBe("error");
      expect(result.summary).toContain("timed out");
    });
  });

  describe("formatRoutineResult", () => {
    it("formats completed result", () => {
      const result: RoutineResult = {
        status: "completed",
        summary: "Sold 3 items for +2,450 credits",
        data: { items_sold: 3, credits_earned: 2450 },
        phases: [],
        durationMs: 1234,
      };
      const text = formatRoutineResult("sell_cycle", result);
      expect(text).toContain("ROUTINE_RESULT: sell_cycle completed");
      expect(text).toContain("Sold 3 items");
      expect(text).toContain("duration=1234ms");
    });

    it("formats handoff result", () => {
      const result: RoutineResult = {
        status: "handoff",
        summary: "No demand at station",
        handoffReason: "0 credits earned",
        data: {},
        phases: [],
        durationMs: 500,
      };
      const text = formatRoutineResult("sell_cycle", result);
      expect(text).toContain("ROUTINE_HANDOFF: sell_cycle");
      expect(text).toContain('reason: "0 credits earned"');
    });
  });

  describe("withRetry", () => {
    it("returns on first success", async () => {
      let calls = 0;
      const result = await withRetry(async () => { calls++; return 42; }, 3, 10);
      expect(result).toBe(42);
      expect(calls).toBe(1);
    });

    it("retries on failure", async () => {
      let calls = 0;
      const result = await withRetry(async () => {
        calls++;
        if (calls < 3) throw new Error("fail");
        return "ok";
      }, 3, 10);
      expect(result).toBe("ok");
      expect(calls).toBe(3);
    });

    it("throws after max attempts", async () => {
      let calls = 0;
      await expect(
        withRetry(async () => { calls++; throw new Error("always fails"); }, 2, 10),
      ).rejects.toThrow("always fails");
      expect(calls).toBe(2);
    });
  });

  describe("getRoutineTools", () => {
    it("returns tool list for mining_loop", () => {
      const tools = getRoutineTools("mining_loop");
      expect(tools).toBeDefined();
      expect(tools).toContain("batch_mine");
      expect(tools).toContain("travel_to");
      expect(tools).toContain("get_cargo");
    });

    it("returns tool list for sell_cycle", () => {
      const tools = getRoutineTools("sell_cycle");
      expect(tools).toBeDefined();
      expect(tools).toContain("analyze_market");
      expect(tools).toContain("multi_sell");
    });

    it("returns undefined for unknown routine", () => {
      expect(getRoutineTools("nonexistent")).toBeUndefined();
    });

    it("has entries for all registered routines", () => {
      const routines = getAvailableRoutines();
      for (const name of routines) {
        const tools = getRoutineTools(name);
        expect(tools).toBeDefined();
        expect(tools!.length).toBeGreaterThan(0);
      }
    });

    it("returns readonly arrays (not modifiable)", () => {
      const tools = getRoutineTools("mining_loop");
      expect(Array.isArray(tools)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Pre-flight denied-tool check (simulates the logic in gantry-v2.ts)
  // ---------------------------------------------------------------------------

  /**
   * Simulate the pre-flight check from gantry-v2.ts:
   *   const routineTools = getRoutineTools(routineId);
   *   if (routineTools) {
   *     const globalDenied = agentDeniedTools["*"] ?? {};
   *     const agentDenied = agentDeniedTools[agentName] ?? {};
   *     const blockedTools = routineTools.filter(t => t in globalDenied || t in agentDenied);
   *     if (blockedTools.length > 0) → blocked
   *   }
   */
  function runPreflightCheck(
    routineName: string,
    agentName: string,
    agentDeniedTools: Record<string, Record<string, string>>,
  ): { blocked: boolean; blockedTools: string[] } {
    const routineTools = getRoutineTools(routineName);
    if (!routineTools) return { blocked: false, blockedTools: [] };
    const globalDenied = agentDeniedTools["*"] ?? {};
    const agentDenied = agentDeniedTools[agentName] ?? {};
    const blockedTools = routineTools.filter((t) => t in globalDenied || t in agentDenied);
    return { blocked: blockedTools.length > 0, blockedTools };
  }

  describe("pre-flight denied-tool check", () => {
    it("blocks mining_loop when batch_mine is in agent denied tools", () => {
      const result = runPreflightCheck("mining_loop", "drifter-gale", {
        "drifter-gale": { batch_mine: "Mining disabled for scout role." },
      });
      expect(result.blocked).toBe(true);
      expect(result.blockedTools).toContain("batch_mine");
    });

    it("blocks mining_loop when batch_mine is globally denied", () => {
      const result = runPreflightCheck("mining_loop", "drifter-gale", {
        "*": { batch_mine: "Mining globally disabled." },
      });
      expect(result.blocked).toBe(true);
      expect(result.blockedTools).toContain("batch_mine");
    });

    it("passes mining_loop when no tools are denied", () => {
      const result = runPreflightCheck("mining_loop", "drifter-gale", {});
      expect(result.blocked).toBe(false);
      expect(result.blockedTools).toHaveLength(0);
    });

    it("passes mining_loop when unrelated tools are denied", () => {
      const result = runPreflightCheck("mining_loop", "drifter-gale", {
        "drifter-gale": { sell: "Selling disabled." },
        "*": { jettison: "No jettison." },
      });
      expect(result.blocked).toBe(false);
      expect(result.blockedTools).toHaveLength(0);
    });

    it("blocks sell_cycle when multi_sell is in agent denied tools", () => {
      const result = runPreflightCheck("sell_cycle", "rust-vane", {
        "rust-vane": { multi_sell: "Sell disabled." },
      });
      expect(result.blocked).toBe(true);
      expect(result.blockedTools).toContain("multi_sell");
    });

    it("blocks sell_cycle when analyze_market is globally denied", () => {
      const result = runPreflightCheck("sell_cycle", "rust-vane", {
        "*": { analyze_market: "Market analysis disabled." },
      });
      expect(result.blocked).toBe(true);
      expect(result.blockedTools).toContain("analyze_market");
    });

    it("returns all blocked tools when multiple are denied", () => {
      const result = runPreflightCheck("mining_loop", "sable-thorn", {
        "*": { batch_mine: "No mining." },
        "sable-thorn": { travel_to: "No travel." },
      });
      expect(result.blocked).toBe(true);
      expect(result.blockedTools).toContain("batch_mine");
      expect(result.blockedTools).toContain("travel_to");
      expect(result.blockedTools).toHaveLength(2);
    });

    it("does not block when denied tool is for a different agent", () => {
      const result = runPreflightCheck("mining_loop", "lumen-shoal", {
        "drifter-gale": { batch_mine: "Scout cannot mine." },
      });
      expect(result.blocked).toBe(false);
    });

    it("passes for unknown routine (no tools to check)", () => {
      const result = runPreflightCheck("nonexistent_routine", "any-agent", {
        "*": { batch_mine: "Denied." },
      });
      expect(result.blocked).toBe(false);
    });
  });
});
