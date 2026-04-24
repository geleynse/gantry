import { describe, expect, test } from "bun:test";
import { analyzePrayerProgram } from "./analyzer.js";
import { parsePrayerScript } from "./parser.js";
import { PrayerAnalyzeError, type AnalyzerSnapshot } from "./types.js";

const snapshot: AnalyzerSnapshot = {
  agentName: "test-agent",
  currentSystem: "sol",
  currentPoi: "sol_station",
  items: [{ id: "iron_ore", name: "Iron Ore" }, { id: "copper_ore", name: "Copper Ore" }],
  pois: [{ id: "sol_station", name: "Sol Station", type: "station" }],
  agentDeniedTools: {},
  fuzzyMatchThreshold: 0.62,
};

describe("PrayerLang analyzer", () => {
  test("analyzes supported command and resolves fuzzy item ids", () => {
    const result = analyzePrayerProgram(parsePrayerScript("mine irn_ore;"), snapshot);
    expect(result.statements[0].kind).toBe("command");
    expect(result.warnings[0].message).toContain("iron_ore");
  });

  test("resolves $here during analysis", () => {
    const result = analyzePrayerProgram(parsePrayerScript("go $here;"), snapshot);
    const stmt = result.statements[0];
    expect(stmt.kind).toBe("command");
    if (stmt.kind === "command") expect(stmt.cmd.args[0]).toEqual({ kind: "static", value: "sol" });
  });

  test("rejects unsupported destructive commands", () => {
    expect(() => analyzePrayerProgram(parsePrayerScript("self_destruct;"), snapshot)).toThrow(PrayerAnalyzeError);
  });

  test("checks denied backing tools", () => {
    expect(() => analyzePrayerProgram(parsePrayerScript("sell;"), {
      ...snapshot,
      agentDeniedTools: { "test-agent": { multi_sell: "not for this role" } },
    })).toThrow(PrayerAnalyzeError);
  });
});
