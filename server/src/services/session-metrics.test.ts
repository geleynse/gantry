import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createDatabase, getDb, closeDb } from "./database.js";
import {
  getSessionInfo,
  getLatencyMetrics,
  getErrorRateBreakdown,
  getLastSuccessfulCommand,
} from "./session-metrics.js";

describe("session-metrics", () => {
  beforeEach(() => {
    createDatabase(":memory:");
  });

  afterEach(() => {
    closeDb();
  });

  it("should get session info with no tool calls", () => {
    const info = getSessionInfo("test-agent");
    expect(info.agent).toBe("test-agent");
    expect(info.sessionStartedAt).toBeNull();
    expect(info.lastToolCallAt).toBeNull();
  });

  it("should get session info with tool calls", () => {
    const db = getDb();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO proxy_tool_calls (agent, tool_name, success, created_at)
       VALUES (?, ?, ?, ?)`
    ).run("test-agent", "mine", 1, now);

    const info = getSessionInfo("test-agent");
    expect(info.agent).toBe("test-agent");
    expect(info.sessionStartedAt).toBe(now);
    expect(info.lastToolCallAt).toBe(now);
  });

  it("should calculate latency percentiles", () => {
    const db = getDb();
    const durations = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

    for (const duration of durations) {
      db.prepare(
        `INSERT INTO proxy_tool_calls (agent, tool_name, success, duration_ms, created_at)
         VALUES (?, ?, ?, ?, datetime('now'))`
      ).run("test-agent", "mine", 1, duration);
    }

    const metrics = getLatencyMetrics("test-agent");
    expect(metrics.agent).toBe("test-agent");
    expect(metrics.p50Ms).toBeDefined();
    expect(metrics.p95Ms).toBeDefined();
    expect(metrics.p99Ms).toBeDefined();
    expect(metrics.avgMs).toBe(55); // (10+20+...+100) / 10 = 550 / 10 = 55
  });

  it("should calculate error rate breakdown", () => {
    const db = getDb();

    // Insert successful calls
    for (let i = 0; i < 8; i++) {
      db.prepare(
        `INSERT INTO proxy_tool_calls (agent, tool_name, success, created_at)
         VALUES (?, ?, ?, datetime('now'))`
      ).run("test-agent", "mine", 1);
    }

    // Insert failed calls with error codes
    db.prepare(
      `INSERT INTO proxy_tool_calls (agent, tool_name, success, error_code, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    ).run("test-agent", "mine", 0, "timeout");

    db.prepare(
      `INSERT INTO proxy_tool_calls (agent, tool_name, success, error_code, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    ).run("test-agent", "mine", 0, "not_available");

    const breakdown = getErrorRateBreakdown("test-agent");
    expect(breakdown.agent).toBe("test-agent");
    expect(breakdown.totalCalls).toBe(10);
    expect(breakdown.successRate).toBe(80);
    expect(breakdown.errorsByType.timeout).toBe(1);
    expect(breakdown.errorsByType.not_available).toBe(1);
  });

  it("should get last successful command", () => {
    const db = getDb();
    const now = new Date().toISOString();

    // Insert a failed call
    db.prepare(
      `INSERT INTO proxy_tool_calls (agent, tool_name, success, created_at)
       VALUES (?, ?, ?, ?)`
    ).run("test-agent", "mine", 0, now);

    // Insert a successful call after
    const later = new Date(Date.now() + 1000).toISOString();
    db.prepare(
      `INSERT INTO proxy_tool_calls (agent, tool_name, success, created_at)
       VALUES (?, ?, ?, ?)`
    ).run("test-agent", "jump", 1, later);

    const timestamp = getLastSuccessfulCommand("test-agent");
    expect(timestamp).toBe(later);
  });

  it("should handle agent with no successful commands", () => {
    const db = getDb();

    db.prepare(
      `INSERT INTO proxy_tool_calls (agent, tool_name, success, created_at)
       VALUES (?, ?, ?, datetime('now'))`
    ).run("test-agent", "mine", 0);

    const timestamp = getLastSuccessfulCommand("test-agent");
    expect(timestamp).toBeNull();
  });

  it("should track rate limit errors (429)", () => {
    const db = getDb();

    // Insert successful calls
    for (let i = 0; i < 5; i++) {
      db.prepare(
        `INSERT INTO proxy_tool_calls (agent, tool_name, success, created_at)
         VALUES (?, ?, ?, datetime('now'))`
      ).run("test-agent", "mine", 1);
    }

    // Insert rate limit errors
    db.prepare(
      `INSERT INTO proxy_tool_calls (agent, tool_name, success, error_code, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    ).run("test-agent", "mine", 0, "429");

    db.prepare(
      `INSERT INTO proxy_tool_calls (agent, tool_name, success, error_code, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    ).run("test-agent", "mine", 0, "429");

    const breakdown = getErrorRateBreakdown("test-agent");
    expect(breakdown.countRateLimit).toBe(2);
    expect(breakdown.countConnection).toBe(0);
  });

  it("should track rate limit errors (rate_limited)", () => {
    const db = getDb();

    db.prepare(
      `INSERT INTO proxy_tool_calls (agent, tool_name, success, error_code, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    ).run("test-agent", "mine", 0, "rate_limited");

    const breakdown = getErrorRateBreakdown("test-agent");
    expect(breakdown.countRateLimit).toBe(1);
    expect(breakdown.countConnection).toBe(0);
  });

  it("should track connection errors (legacy connection_failed code)", () => {
    const db = getDb();

    // Insert successful call
    db.prepare(
      `INSERT INTO proxy_tool_calls (agent, tool_name, success, created_at)
       VALUES (?, ?, ?, datetime('now'))`
    ).run("test-agent", "mine", 1);

    // Insert connection failed errors
    db.prepare(
      `INSERT INTO proxy_tool_calls (agent, tool_name, success, error_code, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    ).run("test-agent", "mine", 0, "connection_failed");

    db.prepare(
      `INSERT INTO proxy_tool_calls (agent, tool_name, success, error_code, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    ).run("test-agent", "mine", 0, "connection_failed");

    const breakdown = getErrorRateBreakdown("test-agent");
    expect(breakdown.countConnection).toBe(2);
    expect(breakdown.countRateLimit).toBe(0);
  });

  it("should track connection errors (new sub-type codes)", () => {
    const db = getDb();
    const insert = db.prepare(
      `INSERT INTO proxy_tool_calls (agent, tool_name, success, error_code, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    );
    insert.run("test-agent", "mine", 0, "connection_lost");
    insert.run("test-agent", "mine", 0, "connection_timeout");
    insert.run("test-agent", "mine", 0, "connection_refused");
    insert.run("test-agent", "mine", 0, "connection_retry_failed");

    const breakdown = getErrorRateBreakdown("test-agent");
    expect(breakdown.countConnection).toBe(4);
  });

  it("should return 0 counts when no rate limit or connection errors", () => {
    const db = getDb();

    // Insert successful calls only
    for (let i = 0; i < 5; i++) {
      db.prepare(
        `INSERT INTO proxy_tool_calls (agent, tool_name, success, created_at)
         VALUES (?, ?, ?, datetime('now'))`
      ).run("test-agent", "mine", 1);
    }

    const breakdown = getErrorRateBreakdown("test-agent");
    expect(breakdown.countRateLimit).toBe(0);
    expect(breakdown.countConnection).toBe(0);
  });
});
