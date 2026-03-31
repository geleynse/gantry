import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createDatabase, closeDb } from "../services/database.js";
import {
  generateTraceId,
  logToolCall,
  logToolCallStart,
  logToolCallComplete,
  getRingBuffer,
} from "./tool-call-logger.js";

function getRows() {
  const { getDb } = require("../services/database.js");
  const db = getDb();
  return db.prepare(
    "SELECT id, agent, tool_name, trace_id, status FROM proxy_tool_calls ORDER BY id DESC"
  ).all() as Array<{
    id: number;
    agent: string;
    tool_name: string;
    trace_id: string | null;
    status: string;
  }>;
}

const originalDateNow = Date.now;

describe("generateTraceId", () => {
  let counter = 0;

  beforeEach(() => {
    counter = 0;
    // @ts-ignore
    global.Date.now = () => {
      counter++;
      return originalDateNow() + counter;
    };
  });

  afterEach(() => {
    global.Date.now = originalDateNow;
  });

  it("produces correct format: prefix-timestamp-hex", () => {
    const id = generateTraceId("drifter-gale");
    // Format: drif-<ms>-<4hex>
    const parts = id.split("-");
    expect(parts.length).toBe(3);
    expect(parts[0]).toBe("drif");
    expect(Number(parts[1])).toBeGreaterThan(0);
    expect(parts[2]).toMatch(/^[0-9a-f]{4}$/);
  });

  it("uses first 4 chars of agent name without hyphens", () => {
    expect(generateTraceId("sable-thorn").startsWith("sabl-")).toBe(true);
    expect(generateTraceId("cinder-wake").startsWith("cind-")).toBe(true);
    expect(generateTraceId("ab").startsWith("ab-")).toBe(true);
  });

  it("generates unique IDs on successive calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      ids.add(generateTraceId("test-agent"));
    }
    // All 50 should be unique (timestamp + random makes collisions extremely unlikely)
    expect(ids.size).toBe(50);
  });

  it("timestamp portion is a valid millisecond epoch", () => {
    // Restore original Date.now for this specific test to accurately check epoch values
    global.Date.now = originalDateNow;
    const before = Date.now();
    const id = generateTraceId("test-agent");
    const after = Date.now();
    const ts = Number(id.split("-")[1]);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

describe("trace_id in tool call records", () => {
  beforeEach(() => {
    createDatabase(":memory:");
  });

  afterEach(() => {
    closeDb();
  });

  it("logToolCall stores trace_id in database", () => {
    logToolCall("test-agent", "mine", { count: 5 }, { ore: 10 }, 150, {
      traceId: "test-1234567890-abcd",
    });
    const rows = getRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].trace_id).toBe("test-1234567890-abcd");
  });

  it("logToolCall defaults trace_id to null when not provided", () => {
    logToolCall("test-agent", "mine", {}, {}, 100);
    const rows = getRows();
    expect(rows[0].trace_id).toBeNull();
  });

  it("logToolCallStart stores trace_id in pending record", () => {
    const id = logToolCallStart("test-agent", "jump", { system_id: "sol" }, {
      traceId: "test-9999999999-ff00",
    });
    expect(id).toBeGreaterThan(0);
    const rows = getRows();
    expect(rows[0].trace_id).toBe("test-9999999999-ff00");
    expect(rows[0].status).toBe("pending");
  });

  it("trace_id persists through start→complete cycle", () => {
    const traceId = "test-1111111111-aabb";
    const id = logToolCallStart("test-agent", "sell", { item: "ore" }, { traceId });
    logToolCallComplete(id, "test-agent", "sell", { credits: 50 }, 200);
    const rows = getRows();
    expect(rows[0].trace_id).toBe(traceId);
    expect(rows[0].status).toBe("complete");
  });

  it("trace_id appears in ring buffer", () => {
    const traceId = "ring-2222222222-ccdd";
    logToolCall("test-agent", "dock", {}, { status: "ok" }, 50, { traceId });
    const buf = getRingBuffer();
    const last = buf[buf.length - 1];
    expect(last.trace_id).toBe(traceId);
  });
});

describe("compound tool sub-trace format", () => {
  it("sub-trace appends /step-index to parent trace", () => {
    const parentTrace = generateTraceId("sable-thorn");
    const subTrace = `${parentTrace}/mine-0`;
    expect(subTrace).toMatch(/^sabl-\d+-[0-9a-f]{4}\/mine-0$/);
  });

  it("sub-traces are unique per step", () => {
    const parentTrace = generateTraceId("test-agent");
    const subs = Array.from({ length: 5 }, (_, i) => `${parentTrace}/mine-${i}`);
    const unique = new Set(subs);
    expect(unique.size).toBe(5);
  });
});
