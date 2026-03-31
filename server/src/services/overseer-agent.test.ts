import { describe, it, expect, beforeEach } from "bun:test";
import { createDatabase } from "./database.js";
import { OverseerAgent } from "./overseer-agent.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OverseerAgent", () => {
  let agent: OverseerAgent;

  beforeEach(() => {
    createDatabase(":memory:");
    agent = new OverseerAgent("overseer");
  });

  it("logDecision persists to DB and returns decision with id", () => {
    const decision = agent.logDecision({
      triggered_by: "agent_turn",
      snapshot_json: JSON.stringify({ agents: [] }),
      actions_json: JSON.stringify(["issue_order"]),
      results_json: JSON.stringify({ reasoning: "test" }),
      model: "haiku",
    });

    expect(decision.id).toBeGreaterThan(0);
    expect(decision.tick_number).toBe(1);
    expect(decision.triggered_by).toBe("agent_turn");
    expect(decision.model).toBe("haiku");
    expect(decision.status).toBe("success");
  });

  it("logDecision increments tick_number", () => {
    const d1 = agent.logDecision({
      triggered_by: "agent_turn",
      snapshot_json: "{}",
      actions_json: "[]",
      results_json: "{}",
      model: "haiku",
    });
    const d2 = agent.logDecision({
      triggered_by: "agent_turn",
      snapshot_json: "{}",
      actions_json: "[]",
      results_json: "{}",
      model: "haiku",
    });

    expect(d1.tick_number).toBe(1);
    expect(d2.tick_number).toBe(2);
  });

  it("getDecisionHistory returns recent decisions newest-first", () => {
    agent.logDecision({
      triggered_by: "turn_1",
      snapshot_json: "{}",
      actions_json: "[]",
      results_json: "{}",
      model: "haiku",
    });
    agent.logDecision({
      triggered_by: "turn_2",
      snapshot_json: "{}",
      actions_json: "[]",
      results_json: "{}",
      model: "haiku",
    });

    const history = agent.getDecisionHistory(10);
    expect(history.length).toBe(2);
    expect(history[0].tick_number).toBe(2);
    expect(history[1].tick_number).toBe(1);
  });

  it("getDecisionHistory respects limit", () => {
    for (let i = 0; i < 5; i++) {
      agent.logDecision({
        triggered_by: `turn_${i}`,
        snapshot_json: "{}",
        actions_json: "[]",
        results_json: "{}",
        model: "haiku",
      });
    }

    const history = agent.getDecisionHistory(3);
    expect(history.length).toBe(3);
  });

  it("getDecisionById returns single decision", () => {
    const decision = agent.logDecision({
      triggered_by: "agent_turn",
      snapshot_json: "{}",
      actions_json: "[]",
      results_json: "{}",
      model: "haiku",
    });

    const found = agent.getDecisionById(decision.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(decision.id);
    expect(found!.triggered_by).toBe("agent_turn");
  });

  it("getDecisionById returns null for missing id", () => {
    const missing = agent.getDecisionById(9999);
    expect(missing).toBeNull();
  });

  it("getCostToday returns number", () => {
    const cost = agent.getCostToday();
    expect(typeof cost).toBe("number");
    expect(cost).toBe(0);
  });

  it("updateLatestDecisionCost backfills cost on the most recent decision", () => {
    agent.logDecision({
      triggered_by: "agent_turn",
      snapshot_json: "{}",
      actions_json: "[]",
      results_json: "{}",
      model: "sonnet",
    });

    agent.updateLatestDecisionCost({ costUsd: 0.0042, inputTokens: 1200, outputTokens: 350 });

    const history = agent.getDecisionHistory(1);
    expect(history[0].cost_estimate).toBeCloseTo(0.0042);
    expect(history[0].input_tokens).toBe(1200);
    expect(history[0].output_tokens).toBe(350);
  });

  it("updateLatestDecisionCost only updates the most recent row", () => {
    const d1 = agent.logDecision({
      triggered_by: "turn_1",
      snapshot_json: "{}",
      actions_json: "[]",
      results_json: "{}",
      model: "sonnet",
    });
    agent.logDecision({
      triggered_by: "turn_2",
      snapshot_json: "{}",
      actions_json: "[]",
      results_json: "{}",
      model: "sonnet",
    });

    agent.updateLatestDecisionCost({ costUsd: 0.001, inputTokens: 500, outputTokens: 100 });

    // Oldest decision should be unaffected
    const old = agent.getDecisionById(d1.id);
    expect(old?.cost_estimate).toBeNull();
  });

  it("updateLatestDecisionCost is a no-op when no decisions exist", () => {
    // Should not throw
    expect(() => {
      agent.updateLatestDecisionCost({ costUsd: 0.005, inputTokens: 100, outputTokens: 50 });
    }).not.toThrow();
  });

  it("getCostToday reflects backfilled cost_estimate", () => {
    agent.logDecision({
      triggered_by: "agent_turn",
      snapshot_json: "{}",
      actions_json: "[]",
      results_json: "{}",
      model: "sonnet",
    });

    expect(agent.getCostToday()).toBe(0);

    agent.updateLatestDecisionCost({ costUsd: 0.0077, inputTokens: 800, outputTokens: 200 });
    expect(agent.getCostToday()).toBeCloseTo(0.0077);
  });

  it("getDecisionsToday returns count", () => {
    expect(agent.getDecisionsToday()).toBe(0);

    agent.logDecision({
      triggered_by: "agent_turn",
      snapshot_json: "{}",
      actions_json: "[]",
      results_json: "{}",
      model: "haiku",
    });
    agent.logDecision({
      triggered_by: "agent_turn",
      snapshot_json: "{}",
      actions_json: "[]",
      results_json: "{}",
      model: "haiku",
    });

    expect(agent.getDecisionsToday()).toBe(2);
  });
});
