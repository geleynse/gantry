/**
 * Tests for the layered prompt composer (#212a).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { composePrompt } from "./prompt-composer.js";

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  // Create a fresh temp dir for each test
  tmpDir = `/tmp/prompt-composer-test-${Date.now()}`;
  mkdirSync(join(tmpDir, "roles"), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(relPath: string, content: string): void {
  writeFileSync(join(tmpDir, relPath), content, "utf-8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("composePrompt — layered mode (base-agent.txt present)", () => {
  it("composes base + role + agent layers", () => {
    writeFile("roles/base-agent.txt", "BASE: I am {{CHARACTER_NAME}} of {{EMPIRE}}.");
    writeFile("roles/trader.txt", "ROLE: trader priorities.");
    writeFile("test-agent.txt", "AGENT: My specific mission.");

    const result = composePrompt({
      fleetDir: tmpDir,
      agentName: "test-agent",
      roleType: "trader",
      role: "Trader/Mining",
      faction: "solarian",
    });

    expect(result.layered).toBe(true);
    expect(result.prompt).toContain("BASE: I am Test Agent of solarian.");
    expect(result.prompt).toContain("ROLE: trader priorities.");
    expect(result.prompt).toContain("AGENT: My specific mission.");
    expect(result.layers).toContain("roles/base-agent.txt");
    expect(result.layers).toContain("roles/trader.txt");
    expect(result.layers).toContain("test-agent.txt");
  });

  it("includes values and shared rule files when present", () => {
    writeFile("roles/base-agent.txt", "BASE.");
    writeFile("test-agent.txt", "AGENT.");
    writeFile("test-agent-values.txt", "PERSONALITY: bold and direct.");
    writeFile("common-rules.txt", "COMMON: use batch_mine.");
    writeFile("personality-rules.txt", "PERS_RULES: keep it short.");

    const result = composePrompt({
      fleetDir: tmpDir,
      agentName: "test-agent",
    });

    expect(result.prompt).toContain("PERSONALITY: bold and direct.");
    expect(result.prompt).toContain("COMMON: use batch_mine.");
    expect(result.prompt).toContain("PERS_RULES: keep it short.");
    expect(result.layers).toContain("test-agent-values.txt");
    expect(result.layers).toContain("common-rules.txt");
    expect(result.layers).toContain("personality-rules.txt");
  });

  it("skips role file gracefully when roleType has no matching file", () => {
    writeFile("roles/base-agent.txt", "BASE.");
    writeFile("test-agent.txt", "AGENT.");

    const result = composePrompt({
      fleetDir: tmpDir,
      agentName: "test-agent",
      roleType: "nonexistent-role",
    });

    expect(result.layered).toBe(true);
    expect(result.layers).not.toContain("roles/nonexistent-role.txt");
    expect(result.prompt).toContain("BASE.");
    expect(result.prompt).toContain("AGENT.");
  });

  it("substitutes template variables in all layers", () => {
    writeFile("roles/base-agent.txt", "BASE: {{CHARACTER_NAME}} from {{EMPIRE}}.");
    writeFile("roles/combat.txt", "ROLE: {{AGENT_NAME}} fights for {{FACTION}}.");
    writeFile("iron-fist.txt", "AGENT: {{ROLE}} specialization.");

    const result = composePrompt({
      fleetDir: tmpDir,
      agentName: "iron-fist",
      roleType: "combat",
      role: "Combat/Patrol",
      faction: "crimson",
    });

    expect(result.prompt).toContain("BASE: Iron Fist from crimson.");
    expect(result.prompt).toContain("ROLE: Iron Fist fights for crimson.");
    expect(result.prompt).toContain("AGENT: Combat/Patrol specialization.");
  });

  it("handles missing agent-specific file gracefully", () => {
    writeFile("roles/base-agent.txt", "BASE.");
    // No agent.txt — should still compose with just base

    const result = composePrompt({
      fleetDir: tmpDir,
      agentName: "ghost-agent",
    });

    expect(result.layered).toBe(true);
    expect(result.prompt).toContain("BASE.");
    expect(result.layers).not.toContain("ghost-agent.txt");
  });
});

describe("composePrompt — flat fallback (no base-agent.txt)", () => {
  it("falls back to flat mode when base-agent.txt is absent", () => {
    writeFile("test-agent.txt", "FLAT: My flat prompt.");
    writeFile("common-rules.txt", "COMMON: rules.");

    const result = composePrompt({
      fleetDir: tmpDir,
      agentName: "test-agent",
    });

    expect(result.layered).toBe(false);
    expect(result.prompt).toContain("FLAT: My flat prompt.");
    expect(result.prompt).toContain("COMMON: rules.");
    expect(result.layers).toContain("test-agent.txt");
    expect(result.layers).toContain("common-rules.txt");
  });

  it("flat mode still substitutes template variables", () => {
    writeFile("my-agent.txt", "I am {{CHARACTER_NAME}} of {{FACTION}}.");

    const result = composePrompt({
      fleetDir: tmpDir,
      agentName: "my-agent",
      faction: "nebula",
    });

    expect(result.layered).toBe(false);
    expect(result.prompt).toContain("I am My Agent of nebula.");
  });
});
