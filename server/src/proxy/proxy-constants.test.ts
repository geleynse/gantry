/**
 * Unit tests for proxy-constants invariants.
 */

import { describe, it, expect } from "bun:test";
import { STATE_CHANGING_TOOLS, MUTATION_COMMANDS } from "./proxy-constants.js";

describe("proxy-constants invariants", () => {
  it("MUTATION_COMMANDS is a subset of STATE_CHANGING_TOOLS", () => {
    const violations: string[] = [];
    for (const cmd of MUTATION_COMMANDS) {
      if (!STATE_CHANGING_TOOLS.has(cmd)) {
        violations.push(cmd);
      }
    }
    if (violations.length > 0) {
      console.error(
        `[proxy-constants] MUTATION_COMMANDS entries missing from STATE_CHANGING_TOOLS:\n` +
        violations.map((t) => `  - ${t}`).join("\n"),
      );
    }
    expect(violations).toEqual([]);
  });

  it("configure_recycler is in STATE_CHANGING_TOOLS", () => {
    expect(STATE_CHANGING_TOOLS.has("configure_recycler")).toBe(true);
  });

  it("configure_recycler is in MUTATION_COMMANDS", () => {
    expect(MUTATION_COMMANDS.has("configure_recycler")).toBe(true);
  });
});
