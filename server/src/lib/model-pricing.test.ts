import { describe, it, expect } from "bun:test";
import { lookupPricing, computeCost, MODEL_PRICING } from "./model-pricing.js";

describe("lookupPricing", () => {
  it("returns null for undefined", () => {
    expect(lookupPricing(undefined)).toBeNull();
  });

  it("returns null for unknown model", () => {
    expect(lookupPricing("gpt-4")).toBeNull();
  });

  it("matches exact model ID", () => {
    const p = lookupPricing("claude-sonnet-4-6");
    expect(p).not.toBeNull();
    expect(p?.input).toBe(3);
    expect(p?.output).toBe(15);
  });

  it("matches model ID with date suffix", () => {
    const p = lookupPricing("claude-sonnet-4-6-20251001");
    expect(p).not.toBeNull();
    expect(p?.input).toBe(MODEL_PRICING["claude-sonnet-4-6"].input);
  });

  it("matches claude-opus-4-7", () => {
    const p = lookupPricing("claude-opus-4-7");
    expect(p?.input).toBe(15);
    expect(p?.output).toBe(75);
  });

  it("matches claude-haiku-4-5", () => {
    const p = lookupPricing("claude-haiku-4-5");
    expect(p?.input).toBe(0.80);
    expect(p?.cacheRead).toBe(0.08);
  });
});

describe("computeCost", () => {
  it("returns null when model is unknown", () => {
    expect(computeCost({ inputTokens: 1000, outputTokens: 500 }, "unknown-model")).toBeNull();
  });

  it("returns null when model is undefined", () => {
    expect(computeCost({ inputTokens: 1000 }, undefined)).toBeNull();
  });

  it("returns 0 for zero tokens with known model", () => {
    expect(computeCost({}, "claude-sonnet-4-6")).toBe(0);
  });

  it("computes cost correctly for input + output only", () => {
    // 1M input tokens at $3, 1M output tokens at $15 => $18
    const cost = computeCost(
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      "claude-sonnet-4-6",
    );
    expect(cost).toBeCloseTo(18, 6);
  });

  it("computes cost correctly with cache tokens", () => {
    // 1M cache read at $0.30, 1M cache write at $3.75
    const cost = computeCost(
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheCreationTokens: 1_000_000 },
      "claude-sonnet-4-6",
    );
    expect(cost).toBeCloseTo(4.05, 6);
  });

  it("treats missing token counts as zero", () => {
    const cost = computeCost({ outputTokens: 100_000 }, "claude-haiku-4-5");
    // 100k output at $4/M = $0.40
    expect(cost).toBeCloseTo(0.4, 6);
  });

  it("computes opus cost", () => {
    // 1M input at $15, 1M output at $75
    const cost = computeCost(
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      "claude-opus-4-7",
    );
    expect(cost).toBeCloseTo(90, 6);
  });
});
