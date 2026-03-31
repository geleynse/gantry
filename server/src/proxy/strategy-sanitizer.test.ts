import { describe, it, expect } from "bun:test";
import { sanitizeStrategyContent, STRATEGY_CONTAMINATION_PATTERNS } from "./strategy-sanitizer.js";

describe("sanitizeStrategyContent", () => {
  // ── Clean content passes through unchanged ──────────────────────────────────

  it("returns content unchanged when no patterns match", () => {
    const content = "Mine ore at asteroid belt.\nSell at station Alpha.\nBuy fuel before jump.";
    const { cleaned, removed } = sanitizeStrategyContent(content);
    expect(cleaned).toBe(content);
    expect(removed).toHaveLength(0);
  });

  it("returns empty removed list for entirely clean content", () => {
    const content = "Plan: travel to Nexus Prime, mine iron, sell at Vega Station.";
    const { removed } = sanitizeStrategyContent(content);
    expect(removed).toEqual([]);
  });

  it("handles empty string without error", () => {
    const { cleaned, removed } = sanitizeStrategyContent("");
    expect(cleaned).toBe("");
    expect(removed).toHaveLength(0);
  });

  it("handles single-line clean content", () => {
    const content = "Currently docked at Vega Station. Credits: 45000.";
    const { cleaned, removed } = sanitizeStrategyContent(content);
    expect(cleaned).toBe(content);
    expect(removed).toHaveLength(0);
  });

  // ── Contaminated lines are stripped ────────────────────────────────────────

  it("strips line containing 'navigation unstable'", () => {
    const content = "Mine ore at belt.\nNavigation unstable — cannot jump.\nSell at station.";
    const { cleaned, removed } = sanitizeStrategyContent(content);
    expect(cleaned).toBe("Mine ore at belt.\nSell at station.");
    expect(removed).toEqual(["Navigation unstable — cannot jump."]);
  });

  it("strips line containing 'backend failure'", () => {
    const content = "Status: active.\nBackend failure detected in jump system.\nContinue trading.";
    const { cleaned, removed } = sanitizeStrategyContent(content);
    expect(cleaned).toBe("Status: active.\nContinue trading.");
    expect(removed).toHaveLength(1);
    expect(removed[0]).toContain("Backend failure");
  });

  it("strips line containing 'infrastructure lock'", () => {
    const content = "Credits: 20000.\nInfrastructure lock on docking bay.\nNext: mine copper.";
    const { cleaned, removed } = sanitizeStrategyContent(content);
    expect(cleaned).toBe("Credits: 20000.\nNext: mine copper.");
    expect(removed).toHaveLength(1);
  });

  it("strips line containing 'queue lock'", () => {
    const content = "Docked at Nexus.\nQueue lock preventing action dispatch.\nWaiting for tick.";
    const { cleaned, removed } = sanitizeStrategyContent(content);
    expect(cleaned).toBe("Docked at Nexus.\nWaiting for tick.");
    expect(removed).toHaveLength(1);
  });

  it("strips line containing 'phantom'", () => {
    const content = "Location: Vega Prime.\nPhantom cargo detected in hold.\nCargo: iron x50.";
    const { cleaned, removed } = sanitizeStrategyContent(content);
    expect(cleaned).toBe("Location: Vega Prime.\nCargo: iron x50.");
    expect(removed).toHaveLength(1);
  });

  it("strips line containing 'cache lag'", () => {
    const content = "Jump route planned.\nCache lag causing stale location data.\nArriving soon.";
    const { cleaned, removed } = sanitizeStrategyContent(content);
    expect(cleaned).toBe("Jump route planned.\nArriving soon.");
    expect(removed).toHaveLength(1);
  });

  it("strips line containing 'deadlock'", () => {
    const content = "At station Alpha.\nDeadlock in action queue detected.\nFueling ship now.";
    const { cleaned, removed } = sanitizeStrategyContent(content);
    expect(cleaned).toBe("At station Alpha.\nFueling ship now.");
    expect(removed).toHaveLength(1);
  });

  it("strips line containing 'system degraded'", () => {
    const content = "Mission: explore Nexus.\nSystem degraded — tools unresponsive.\nRetrying navigation.";
    const { cleaned, removed } = sanitizeStrategyContent(content);
    expect(cleaned).toBe("Mission: explore Nexus.\nRetrying navigation.");
    expect(removed).toHaveLength(1);
  });

  it("strips line containing 'data corruption'", () => {
    const content = "Credits: 5000.\nData corruption in cargo manifest.\nMining iron.";
    const { cleaned, removed } = sanitizeStrategyContent(content);
    expect(cleaned).toBe("Credits: 5000.\nMining iron.");
    expect(removed).toHaveLength(1);
  });

  // ── Case insensitivity ──────────────────────────────────────────────────────

  it("strips contamination patterns case-insensitively", () => {
    const content = "NAVIGATION UNSTABLE — jump blocked.\nMine ore.";
    const { cleaned, removed } = sanitizeStrategyContent(content);
    expect(cleaned).toBe("Mine ore.");
    expect(removed).toHaveLength(1);
  });

  it("strips mixed-case contamination", () => {
    const content = "System is fine.\nPhAnToM readings on scanner.\nAll good.";
    const { cleaned, removed } = sanitizeStrategyContent(content);
    expect(cleaned).toBe("System is fine.\nAll good.");
    expect(removed).toHaveLength(1);
  });

  // ── Multiple contaminated lines ─────────────────────────────────────────────

  it("strips multiple contaminated lines from one doc", () => {
    const content = [
      "Plan: mine and sell.",
      "Navigation unstable — stuck in hyperspace.",
      "Credits: 10000.",
      "Deadlock in action system.",
      "Next stop: Vega Station.",
      "System degraded — tools blocked.",
    ].join("\n");

    const { cleaned, removed } = sanitizeStrategyContent(content);
    expect(removed).toHaveLength(3);
    const cleanedLines = cleaned.split("\n");
    expect(cleanedLines).toHaveLength(3);
    expect(cleanedLines).toContain("Plan: mine and sell.");
    expect(cleanedLines).toContain("Credits: 10000.");
    expect(cleanedLines).toContain("Next stop: Vega Station.");
  });

  it("returns empty string if all lines are contaminated", () => {
    const content = "Navigation unstable.\nPhantom readings.\nDeadlock detected.";
    const { cleaned, removed } = sanitizeStrategyContent(content);
    expect(cleaned).toBe("");
    expect(removed).toHaveLength(3);
  });

  // ── Removed list accuracy ───────────────────────────────────────────────────

  it("removed list contains the exact original lines", () => {
    const badLine = "  Navigation unstable — hyperspace stuck  ";
    const content = `Good line.\n${badLine}\nAnother good line.`;
    const { removed } = sanitizeStrategyContent(content);
    expect(removed).toEqual([badLine]);
  });

  it("removed list preserves line order", () => {
    const content = "Cache lag issue.\nGood line.\nPhantom cargo.\nAnother good line.\nDeadlock found.";
    const { removed } = sanitizeStrategyContent(content);
    expect(removed[0]).toContain("Cache lag");
    expect(removed[1]).toContain("Phantom");
    expect(removed[2]).toContain("Deadlock");
  });

  // ── Custom patterns ─────────────────────────────────────────────────────────

  it("accepts custom patterns override", () => {
    const content = "Normal line.\nCustom bad word here.\nAnother normal line.";
    const { cleaned, removed } = sanitizeStrategyContent(content, ["custom bad word"]);
    expect(cleaned).toBe("Normal line.\nAnother normal line.");
    expect(removed).toHaveLength(1);
  });

  it("returns content unchanged when patterns array is empty", () => {
    const content = "Navigation unstable.\nPhantom readings.";
    const { cleaned, removed } = sanitizeStrategyContent(content, []);
    expect(cleaned).toBe(content);
    expect(removed).toHaveLength(0);
  });

  // ── Default patterns list ───────────────────────────────────────────────────

  it("STRATEGY_CONTAMINATION_PATTERNS contains all expected patterns", () => {
    expect(STRATEGY_CONTAMINATION_PATTERNS).toContain("navigation unstable");
    expect(STRATEGY_CONTAMINATION_PATTERNS).toContain("backend failure");
    expect(STRATEGY_CONTAMINATION_PATTERNS).toContain("infrastructure lock");
    expect(STRATEGY_CONTAMINATION_PATTERNS).toContain("queue lock");
    expect(STRATEGY_CONTAMINATION_PATTERNS).toContain("phantom");
    expect(STRATEGY_CONTAMINATION_PATTERNS).toContain("cache lag");
    expect(STRATEGY_CONTAMINATION_PATTERNS).toContain("deadlock");
    expect(STRATEGY_CONTAMINATION_PATTERNS).toContain("system degraded");
    expect(STRATEGY_CONTAMINATION_PATTERNS).toContain("data corruption");
  });

  // ── Realistic strategy doc ──────────────────────────────────────────────────

  it("cleans a realistic mixed strategy doc", () => {
    const content = [
      "## Strategy — sable-thorn",
      "Location: Nexus Prime Station",
      "Credits: 28450",
      "Cargo: copper x30, iron x20",
      "Navigation unstable — hyperspace exit failed.",
      "Fuel: 85%",
      "Plan: sell cargo, refuel, then jump to Vega system.",
      "Phantom navigation issue persists — avoid jumps.",
      "Last action: multi_sell completed.",
    ].join("\n");

    const { cleaned, removed } = sanitizeStrategyContent(content);
    expect(removed).toHaveLength(2);
    const cleanedLines = cleaned.split("\n");
    expect(cleanedLines).toContain("Location: Nexus Prime Station");
    expect(cleanedLines).toContain("Plan: sell cargo, refuel, then jump to Vega system.");
    expect(cleanedLines).not.toContain("Navigation unstable — hyperspace exit failed.");
    expect(cleanedLines).not.toContain("Phantom navigation issue persists — avoid jumps.");
  });
});
