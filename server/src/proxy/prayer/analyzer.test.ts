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

  test("analyzes STASHED(item) predicate", () => {
    const result = analyzePrayerProgram(parsePrayerScript("if STASHED(iron_ore) > 0 { halt; }"), snapshot);
    const stmt = result.statements[0];
    expect(stmt.kind).toBe("if");
    if (stmt.kind === "if") {
      expect(stmt.cond.metric).toBe("STASHED");
      expect(stmt.cond.args).toEqual([{ kind: "static", value: "iron_ore" }]);
    }
  });

  test("analyzes STASH(poi, item) predicate with destination + item args", () => {
    const result = analyzePrayerProgram(parsePrayerScript("if STASH(sol_station, iron_ore) >= 50 { halt; }"), snapshot);
    const stmt = result.statements[0];
    expect(stmt.kind).toBe("if");
    if (stmt.kind === "if") {
      expect(stmt.cond.metric).toBe("STASH");
      expect(stmt.cond.args).toHaveLength(2);
      expect(stmt.cond.args[0]).toEqual({ kind: "static", value: "sol_station" });
      expect(stmt.cond.args[1]).toEqual({ kind: "static", value: "iron_ore" });
    }
  });

  test("analyzes survey command (no args)", () => {
    const result = analyzePrayerProgram(parsePrayerScript("survey;"), snapshot);
    expect(result.statements[0].kind).toBe("command");
    if (result.statements[0].kind === "command") {
      expect(result.statements[0].cmd.spec.name).toBe("survey");
      expect(result.statements[0].cmd.args).toHaveLength(0);
    }
  });

  test("analyzes retrieve command with item + quantity", () => {
    const result = analyzePrayerProgram(parsePrayerScript("retrieve iron_ore 50;"), snapshot);
    expect(result.statements[0].kind).toBe("command");
    if (result.statements[0].kind === "command") {
      expect(result.statements[0].cmd.spec.name).toBe("retrieve");
      expect(result.statements[0].cmd.args).toHaveLength(2);
    }
  });

  test("analyzes retrieve command with item only (no quantity)", () => {
    const result = analyzePrayerProgram(parsePrayerScript("retrieve iron_ore;"), snapshot);
    expect(result.statements[0].kind).toBe("command");
    if (result.statements[0].kind === "command") {
      expect(result.statements[0].cmd.spec.name).toBe("retrieve");
      expect(result.statements[0].cmd.args).toHaveLength(1);
    }
  });

  test("analyzes buy command with item + quantity", () => {
    const result = analyzePrayerProgram(parsePrayerScript("buy iron_ore 10;"), snapshot);
    expect(result.statements[0].kind).toBe("command");
    if (result.statements[0].kind === "command") {
      expect(result.statements[0].cmd.spec.name).toBe("buy");
      expect(result.statements[0].cmd.args).toHaveLength(2);
    }
  });

  test("analyzes accept_mission command with mission id", () => {
    const result = analyzePrayerProgram(parsePrayerScript("accept_mission common_iron_supply;"), snapshot);
    expect(result.statements[0].kind).toBe("command");
    if (result.statements[0].kind === "command") {
      expect(result.statements[0].cmd.spec.name).toBe("accept_mission");
      expect(result.statements[0].cmd.args).toHaveLength(1);
      expect(result.statements[0].cmd.args[0]).toEqual({ kind: "static", value: "common_iron_supply" });
    }
  });

  test("analyzes MISSION_ACTIVE() predicate", () => {
    const result = analyzePrayerProgram(parsePrayerScript("if MISSION_ACTIVE() == 0 { accept_mission common_iron_supply; }"), snapshot);
    const stmt = result.statements[0];
    expect(stmt.kind).toBe("if");
    if (stmt.kind === "if") {
      expect(stmt.cond.metric).toBe("MISSION_ACTIVE");
      expect(stmt.cond.args).toHaveLength(0);
    }
  });

  test("rejects buy command with wrong arity (missing quantity)", () => {
    expect(() => analyzePrayerProgram(parsePrayerScript("buy iron_ore;"), snapshot)).toThrow(PrayerAnalyzeError);
  });

  test("rejects craft command as unsupported", () => {
    expect(() => analyzePrayerProgram(parsePrayerScript("craft steel_plate;"), snapshot)).toThrow(PrayerAnalyzeError);
  });

  test("checks denied backing tool for survey", () => {
    expect(() => analyzePrayerProgram(parsePrayerScript("survey;"), {
      ...snapshot,
      agentDeniedTools: { "test-agent": { survey_system: "not for this role" } },
    })).toThrow(PrayerAnalyzeError);
  });

  test("checks denied backing tool for buy", () => {
    expect(() => analyzePrayerProgram(parsePrayerScript("buy iron_ore 10;"), {
      ...snapshot,
      agentDeniedTools: { "test-agent": { buy: "market access denied" } },
    })).toThrow(PrayerAnalyzeError);
  });

  test("checks denied backing tool for accept_mission", () => {
    expect(() => analyzePrayerProgram(parsePrayerScript("accept_mission rescue_voss;"), {
      ...snapshot,
      agentDeniedTools: { "*": { accept_mission: "missions disabled globally" } },
    })).toThrow(PrayerAnalyzeError);
  });
});
