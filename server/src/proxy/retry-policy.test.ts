import { describe, it, expect, spyOn } from "bun:test";
import {
  calculateDelay,
  isRetryableError,
  withRetry,
  DEFAULT_RETRY_POLICY,
  type RetryPolicy,
} from "./retry-policy.js";
import type { GameResponse } from "./game-client.js";
import { MUTATION_COMMANDS, STATE_CHANGING_TOOLS } from "./proxy-constants.js";

describe("calculateDelay", () => {
  const policy: RetryPolicy = {
    maxRetries: 3,
    initialDelayMs: 100,
    maxDelayMs: 5000,
    backoffMultiplier: 2.0,
    jitterFraction: 0, // no jitter for deterministic tests
  };

  it("returns initialDelayMs for attempt 0", () => {
    expect(calculateDelay(0, policy)).toBe(100);
  });

  it("doubles delay for each attempt", () => {
    expect(calculateDelay(1, policy)).toBe(200);
    expect(calculateDelay(2, policy)).toBe(400);
    expect(calculateDelay(3, policy)).toBe(800);
  });

  it("caps at maxDelayMs", () => {
    expect(calculateDelay(10, policy)).toBe(5000);
  });

  it("adds jitter when jitterFraction > 0", () => {
    const jitteryPolicy: RetryPolicy = { ...policy, jitterFraction: 0.5 };
    const delays = new Set<number>();
    for (let i = 0; i < 20; i++) {
      delays.add(calculateDelay(0, jitteryPolicy));
    }
    // With 50% jitter on 100ms, expect range ~50-150
    expect(delays.size).toBeGreaterThan(1); // not all the same
  });

  it("never returns negative", () => {
    const highJitter: RetryPolicy = { ...policy, jitterFraction: 1.0 };
    for (let i = 0; i < 50; i++) {
      expect(calculateDelay(0, highJitter)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("isRetryableError", () => {
  it("returns false for successful responses", () => {
    expect(isRetryableError({ result: "ok" })).toBe(false);
  });

  it("returns true for timeout errors", () => {
    expect(isRetryableError({ error: { code: "timeout", message: "timed out" } })).toBe(true);
  });

  it("returns true for connection_lost errors (retried with backoff)", () => {
    expect(isRetryableError({ error: { code: "connection_lost", message: "failed" } })).toBe(true);
  });

  it("returns false for connection_retry_failed errors (not retryable at this layer)", () => {
    expect(isRetryableError({ error: { code: "connection_retry_failed", message: "exhausted" } })).toBe(false);
  });

  it("returns false for non-retryable errors", () => {
    expect(isRetryableError({ error: { code: "not_docked", message: "must dock" } })).toBe(false);
  });

  it("returns false for action_pending (handled separately)", () => {
    expect(isRetryableError({ error: { code: "action_pending", message: "pending" } })).toBe(false);
  });
});

describe("withRetry", () => {
  const fastPolicy: RetryPolicy = {
    maxRetries: 2,
    initialDelayMs: 1,
    maxDelayMs: 10,
    backoffMultiplier: 2,
    jitterFraction: 0,
  };

  it("returns immediately on success", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      return { result: "done" };
    }, fastPolicy, "test");

    expect(result.response.result).toBe("done");
    expect(result.attempts).toBe(1);
    expect(calls).toBe(1);
  });

  it("retries on retryable error and succeeds", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 3) return { error: { code: "timeout", message: "timed out" } };
      return { result: "recovered" };
    }, fastPolicy, "test");

    expect(result.response.result).toBe("recovered");
    expect(result.attempts).toBe(3);
    expect(calls).toBe(3);
  });

  it("exhausts retries and returns last error", async () => {
    spyOn(console, "log").mockImplementation(() => {});
    const result = await withRetry(async () => {
      return { error: { code: "timeout", message: "timed out" } };
    }, fastPolicy, "test");

    expect(result.response.error?.code).toBe("timeout");
    expect(result.attempts).toBe(3); // 1 initial + 2 retries
    expect(result.lastError).toBeDefined();
  });

  it("does not retry non-retryable errors", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      return { error: { code: "not_docked", message: "must dock" } };
    }, fastPolicy, "test");

    expect(calls).toBe(1);
    expect(result.response.error?.code).toBe("not_docked");
  });

  it("does not retry action_pending", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      return { error: { code: "action_pending", message: "pending" } };
    }, fastPolicy, "test");

    expect(calls).toBe(1);
    expect(result.response.error?.code).toBe("action_pending");
  });

  it("uses default policy when none specified", async () => {
    const result = await withRetry(async () => ({ result: "ok" }));
    expect(result.response.result).toBe("ok");
    expect(result.attempts).toBe(1);
  });
});

describe("MUTATION_COMMANDS", () => {
  it("contains expected financial commands", () => {
    expect(MUTATION_COMMANDS.has("buy")).toBe(true);
    expect(MUTATION_COMMANDS.has("sell")).toBe(true);
    expect(MUTATION_COMMANDS.has("create_sell_order")).toBe(true);
    expect(MUTATION_COMMANDS.has("cancel_order")).toBe(true);
  });

  it("contains expected combat commands", () => {
    expect(MUTATION_COMMANDS.has("attack")).toBe(true);
    expect(MUTATION_COMMANDS.has("loot_wreck")).toBe(true);
    expect(MUTATION_COMMANDS.has("salvage_wreck")).toBe(true);
  });

  it("contains crafting and trade commands", () => {
    expect(MUTATION_COMMANDS.has("craft")).toBe(true);
    expect(MUTATION_COMMANDS.has("trade_offer")).toBe(true);
    expect(MUTATION_COMMANDS.has("trade_accept")).toBe(true);
  });

  it("does NOT contain idempotent commands", () => {
    expect(MUTATION_COMMANDS.has("dock")).toBe(false);
    expect(MUTATION_COMMANDS.has("undock")).toBe(false);
    expect(MUTATION_COMMANDS.has("refuel")).toBe(false);
    expect(MUTATION_COMMANDS.has("repair")).toBe(false);
    expect(MUTATION_COMMANDS.has("mine")).toBe(false);
    expect(MUTATION_COMMANDS.has("travel")).toBe(false);
    expect(MUTATION_COMMANDS.has("jump")).toBe(false);
  });

  it("is a subset of STATE_CHANGING_TOOLS", () => {
    for (const cmd of MUTATION_COMMANDS) {
      expect(STATE_CHANGING_TOOLS.has(cmd)).toBe(true);
    }
  });
});
