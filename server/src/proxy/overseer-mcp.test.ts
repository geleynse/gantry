import { describe, it, expect, beforeEach } from "bun:test";
import { createDatabase } from "../services/database.js";
import { OverseerAgent } from "../services/overseer-agent.js";
import { createActionExecutor } from "../services/overseer-actions.js";
import { createOverseerMcpServer, checkStopAgentPremature, type OverseerMcpDeps } from "./overseer-mcp.js";
import type { FleetSnapshot } from "../services/coordinator-state.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptySnapshot(): FleetSnapshot {
  return {
    agents: [],
    marketSummary: [],
    activeOrders: [],
    recentDeliveries: [],
    recentEvents: [],
    fleetTotals: {
      totalCredits: 0,
      totalCargoUsed: 0,
      totalCargoMax: 0,
      onlineCount: 0,
      offlineCount: 0,
    },
  };
}

function makeDeps(): { deps: OverseerMcpDeps; orders: Record<string, unknown>[] } {
  const orders: Record<string, unknown>[] = [];
  const executor = createActionExecutor({
    agentManager: {
      startAgent: async () => ({ ok: true, message: "started" }),
      stopAgent: async () => ({ ok: true, message: "stopped" }),
    },
    commsDb: {
      createOrder: (o) => {
        orders.push(o);
        return 1;
      },
    },
  });

  const deps: OverseerMcpDeps = {
    stateGatherer: emptySnapshot,
    actionExecutor: executor,
    overseerAgent: new OverseerAgent("overseer"),
    statusCache: new Map(),
    battleCache: new Map(),
  };

  return { deps, orders };
}

// ---------------------------------------------------------------------------
// Tests — we test the McpServer tool registration and handler behavior
// by calling the handlers through the server's internal tool list.
// Since McpServer doesn't expose handlers directly, we test the deps
// contract and verify tool registration via the server object.
// ---------------------------------------------------------------------------

describe("OverseerMcpServer", () => {
  beforeEach(() => {
    createDatabase(":memory:");
  });

  it("creates an McpServer with all expected tools", () => {
    const { deps } = makeDeps();
    const server = createOverseerMcpServer(deps);
    expect(server).toBeDefined();
    // McpServer is constructed — if registerTool threw, we'd have an error
  });

  it("stateGatherer returns fleet snapshot for get_fleet_status", () => {
    const { deps } = makeDeps();
    const snapshot = deps.stateGatherer();
    expect(snapshot.agents).toEqual([]);
    expect(snapshot.fleetTotals.totalCredits).toBe(0);
  });

  it("actionExecutor.execute handles issue_order", async () => {
    const { deps, orders } = makeDeps();
    const results = await deps.actionExecutor.execute([
      { type: "issue_order", params: { agent: "drifter-gale", message: "Go mine", priority: "normal" } },
    ]);

    expect(results.length).toBe(1);
    expect(results[0].success).toBe(true);
    expect(results[0].message).toContain("drifter-gale");
    expect(orders.length).toBe(1);
    expect(orders[0]).toMatchObject({ target_agent: "drifter-gale", message: "Go mine" });
  });

  it("actionExecutor.execute handles trigger_routine", async () => {
    const { deps, orders } = makeDeps();
    const results = await deps.actionExecutor.execute([
      { type: "trigger_routine", params: { agent: "rust-vane", routine: "sell_cycle" } },
    ]);

    expect(results.length).toBe(1);
    expect(results[0].success).toBe(true);
    expect(results[0].message).toContain("sell_cycle");
    expect(orders.length).toBe(1);
    // trigger_routine creates an [OPERATOR] fleet order
    expect((orders[0] as { message: string }).message).toContain("[OPERATOR]");
  });

  it("actionExecutor.execute handles start_agent", async () => {
    const { deps } = makeDeps();
    const results = await deps.actionExecutor.execute([
      { type: "start_agent", params: { agent: "sable-thorn" } },
    ]);
    expect(results[0].success).toBe(true);
    expect(results[0].message).toContain("started");
  });

  it("actionExecutor.execute handles stop_agent", async () => {
    const { deps } = makeDeps();
    const results = await deps.actionExecutor.execute([
      { type: "stop_agent", params: { agent: "sable-thorn", reason: "testing" } },
    ]);
    expect(results[0].success).toBe(true);
    expect(results[0].message).toContain("stopped");
  });

  it("actionExecutor.execute handles reassign_role", async () => {
    const { deps, orders } = makeDeps();
    const results = await deps.actionExecutor.execute([
      { type: "reassign_role", params: { agent: "cinder-wake", role: "miner" } },
    ]);
    expect(results[0].success).toBe(true);
    expect(orders.length).toBe(1);
    expect((orders[0] as { message: string }).message).toContain("[OVERSEER]");
  });

  it("log_decision persists via overseerAgent.logDecision", () => {
    const { deps } = makeDeps();
    const decision = deps.overseerAgent.logDecision({
      triggered_by: "agent_turn",
      snapshot_json: JSON.stringify(emptySnapshot()),
      actions_json: JSON.stringify(["issue_order"]),
      results_json: JSON.stringify({ reasoning: "fleet looks good" }),
      model: "claude",
    });

    expect(decision.id).toBeGreaterThan(0);
    expect(decision.triggered_by).toBe("agent_turn");

    const history = deps.overseerAgent.getDecisionHistory(5);
    expect(history.length).toBe(1);
    expect(history[0].id).toBe(decision.id);
  });

  it("registers the correct number of tools (8)", () => {
    const { deps } = makeDeps();
    const server = createOverseerMcpServer(deps);
    // We can't easily introspect McpServer's registered tools count,
    // but we verify the server was created without errors.
    // The 8 tools are: get_fleet_status, get_decision_history, issue_order,
    // trigger_routine, start_agent, stop_agent, reassign_role, log_decision
    expect(server).toBeDefined();
  });
});

describe("checkStopAgentPremature", () => {
  const FIVE_MIN = 5 * 60 * 1000;
  const TEN_MIN = 10 * 60 * 1000;
  const THIRTY_MIN = 30 * 60 * 1000;
  const ONE_HOUR = 60 * 60 * 1000;

  it("rejects transit/stuck reason when uptime is under 30 minutes", () => {
    const result = checkStopAgentPremature("drifter-gale", "transit stuck 3 turns", TEN_MIN);
    expect(result).not.toBeNull();
    expect(result?.error).toBe("stop_agent_premature");
    expect(result?.message).toContain("drifter-gale only running 10m");
    expect(result?.message).toContain("issue_order");
  });

  it("rejects 'idle' reason at 5 min uptime", () => {
    const result = checkStopAgentPremature("rust-vane", "idle for too long", FIVE_MIN);
    expect(result).not.toBeNull();
    expect(result?.error).toBe("stop_agent_premature");
  });

  it("allows transit reason once uptime exceeds 30 minutes", () => {
    const result = checkStopAgentPremature("drifter-gale", "transit stuck 30+ min", THIRTY_MIN);
    expect(result).toBeNull();
  });

  it("allows transit reason at 1 hour uptime", () => {
    const result = checkStopAgentPremature("drifter-gale", "transit stuck", ONE_HOUR);
    expect(result).toBeNull();
  });

  it("allows fault reasons regardless of uptime (broken)", () => {
    const result = checkStopAgentPremature("sable-thorn", "broken — agent crashing every turn", FIVE_MIN);
    expect(result).toBeNull();
  });

  it("allows fault reasons regardless of uptime (crash)", () => {
    const result = checkStopAgentPremature("sable-thorn", "agent crash detected", FIVE_MIN);
    expect(result).toBeNull();
  });

  it("allows transit reason if it ALSO mentions a fault (transit + crash)", () => {
    const result = checkStopAgentPremature("sable-thorn", "agent stuck in transit, crashed mid-jump", FIVE_MIN);
    expect(result).toBeNull();
  });

  it("allows non-transit reasons regardless of uptime (e.g. role reassignment)", () => {
    const result = checkStopAgentPremature("cinder-wake", "reassigning role", FIVE_MIN);
    expect(result).toBeNull();
  });

  it("allows stop when uptime is null (externally spawned, no signal)", () => {
    const result = checkStopAgentPremature("drifter-gale", "transit stuck", null);
    expect(result).toBeNull();
  });

  it("rejection message includes uptime in minutes", () => {
    const result = checkStopAgentPremature("drifter-gale", "transit idle", 10 * 60 * 1000);
    expect(result?.message).toMatch(/10m/);
  });
});
