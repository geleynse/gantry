/**
 * Tests for compaction model config fields added in Task #26.
 * Tests AgentConfigSchema compactionModel/compactionEnabled fields
 * and agent-manager arg generation.
 */

import { describe, test, expect } from "bun:test";
import { AgentConfigSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// AgentConfigSchema — compaction fields
// ---------------------------------------------------------------------------

describe("AgentConfigSchema — compaction fields", () => {
  test("accepts compactionModel string", () => {
    const result = AgentConfigSchema.safeParse({
      name: "test-agent",
      compactionModel: "haiku",
    });
    expect(result.success).toBe(true);
    expect(result.data?.compactionModel).toBe("haiku");
  });

  test("accepts full model ID as compactionModel", () => {
    const result = AgentConfigSchema.safeParse({
      name: "test-agent",
      compactionModel: "claude-3-haiku-20240307",
    });
    expect(result.success).toBe(true);
    expect(result.data?.compactionModel).toBe("claude-3-haiku-20240307");
  });

  test("compactionModel is optional — omitted is valid", () => {
    const result = AgentConfigSchema.safeParse({ name: "test-agent" });
    expect(result.success).toBe(true);
    expect(result.data?.compactionModel).toBeUndefined();
  });

  test("accepts compactionEnabled=true", () => {
    const result = AgentConfigSchema.safeParse({
      name: "test-agent",
      compactionEnabled: true,
    });
    expect(result.success).toBe(true);
    expect(result.data?.compactionEnabled).toBe(true);
  });

  test("accepts compactionEnabled=false", () => {
    const result = AgentConfigSchema.safeParse({
      name: "test-agent",
      compactionEnabled: false,
    });
    expect(result.success).toBe(true);
    expect(result.data?.compactionEnabled).toBe(false);
  });

  test("compactionEnabled is optional — omitted is valid", () => {
    const result = AgentConfigSchema.safeParse({ name: "test-agent" });
    expect(result.success).toBe(true);
    expect(result.data?.compactionEnabled).toBeUndefined();
  });

  test("both fields together are valid", () => {
    const result = AgentConfigSchema.safeParse({
      name: "test-agent",
      compactionModel: "haiku",
      compactionEnabled: true,
    });
    expect(result.success).toBe(true);
    expect(result.data?.compactionModel).toBe("haiku");
    expect(result.data?.compactionEnabled).toBe(true);
  });

  test("rejects non-string compactionModel", () => {
    const result = AgentConfigSchema.safeParse({
      name: "test-agent",
      compactionModel: 42,
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-boolean compactionEnabled", () => {
    const result = AgentConfigSchema.safeParse({
      name: "test-agent",
      compactionEnabled: "yes",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Compaction arg logic (mirrors agent-manager.ts buildStartSpec logic)
// ---------------------------------------------------------------------------

/**
 * Simulate the arg-building logic from agent-manager.ts buildStartSpec.
 * Returns the generated args array for compaction-related flags.
 */
function buildCompactionArgs(agent: {
  compactionModel?: string;
  compactionEnabled?: boolean;
}): string[] {
  const args: string[] = [];
  const compactionEnabled = agent.compactionEnabled !== false;
  if (compactionEnabled && agent.compactionModel) {
    args.push("--compaction-model", agent.compactionModel);
  } else if (!compactionEnabled) {
    args.push("--no-compaction");
  }
  return args;
}

describe("compaction arg generation", () => {
  test("no compaction args when neither field set", () => {
    expect(buildCompactionArgs({})).toEqual([]);
  });

  test("passes --compaction-model when model is set and enabled is unset (defaults true)", () => {
    const args = buildCompactionArgs({ compactionModel: "haiku" });
    expect(args).toContain("--compaction-model");
    expect(args).toContain("haiku");
  });

  test("passes --compaction-model when both model and enabled=true are set", () => {
    const args = buildCompactionArgs({ compactionModel: "haiku", compactionEnabled: true });
    expect(args).toContain("--compaction-model");
    expect(args).toContain("haiku");
  });

  test("passes --no-compaction when compactionEnabled=false", () => {
    const args = buildCompactionArgs({ compactionEnabled: false });
    expect(args).toContain("--no-compaction");
    expect(args).not.toContain("--compaction-model");
  });

  test("--no-compaction takes precedence even if model is set", () => {
    const args = buildCompactionArgs({ compactionModel: "haiku", compactionEnabled: false });
    expect(args).toContain("--no-compaction");
    expect(args).not.toContain("--compaction-model");
  });

  test("no args added when enabled=true but no model", () => {
    const args = buildCompactionArgs({ compactionEnabled: true });
    expect(args).toEqual([]);
  });

  test("model arg is immediately followed by model value", () => {
    const args = buildCompactionArgs({ compactionModel: "claude-3-haiku-20240307" });
    const idx = args.indexOf("--compaction-model");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("claude-3-haiku-20240307");
  });
});
