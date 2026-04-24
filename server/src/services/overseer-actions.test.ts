import { describe, it, expect, beforeEach } from "bun:test";
import { createActionExecutor } from "./overseer-actions.js";

function makeMockDeps() {
  const orders: any[] = [];
  const started: string[] = [];
  const stopped: string[] = [];
  return {
    orders,
    started,
    stopped,
    agentManager: {
      startAgent: async (name: string) => { started.push(name); return { ok: true, message: "started" }; },
      stopAgent: async (name: string) => { stopped.push(name); return { ok: true, message: "stopped" }; },
    },
    commsDb: {
      createOrder: (opts: any) => { orders.push(opts); return orders.length; },
    },
  };
}

describe("ActionExecutor", () => {
  describe("issue_order", () => {
    it("creates a fleet order via commsDb", async () => {
      const deps = makeMockDeps();
      const executor = createActionExecutor(deps);

      const results = await executor.execute([
        { type: "issue_order", params: { agent: "drifter-gale", message: "Head to Astatine", priority: "normal" } },
      ]);

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(results[0].message).toContain("drifter-gale");
      expect(deps.orders).toHaveLength(1);
      expect(deps.orders[0].target_agent).toBe("drifter-gale");
      expect(deps.orders[0].message).toBe("Head to Astatine");
      expect(deps.orders[0].priority).toBe("normal");
    });

    it("defaults priority to normal when not provided", async () => {
      const deps = makeMockDeps();
      const executor = createActionExecutor(deps);

      await executor.execute([
        { type: "issue_order", params: { agent: "sable-thorn", message: "Attack the pirate" } },
      ]);

      expect(deps.orders[0].priority).toBe("normal");
    });
  });

  describe("trigger_routine", () => {
    it("creates an [OPERATOR] prefixed fleet order with urgent priority", async () => {
      const deps = makeMockDeps();
      const executor = createActionExecutor(deps);

      const results = await executor.execute([
        { type: "trigger_routine", params: { agent: "rust-vane", routine: "mining_loop" } },
      ]);

      expect(results[0].success).toBe(true);
      expect(results[0].message).toContain("mining_loop");
      expect(deps.orders).toHaveLength(1);
      expect(deps.orders[0].message).toMatch(/\[OPERATOR\]/);
      expect(deps.orders[0].priority).toBe("urgent");
      expect(deps.orders[0].target_agent).toBe("rust-vane");
    });

    it("includes routine name and params in order message", async () => {
      const deps = makeMockDeps();
      const executor = createActionExecutor(deps);

      await executor.execute([
        { type: "trigger_routine", params: { agent: "lumen-shoal", routine: "full_trade_run", params: { sell: true } } },
      ]);

      expect(deps.orders[0].message).toContain("full_trade_run");
    });
  });

  describe("start_agent", () => {
    it("calls agentManager.startAgent", async () => {
      const deps = makeMockDeps();
      const executor = createActionExecutor(deps);

      const results = await executor.execute([
        { type: "start_agent", params: { agent: "cinder-wake" } },
      ]);

      expect(results[0].success).toBe(true);
      expect(deps.started).toContain("cinder-wake");
      expect(deps.stopped).toHaveLength(0);
    });

    it("skips start when isAgentRunning reports agent already alive", async () => {
      const deps = {
        ...makeMockDeps(),
        isAgentRunning: async () => true,
      };
      const executor = createActionExecutor(deps);

      const results = await executor.execute([
        { type: "start_agent", params: { agent: "cinder-wake" } },
      ]);

      expect(results[0].success).toBe(true);
      expect(results[0].message).toMatch(/already running/i);
      // startAgent on the agentManager must NOT be called
      expect(deps.started).toHaveLength(0);
    });

    it("starts when isAgentRunning reports agent is dead", async () => {
      const deps = {
        ...makeMockDeps(),
        isAgentRunning: async () => false,
      };
      const executor = createActionExecutor(deps);

      const results = await executor.execute([
        { type: "start_agent", params: { agent: "cinder-wake" } },
      ]);

      expect(results[0].success).toBe(true);
      expect(deps.started).toContain("cinder-wake");
    });

    it("proceeds with start when isAgentRunning check throws", async () => {
      const deps = {
        ...makeMockDeps(),
        isAgentRunning: async () => { throw new Error("process check failed"); },
      };
      const executor = createActionExecutor(deps);

      const results = await executor.execute([
        { type: "start_agent", params: { agent: "cinder-wake" } },
      ]);

      expect(results[0].success).toBe(true);
      expect(deps.started).toContain("cinder-wake");
    });
  });

  describe("stop_agent", () => {
    it("calls agentManager.stopAgent", async () => {
      const deps = makeMockDeps();
      const executor = createActionExecutor(deps);

      const results = await executor.execute([
        { type: "stop_agent", params: { agent: "drifter-gale", reason: "Low credits" } },
      ]);

      expect(results[0].success).toBe(true);
      expect(deps.stopped).toContain("drifter-gale");
      expect(deps.started).toHaveLength(0);
    });

    it("skips stop when isAgentRunning reports agent already dead", async () => {
      const deps = {
        ...makeMockDeps(),
        isAgentRunning: async () => false,
      };
      const executor = createActionExecutor(deps);

      const results = await executor.execute([
        { type: "stop_agent", params: { agent: "drifter-gale", reason: "test" } },
      ]);

      expect(results[0].success).toBe(true);
      expect(results[0].message).toMatch(/already stopped/i);
      expect(deps.stopped).toHaveLength(0);
    });
  });

  describe("reassign_role", () => {
    it("creates an urgent fleet order mentioning the new role", async () => {
      const deps = makeMockDeps();
      const executor = createActionExecutor(deps);

      const results = await executor.execute([
        { type: "reassign_role", params: { agent: "sable-thorn", role: "trader" } },
      ]);

      expect(results[0].success).toBe(true);
      expect(results[0].message).toContain("sable-thorn");
      expect(deps.orders).toHaveLength(1);
      expect(deps.orders[0].message).toContain("trader");
      expect(deps.orders[0].priority).toBe("urgent");
    });

    it("includes optional zone in order when provided", async () => {
      const deps = makeMockDeps();
      const executor = createActionExecutor(deps);

      await executor.execute([
        { type: "reassign_role", params: { agent: "rust-vane", role: "miner", zone: "Astatine" } },
      ]);

      expect(deps.orders[0].message).toContain("Astatine");
    });
  });

  describe("no_action", () => {
    it("succeeds as a no-op without touching agentManager or commsDb", async () => {
      const deps = makeMockDeps();
      const executor = createActionExecutor(deps);

      const results = await executor.execute([
        { type: "no_action", params: { reason: "Fleet is operating well" } },
      ]);

      expect(results[0].success).toBe(true);
      expect(results[0].message).toContain("Fleet is operating well");
      expect(deps.orders).toHaveLength(0);
      expect(deps.started).toHaveLength(0);
      expect(deps.stopped).toHaveLength(0);
    });
  });

  describe("unknown action type", () => {
    it("returns error result for unknown action type", async () => {
      const deps = makeMockDeps();
      const executor = createActionExecutor(deps);

      const results = await executor.execute([
        { type: "unknown_action" as any, params: { agent: "drifter-gale" } },
      ]);

      expect(results[0].success).toBe(false);
      expect(results[0].message).toContain("Unknown action type");
    });
  });

  describe("lifecycle rate limiting", () => {
    it("blocks rapid start/stop for the same agent within 5 minutes", async () => {
      const deps = makeMockDeps();
      const executor = createActionExecutor(deps);

      // First lifecycle action succeeds
      const first = await executor.execute([
        { type: "start_agent", params: { agent: "lumen-shoal" } },
      ]);
      expect(first[0].success).toBe(true);

      // Immediate second action is rate-limited
      const second = await executor.execute([
        { type: "stop_agent", params: { agent: "lumen-shoal", reason: "test" } },
      ]);
      expect(second[0].success).toBe(false);
      expect(second[0].message).toMatch(/rate limit|<5 min/i);
    });

    it("allows lifecycle actions for different agents independently", async () => {
      const deps = makeMockDeps();
      const executor = createActionExecutor(deps);

      const results = await executor.execute([
        { type: "start_agent", params: { agent: "drifter-gale" } },
        { type: "start_agent", params: { agent: "sable-thorn" } },
      ]);

      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
      expect(deps.started).toContain("drifter-gale");
      expect(deps.started).toContain("sable-thorn");
    });
  });

  describe("getToolSchemas", () => {
    it("returns at least 5 tools with required fields", () => {
      const deps = makeMockDeps();
      const executor = createActionExecutor(deps);
      const schemas = executor.getToolSchemas();

      expect(schemas.length).toBeGreaterThanOrEqual(5);
      for (const tool of schemas) {
        expect(tool).toHaveProperty("name");
        expect(tool).toHaveProperty("description");
        expect(tool).toHaveProperty("input_schema");
        expect(typeof tool.name).toBe("string");
        expect(typeof tool.description).toBe("string");
        expect(tool.input_schema).toHaveProperty("type");
        expect(tool.input_schema).toHaveProperty("properties");
      }
    });

    it("includes all expected action types", () => {
      const deps = makeMockDeps();
      const executor = createActionExecutor(deps);
      const schemas = executor.getToolSchemas();
      const names = schemas.map((t) => t.name);

      expect(names).toContain("issue_order");
      expect(names).toContain("trigger_routine");
      expect(names).toContain("start_agent");
      expect(names).toContain("stop_agent");
      expect(names).toContain("reassign_role");
      expect(names).toContain("no_action");
    });
  });

  describe("execute multiple actions", () => {
    it("processes all actions in sequence and returns all results", async () => {
      const deps = makeMockDeps();
      const executor = createActionExecutor(deps);

      const results = await executor.execute([
        { type: "issue_order", params: { agent: "drifter-gale", message: "Dock at station" } },
        { type: "no_action", params: { reason: "Other agents fine" } },
        { type: "issue_order", params: { agent: "rust-vane", message: "Start mining" } },
      ]);

      expect(results).toHaveLength(3);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
      expect(results[2].success).toBe(true);
      expect(deps.orders).toHaveLength(2);
    });
  });
});
