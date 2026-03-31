import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createDatabase, closeDb } from "../services/database.js";
import { logToolCall, logToolCallStart, logToolCallComplete, logWsEvent, logAssistantText, logAgentReasoning, getRingBuffer, getRingSeq, subscribe, unsubscribe } from "./tool-call-logger.js";

function getRows() {
  const { getDb } = require("../services/database.js");
  const db = getDb();
  return db.prepare(
    "SELECT id, agent, tool_name, args_summary, result_summary, success, error_code, duration_ms, is_compound, status, assistant_text FROM proxy_tool_calls ORDER BY id DESC"
  ).all() as Array<{
    id: number;
    agent: string;
    tool_name: string;
    args_summary: string | null;
    result_summary: string | null;
    success: number;
    error_code: string | null;
    duration_ms: number | null;
    is_compound: number;
    status: string;
    assistant_text: string | null;
  }>;
}

describe("tool-call-logger", () => {
  beforeEach(() => {
    createDatabase(":memory:");
  });

  afterEach(() => {
    closeDb();
  });

  it("inserts tool call into database", () => {
    logToolCall("test-agent", "mine", { count: 5 }, { ore: 10 }, 150);
    const rows = getRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].agent).toBe("test-agent");
    expect(rows[0].tool_name).toBe("mine");
    expect(rows[0].duration_ms).toBe(150);
    expect(rows[0].success).toBe(1);
    expect(rows[0].is_compound).toBe(0);
  });

  it("truncates args to 1000 chars", () => {
    const longArgs = "x".repeat(1500);
    logToolCall("test-agent", "jump", longArgs, "ok", 50);
    const rows = getRows();
    expect(rows[0].args_summary!.length).toBeLessThanOrEqual(1000);
    expect(rows[0].args_summary!.endsWith("...")).toBe(true);
  });

  it("truncates result to 2000 chars", () => {
    const longResult = "r".repeat(3000);
    logToolCall("test-agent", "scan", {}, longResult, 100);
    const rows = getRows();
    expect(rows[0].result_summary!.length).toBeLessThanOrEqual(2000);
    expect(rows[0].result_summary!.endsWith("...")).toBe(true);
  });

  it("handles null args and result", () => {
    logToolCall("test-agent", "mine", null, null, 10);
    const rows = getRows();
    expect(rows[0].args_summary).toBeNull();
    expect(rows[0].result_summary).toBeNull();
  });

  it("sets error fields on failure", () => {
    logToolCall("test-agent", "jump", {}, "error", 500, {
      success: false,
      errorCode: "FUEL_EMPTY",
    });
    const rows = getRows();
    expect(rows[0].success).toBe(0);
    expect(rows[0].error_code).toBe("FUEL_EMPTY");
  });

  it("sets is_compound flag", () => {
    logToolCall("test-agent", "batch_mine", { count: 5 }, {}, 2000, { isCompound: true });
    const rows = getRows();
    expect(rows[0].is_compound).toBe(1);
  });

  it("silently handles db failure (fire-and-forget style)", () => {
    closeDb();
    // Should not throw
    expect(() => logToolCall("test-agent", "mine", {}, {}, 100)).not.toThrow();
    // Restore db so subsequent tests in this describe still work
    createDatabase(":memory:");
  });

  it("serializes object args and results", () => {
    logToolCall("test-agent", "sell", { item_id: "iron_ore", quantity: 10 }, { credits: 500 }, 200);
    const rows = getRows();
    expect(rows[0].args_summary).toContain("iron_ore");
    expect(rows[0].result_summary).toContain("500");
  });

  it("pushes to ring buffer", () => {
    const seqBefore = getRingSeq();
    logToolCall("test-agent", "mine", {}, {}, 100);
    expect(getRingSeq()).toBe(seqBefore + 1);
    const buf = getRingBuffer();
    const last = buf[buf.length - 1];
    expect(last.tool_name).toBe("mine");
    expect(last.agent).toBe("test-agent");
  });
});

describe("logWsEvent", () => {
  beforeEach(() => {
    createDatabase(":memory:");
  });

  afterEach(() => {
    closeDb();
  });

  it("inserts WS event with ws: prefix on tool_name", () => {
    logWsEvent("test-agent", "combat_update", { battle_id: "b1", hull: 80 });
    const rows = getRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].tool_name).toBe("ws:combat_update");
    expect(rows[0].agent).toBe("test-agent");
    expect(rows[0].args_summary).toBeNull();
    expect(rows[0].result_summary).toContain("battle_id");
    expect(rows[0].duration_ms).toBe(0);
    expect(rows[0].is_compound).toBe(0);
  });

  it("skips state_update events", () => {
    logWsEvent("test-agent", "state_update", { tick: 100 });
    const rows = getRows();
    expect(rows).toHaveLength(0);
  });

  it("skips tick and welcome events", () => {
    logWsEvent("test-agent", "tick", {});
    logWsEvent("test-agent", "welcome", {});
    const rows = getRows();
    expect(rows).toHaveLength(0);
  });

  it("marks player_died as success=false", () => {
    logWsEvent("test-agent", "player_died", { reason: "pirate" });
    const rows = getRows();
    expect(rows[0].tool_name).toBe("ws:player_died");
    expect(rows[0].success).toBe(0);
  });

  it("logs trade_offer_received events", () => {
    logWsEvent("test-agent", "trade_offer_received", { from: "player-1", item: "ore" });
    const rows = getRows();
    expect(rows[0].tool_name).toBe("ws:trade_offer_received");
    expect(rows[0].success).toBe(1);
  });
});

describe("two-phase logging", () => {
  beforeEach(() => {
    createDatabase(":memory:");
  });

  afterEach(() => {
    closeDb();
  });

  it("logToolCallStart inserts pending record and returns ID", () => {
    const id = logToolCallStart("test-agent", "salvage_wreck", { wreck_id: "w1" });
    expect(id).toBeGreaterThan(0);
    const rows = getRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].result_summary).toBeNull();
    expect(rows[0].duration_ms).toBeNull();
    expect(rows[0].tool_name).toBe("salvage_wreck");
  });

  it("logToolCallComplete updates pending record to complete", () => {
    const id = logToolCallStart("test-agent", "batch_mine", { count: 5 }, { isCompound: true });
    logToolCallComplete(id, "test-agent", "batch_mine", { ore: 50 }, 3000, { isCompound: true });
    const rows = getRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("complete");
    expect(rows[0].duration_ms).toBe(3000);
    expect(rows[0].result_summary).toContain("50");
    expect(rows[0].success).toBe(1);
  });

  it("logToolCallComplete sets error status on failure", () => {
    const id = logToolCallStart("test-agent", "jump", { system_id: "sol" });
    logToolCallComplete(id, "test-agent", "jump", "fuel empty", 150, { success: false, errorCode: "FUEL_EMPTY" });
    const rows = getRows();
    expect(rows[0].status).toBe("error");
    expect(rows[0].success).toBe(0);
    expect(rows[0].error_code).toBe("FUEL_EMPTY");
  });

  it("updates ring buffer entry in-place on complete", () => {
    const id = logToolCallStart("test-agent", "scan_and_attack", { stance: "aggressive" }, { isCompound: true });
    // Use last entry — ring buffer is shared across tests, IDs may collide
    const buf = getRingBuffer();
    const bufBefore = buf[buf.length - 1];
    expect(bufBefore.id).toBe(id);
    expect(bufBefore.status).toBe("pending");

    logToolCallComplete(id, "test-agent", "scan_and_attack", { outcome: "victory" }, 5000, { isCompound: true });
    // Same entry should be updated in-place (no new entry pushed)
    expect(buf[buf.length - 1].id).toBe(id);
    expect(buf[buf.length - 1].status).toBe("complete");
    expect(buf[buf.length - 1].duration_ms).toBe(5000);
  });

  it("notifies subscribers on both start and complete", () => {
    const received: Array<{ status: string; tool_name: string }> = [];
    const cb = (record: { status: string; tool_name: string }) => {
      received.push({ status: record.status, tool_name: record.tool_name });
    };
    subscribe(cb);

    const id = logToolCallStart("test-agent", "multi_sell", { items_count: 3 }, { isCompound: true });
    logToolCallComplete(id, "test-agent", "multi_sell", { credits: 500 }, 2000, { isCompound: true });

    unsubscribe(cb);

    expect(received).toHaveLength(2);
    expect(received[0].status).toBe("pending");
    expect(received[1].status).toBe("complete");
  });

  it("logToolCallComplete is no-op when pendingId is 0", () => {
    // Should not throw
    expect(() => logToolCallComplete(0, "test-agent", "mine", "ok", 100)).not.toThrow();
    const rows = getRows();
    expect(rows).toHaveLength(0);
  });

  it("existing logToolCall writes status complete", () => {
    logToolCall("test-agent", "mine", {}, { ore: 5 }, 100);
    const rows = getRows();
    expect(rows[0].status).toBe("complete");
  });
});

describe("logAssistantText", () => {
  beforeEach(() => {
    createDatabase(":memory:");
  });

  afterEach(() => {
    closeDb();
  });

  it("inserts assistant text record with __assistant_text tool_name", () => {
    logAssistantText("test-agent", "I should mine some iron ore next.");
    const rows = getRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].tool_name).toBe("__assistant_text");
    expect(rows[0].agent).toBe("test-agent");
    expect(rows[0].assistant_text).toBe("I should mine some iron ore next.");
    expect(rows[0].args_summary).toBeNull();
    expect(rows[0].result_summary).toBeNull();
    expect(rows[0].duration_ms).toBe(0);
    expect(rows[0].success).toBe(1);
    expect(rows[0].status).toBe("complete");
  });

  it("skips empty or whitespace-only text", () => {
    logAssistantText("test-agent", "");
    logAssistantText("test-agent", "   ");
    logAssistantText("test-agent", "\n\t  ");
    const rows = getRows();
    expect(rows).toHaveLength(0);
  });

  it("truncates text longer than 2000 chars", () => {
    const longText = "X".repeat(3000);
    logAssistantText("test-agent", longText);
    const rows = getRows();
    expect(rows[0].assistant_text!.length).toBe(2000);
  });

  it("stores trace_id when provided", () => {
    logAssistantText("test-agent", "Reasoning text.", "test-1234-abcd");
    const rows = getRows();
    // Need to select trace_id separately since getRows doesn't include it
    const { getDb } = require("../services/database.js");
    const db = getDb();
    const row = db.prepare("SELECT trace_id FROM proxy_tool_calls WHERE id = ?").get(rows[0].id) as { trace_id: string };
    expect(row.trace_id).toBe("test-1234-abcd");
  });

  it("pushes to ring buffer", () => {
    const seqBefore = getRingSeq();
    logAssistantText("test-agent", "Planning next action.");
    expect(getRingSeq()).toBe(seqBefore + 1);
    const buf = getRingBuffer();
    const last = buf[buf.length - 1];
    expect(last.tool_name).toBe("__assistant_text");
    expect(last.assistant_text).toBe("Planning next action.");
  });

  it("notifies subscribers", () => {
    const received: Array<{ tool_name: string; assistant_text: string | null }> = [];
    const cb = (record: { tool_name: string; assistant_text: string | null }) => {
      received.push({ tool_name: record.tool_name, assistant_text: record.assistant_text });
    };
    subscribe(cb);
    logAssistantText("test-agent", "Test notification.");
    unsubscribe(cb);

    expect(received).toHaveLength(1);
    expect(received[0].tool_name).toBe("__assistant_text");
    expect(received[0].assistant_text).toBe("Test notification.");
  });
});

describe("logAgentReasoning", () => {
  beforeEach(() => {
    createDatabase(":memory:");
  });

  afterEach(() => {
    closeDb();
  });

  it("inserts reasoning record with __reasoning tool_name", () => {
    logAgentReasoning("test-agent", "I need to evaluate my fuel level before jumping.");
    const rows = getRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].tool_name).toBe("__reasoning");
    expect(rows[0].agent).toBe("test-agent");
    expect(rows[0].assistant_text).toBe("I need to evaluate my fuel level before jumping.");
    expect(rows[0].args_summary).toBeNull();
    expect(rows[0].result_summary).toBeNull();
    expect(rows[0].duration_ms).toBe(0);
    expect(rows[0].success).toBe(1);
    expect(rows[0].status).toBe("complete");
  });

  it("truncates reasoning longer than 2000 chars", () => {
    const longReasoning = "R".repeat(3000);
    logAgentReasoning("test-agent", longReasoning);
    const rows = getRows();
    expect(rows[0].assistant_text!.length).toBe(2000);
  });

  it("skips empty or whitespace-only reasoning", () => {
    logAgentReasoning("test-agent", "");
    logAgentReasoning("test-agent", "   ");
    const rows = getRows();
    expect(rows).toHaveLength(0);
  });

  it("pushes to ring buffer with __reasoning tool_name", () => {
    const seqBefore = getRingSeq();
    logAgentReasoning("test-agent", "Considering whether to refuel now.");
    expect(getRingSeq()).toBe(seqBefore + 1);
    const buf = getRingBuffer();
    const last = buf[buf.length - 1];
    expect(last.tool_name).toBe("__reasoning");
    expect(last.assistant_text).toBe("Considering whether to refuel now.");
  });
});
