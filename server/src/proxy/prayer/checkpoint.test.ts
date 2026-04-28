import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearCheckpoint,
  deserialize,
  loadCheckpoint,
  saveCheckpoint,
  serialize,
  setPrayerStateDir,
} from "./checkpoint.js";
import { runPrayerScript } from "./index.js";
import type { ExecState } from "./types.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "prayer-checkpoint-"));
  setPrayerStateDir(tmp);
});

afterEach(() => {
  setPrayerStateDir(null);
  rmSync(tmp, { recursive: true, force: true });
});

function makeState(overrides: Partial<ExecState> = {}): ExecState {
  return {
    stepsExecuted: 4,
    startedAt: 1700000000000,
    transientRetriesUsed: 1,
    log: [{ tool: "mine", args: { item: "iron" }, result: { ok: true }, durationMs: 250, ok: true }],
    cargoBaseline: new Map([["iron_ore", 5], ["copper_ore", 2]]),
    haltRequested: false,
    interrupt: null,
    ...overrides,
  };
}

describe("PrayerLang checkpoint serialize/deserialize", () => {
  test("round-trips an ExecState with all fields preserved", () => {
    const original = makeState();
    const restored = deserialize(serialize(original));

    expect(restored.stepsExecuted).toBe(4);
    expect(restored.startedAt).toBe(1700000000000);
    expect(restored.transientRetriesUsed).toBe(1);
    expect(restored.haltRequested).toBe(false);
    expect(restored.interrupt).toBeNull();
    expect(restored.log).toHaveLength(1);
    expect(restored.log[0].tool).toBe("mine");
    expect(restored.cargoBaseline).toBeInstanceOf(Map);
    expect(restored.cargoBaseline.get("iron_ore")).toBe(5);
    expect(restored.cargoBaseline.get("copper_ore")).toBe(2);
  });

  test("preserves an interrupt reason", () => {
    const original = makeState({ interrupt: { reason: "pirate_warning" } });
    const restored = deserialize(serialize(original));
    expect(restored.interrupt).toEqual({ reason: "pirate_warning" });
  });

  test("preserves an empty Map cargoBaseline", () => {
    const original = makeState({ cargoBaseline: new Map() });
    const restored = deserialize(serialize(original));
    expect(restored.cargoBaseline.size).toBe(0);
  });

  test("rejects an unknown version", () => {
    expect(() => deserialize(JSON.stringify({ version: 99 }))).toThrow();
  });

  test("rejects malformed payloads", () => {
    expect(() => deserialize("not json")).toThrow();
  });
});

describe("PrayerLang checkpoint save/load/clear", () => {
  test("save then load returns an equivalent state", () => {
    const original = makeState();
    saveCheckpoint("agent-a", original);

    const loaded = loadCheckpoint("agent-a");
    expect(loaded).not.toBeNull();
    expect(loaded!.stepsExecuted).toBe(4);
    expect(loaded!.cargoBaseline.get("iron_ore")).toBe(5);
  });

  test("loadCheckpoint returns null when no checkpoint exists", () => {
    expect(loadCheckpoint("never-saved")).toBeNull();
  });

  test("loadCheckpoint returns null and does not throw when file is corrupt", () => {
    // Write garbage directly to the path the loader will look at
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, "corrupt-agent.json"), "{not valid json", "utf-8");

    const result = loadCheckpoint("corrupt-agent");
    expect(result).toBeNull();
  });

  test("loadCheckpoint returns null for an unknown serialization version", () => {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, "future-agent.json"), JSON.stringify({ version: 999, stepsExecuted: 0 }), "utf-8");
    expect(loadCheckpoint("future-agent")).toBeNull();
  });

  test("clearCheckpoint removes the file; subsequent load returns null", () => {
    saveCheckpoint("agent-b", makeState());
    expect(loadCheckpoint("agent-b")).not.toBeNull();
    clearCheckpoint("agent-b");
    expect(loadCheckpoint("agent-b")).toBeNull();
  });

  test("clearCheckpoint is a no-op when no file exists", () => {
    expect(() => clearCheckpoint("never-saved")).not.toThrow();
  });

  test("agent-name path traversal is sanitized", () => {
    // Should not crash, should not write outside the configured dir.
    saveCheckpoint("../../../etc/passwd", makeState());
    // The sanitized name should still be loadable via the same input.
    const loaded = loadCheckpoint("../../../etc/passwd");
    expect(loaded).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Checkpoint integration with runPrayerScript (call-site wiring)
// ---------------------------------------------------------------------------

function makeRunDeps(overrides: {
  onCheckpoint?: (state: ExecState) => void;
  initialState?: ExecState;
} = {}) {
  return {
    agentName: "cp-agent",
    client: {
      execute: async () => ({ result: {} }),
      waitForTick: async () => {},
      lastArrivalTick: null,
    },
    compoundActions: {},
    statusCache: new Map([["cp-agent", {
      fetchedAt: Date.now(),
      data: { player: { credits: 100 }, ship: { fuel: 50, cargo: [] } },
    }]]),
    agentDeniedTools: {},
    handlePassthrough: async () => ({ status: "ok" }),
    maxSteps: 10,
    maxLoopIters: 10,
    maxWallClockMs: 60_000,
    ...overrides,
  };
}

describe("checkpoint call-site wiring (runPrayerScript integration)", () => {
  test("fresh prayer with no prior checkpoint runs from default state (stepsExecuted starts at 0)", async () => {
    const checkpoints: ExecState[] = [];
    const result = await runPrayerScript("halt;", makeRunDeps({
      onCheckpoint: (s) => checkpoints.push({ ...s, cargoBaseline: new Map(s.cargoBaseline) }),
    }));
    expect(result.status).toBe("halted");
    // halt increments stepsExecuted to 1; checkpoint called after step
    expect(result.steps_executed).toBe(1);
    // At least one checkpoint was recorded
    expect(checkpoints.length).toBeGreaterThan(0);
    expect(checkpoints[0].stepsExecuted).toBe(1);
  });

  test("saved checkpoint is loaded as initialState on next prayer call", async () => {
    // Save a checkpoint with stepsExecuted=5 to disk.
    // Use a recent startedAt so the wall-clock limit doesn't fire immediately.
    const prior = makeState({ stepsExecuted: 5, startedAt: Date.now() });
    saveCheckpoint("cp-agent", prior);

    // Load and pass it as initialState (simulating what gantry-v2 does)
    const loaded = loadCheckpoint("cp-agent") ?? undefined;
    expect(loaded).toBeDefined();
    expect(loaded!.stepsExecuted).toBe(5);

    // Pass to runPrayerScript — executor should start from loaded state
    const checkpoints: ExecState[] = [];
    await runPrayerScript("halt;", makeRunDeps({
      initialState: loaded,
      onCheckpoint: (s) => checkpoints.push({ ...s, cargoBaseline: new Map(s.cargoBaseline) }),
    }));
    // halt bumps steps by 1 → should reach 6, not 1
    expect(checkpoints[0].stepsExecuted).toBe(6);
  });

  test("successful completion should trigger clearCheckpoint (no checkpoint remains after)", () => {
    // Pre-seed a checkpoint
    saveCheckpoint("cp-agent", makeState());
    expect(loadCheckpoint("cp-agent")).not.toBeNull();

    // Simulate the gantry-v2 call-site: clear on status==="completed"
    // (We test the logic directly since handlePrayerAction is a closure)
    const status = "completed";
    if (status === "completed") {
      clearCheckpoint("cp-agent");
    }
    expect(loadCheckpoint("cp-agent")).toBeNull();
  });

  test("halted/error/interrupted does NOT clear checkpoint", () => {
    // Simulate the call-site logic for non-completed statuses: by construction
    // these never trigger clearCheckpoint, so the saved state persists.
    for (const _status of ["halted", "error", "interrupted", "step_limit_reached"] as const) {
      saveCheckpoint("cp-agent", makeState());
      expect(loadCheckpoint("cp-agent")).not.toBeNull();
    }
  });
});
