import { describe, expect, test } from "bun:test";
import { runPrayerScript } from "./index.js";
import type { GameClientLike } from "../compound-tools/index.js";

function makeClient(): GameClientLike {
  return {
    execute: async () => ({ result: {} }),
    waitForTick: async () => {},
    lastArrivalTick: null,
  };
}

describe("PrayerLang executor", () => {
  test("runs native halt", async () => {
    const result = await runPrayerScript("halt;", {
      agentName: "test-agent",
      client: makeClient(),
      compoundActions: {},
      statusCache: new Map([["test-agent", { fetchedAt: Date.now(), data: { player: { credits: 5 }, ship: { fuel: 10, cargo: [] } } }]]),
      agentDeniedTools: {},
      handlePassthrough: async () => ({}),
      maxSteps: 10,
      maxLoopIters: 10,
      maxWallClockMs: 60_000,
    });
    expect(result.status).toBe("halted");
    expect(result.steps_executed).toBe(1);
  });

  test("dispatches mine to batch_mine", async () => {
    const calls: string[] = [];
    const result = await runPrayerScript("mine iron_ore;", {
      agentName: "test-agent",
      client: makeClient(),
      compoundActions: {
        batch_mine: async () => {
          calls.push("batch_mine");
          return { status: "completed" };
        },
      },
      statusCache: new Map([["test-agent", {
        fetchedAt: Date.now(),
        data: {
          player: { credits: 5 },
          ship: { cargo: [{ item_id: "iron_ore", quantity: 1 }], cargo_used: 1, cargo_capacity: 10 },
        },
      }]]),
      agentDeniedTools: {},
      handlePassthrough: async () => ({}),
      maxSteps: 10,
      maxLoopIters: 10,
      maxWallClockMs: 60_000,
    });
    expect(result.status).toBe("completed");
    expect(calls).toEqual(["batch_mine"]);
  });

  test("evaluates if predicates", async () => {
    const calls: string[] = [];
    const result = await runPrayerScript("if FUEL() < 20 { refuel; }", {
      agentName: "test-agent",
      client: makeClient(),
      compoundActions: {},
      statusCache: new Map([["test-agent", { fetchedAt: Date.now(), data: { player: { credits: 5 }, ship: { fuel: 10, cargo: [] } } }]]),
      agentDeniedTools: {},
      handlePassthrough: async (tool) => {
        calls.push(tool);
        return { status: "ok" };
      },
      maxSteps: 10,
      maxLoopIters: 10,
      maxWallClockMs: 60_000,
    });
    expect(result.status).toBe("completed");
    expect(calls).toEqual(["refuel"]);
  });

  test("bare stash deposits all cargo entries as one PrayerLang step", async () => {
    const deposits: unknown[] = [];
    const result = await runPrayerScript("stash;", {
      agentName: "test-agent",
      client: makeClient(),
      compoundActions: {},
      statusCache: new Map([["test-agent", {
        fetchedAt: Date.now(),
        data: {
          player: { credits: 5 },
          ship: {
            cargo: [
              { item_id: "iron_ore", quantity: 2 },
              { item_id: "copper_ore", quantity: 3 },
            ],
          },
        },
      }]]),
      agentDeniedTools: {},
      handlePassthrough: async (_tool, args) => {
        deposits.push(args);
        return { status: "ok" };
      },
      maxSteps: 10,
      maxLoopIters: 10,
      maxWallClockMs: 60_000,
    });
    expect(result.status).toBe("completed");
    expect(result.steps_executed).toBe(1);
    expect(deposits).toEqual([
      { item_id: "iron_ore", quantity: 2 },
      { item_id: "copper_ore", quantity: 3 },
    ]);
  });

  test("interrupts a running script when battleCache becomes populated", async () => {
    const battleCache = new Map<string, unknown>();
    let tickCount = 0;
    const client: GameClientLike = {
      execute: async () => ({ result: {} }),
      waitForTick: async () => {
        tickCount++;
        if (tickCount === 2) battleCache.set("test-agent", { active: true });
      },
      lastArrivalTick: null,
    };

    const result = await runPrayerScript("wait 1; wait 1; wait 1; wait 1;", {
      agentName: "test-agent",
      client,
      compoundActions: {},
      statusCache: new Map([["test-agent", { fetchedAt: Date.now(), data: { player: { credits: 5 }, ship: { fuel: 10, cargo: [] } } }]]),
      battleCache,
      agentDeniedTools: {},
      handlePassthrough: async () => ({}),
      maxSteps: 10,
      maxLoopIters: 10,
      maxWallClockMs: 60_000,
    });

    expect(result.status).toBe("interrupted");
    expect(result.steps_executed).toBeLessThan(4);
    expect(result.steps_executed).toBeGreaterThanOrEqual(2);
  });

  test("interrupts a running script when eventBuffer reports a dangerous event", async () => {
    const pirateSeen = { seen: false };
    const eventBuffers = new Map<string, { hasEventOfType(types: string[]): boolean }>([
      [
        "test-agent",
        {
          hasEventOfType: (types: string[]) => pirateSeen.seen && types.includes("pirate_warning"),
        },
      ],
    ]);
    let tickCount = 0;
    const client: GameClientLike = {
      execute: async () => ({ result: {} }),
      waitForTick: async () => {
        tickCount++;
        if (tickCount === 2) pirateSeen.seen = true;
      },
      lastArrivalTick: null,
    };

    const result = await runPrayerScript("wait 1; wait 1; wait 1; wait 1;", {
      agentName: "test-agent",
      client,
      compoundActions: {},
      statusCache: new Map([["test-agent", { fetchedAt: Date.now(), data: { player: { credits: 5 }, ship: { fuel: 10, cargo: [] } } }]]),
      eventBuffers,
      agentDeniedTools: {},
      handlePassthrough: async () => ({}),
      maxSteps: 10,
      maxLoopIters: 10,
      maxWallClockMs: 60_000,
    });

    expect(result.status).toBe("interrupted");
    expect(result.steps_executed).toBeLessThan(4);
  });

  test("completes normally when no interrupt fires", async () => {
    const result = await runPrayerScript("wait 1; wait 1;", {
      agentName: "test-agent",
      client: makeClient(),
      compoundActions: {},
      statusCache: new Map([["test-agent", { fetchedAt: Date.now(), data: { player: { credits: 5 }, ship: { fuel: 10, cargo: [] } } }]]),
      battleCache: new Map(),
      eventBuffers: new Map([["test-agent", { hasEventOfType: () => false }]]),
      agentDeniedTools: {},
      handlePassthrough: async () => ({}),
      maxSteps: 10,
      maxLoopIters: 10,
      maxWallClockMs: 60_000,
    });
    expect(result.status).toBe("completed");
    expect(result.steps_executed).toBe(2);
  });

  test("dispatches jump to jump_route compound action with system_ids", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const result = await runPrayerScript("jump solara;", {
      agentName: "test-agent",
      client: makeClient(),
      compoundActions: {
        jump_route: async (_client, _agentName, args) => {
          calls.push({ tool: "jump_route", args });
          return { status: "completed", jumps_completed: 1 };
        },
      },
      statusCache: new Map([["test-agent", { fetchedAt: Date.now(), data: { player: { credits: 5 }, ship: { fuel: 10, cargo: [] } } }]]),
      agentDeniedTools: {},
      handlePassthrough: async () => ({}),
      maxSteps: 10,
      maxLoopIters: 10,
      maxWallClockMs: 60_000,
    });
    expect(result.status).toBe("completed");
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe("jump_route");
    expect(calls[0].args).toEqual({ system_ids: ["solara"] });
  });

  test("onCheckpoint fires after each step boundary", async () => {
    const snapshots: number[] = [];
    const result = await runPrayerScript("wait 1; wait 1; wait 1;", {
      agentName: "test-agent",
      client: makeClient(),
      compoundActions: {},
      statusCache: new Map([["test-agent", { fetchedAt: Date.now(), data: { player: { credits: 5 }, ship: { fuel: 10, cargo: [] } } }]]),
      agentDeniedTools: {},
      handlePassthrough: async () => ({}),
      maxSteps: 10,
      maxLoopIters: 10,
      maxWallClockMs: 60_000,
      onCheckpoint: (state) => { snapshots.push(state.stepsExecuted); },
    });
    expect(result.status).toBe("completed");
    expect(snapshots).toEqual([1, 2, 3]);
  });

  test("initialState resumes from a checkpointed step counter", async () => {
    const result = await runPrayerScript("wait 1;", {
      agentName: "test-agent",
      client: makeClient(),
      compoundActions: {},
      statusCache: new Map([["test-agent", { fetchedAt: Date.now(), data: { player: { credits: 5 }, ship: { fuel: 10, cargo: [] } } }]]),
      agentDeniedTools: {},
      handlePassthrough: async () => ({}),
      maxSteps: 10,
      maxLoopIters: 10,
      maxWallClockMs: 60_000,
      initialState: {
        stepsExecuted: 7,
        startedAt: Date.now(),
        transientRetriesUsed: 0,
        log: [],
        cargoBaseline: new Map(),
        haltRequested: false,
        interrupt: null,
      },
    });
    expect(result.status).toBe("completed");
    // Resumed from 7, executed 1 wait, ends at 8.
    expect(result.steps_executed).toBe(8);
  });

  test("jump_route failure surfaces as fatal error", async () => {
    const result = await runPrayerScript("jump nowhere;", {
      agentName: "test-agent",
      client: makeClient(),
      compoundActions: {
        jump_route: async () => ({ error: "no_route", message: "Cannot reach destination" }),
      },
      statusCache: new Map([["test-agent", { fetchedAt: Date.now(), data: { player: { credits: 5 }, ship: { fuel: 10, cargo: [] } } }]]),
      agentDeniedTools: {},
      handlePassthrough: async () => ({}),
      maxSteps: 10,
      maxLoopIters: 10,
      maxWallClockMs: 60_000,
    });
    expect(result.status).toBe("error");
    expect(result.error?.code).toContain("tool_fatal");
  });

  test("survey dispatches to survey_system passthrough", async () => {
    const calls: string[] = [];
    const result = await runPrayerScript("survey;", {
      agentName: "test-agent",
      client: makeClient(),
      compoundActions: {},
      statusCache: new Map([["test-agent", { fetchedAt: Date.now(), data: { player: { credits: 5 }, ship: { fuel: 10, cargo: [] } } }]]),
      agentDeniedTools: {},
      handlePassthrough: async (tool) => {
        calls.push(tool);
        return { status: "ok", exploration_data: {} };
      },
      maxSteps: 10,
      maxLoopIters: 10,
      maxWallClockMs: 60_000,
    });
    expect(result.status).toBe("completed");
    expect(calls).toEqual(["survey_system"]);
  });

  test("retrieve dispatches to withdraw_items with item + quantity", async () => {
    const calls: Array<{ tool: string; args: unknown }> = [];
    const result = await runPrayerScript("retrieve iron_ore 50;", {
      agentName: "test-agent",
      client: makeClient(),
      compoundActions: {},
      statusCache: new Map([["test-agent", { fetchedAt: Date.now(), data: { player: { credits: 5 }, ship: { fuel: 10, cargo: [] } } }]]),
      agentDeniedTools: {},
      handlePassthrough: async (tool, args) => {
        calls.push({ tool, args });
        return { status: "ok" };
      },
      maxSteps: 10,
      maxLoopIters: 10,
      maxWallClockMs: 60_000,
    });
    expect(result.status).toBe("completed");
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe("withdraw_items");
    expect(calls[0].args).toEqual({ item_id: "iron_ore", quantity: 50 });
  });

  test("retrieve defaults quantity to 1 when not provided", async () => {
    const calls: Array<{ tool: string; args: unknown }> = [];
    const result = await runPrayerScript("retrieve copper_ore;", {
      agentName: "test-agent",
      client: makeClient(),
      compoundActions: {},
      statusCache: new Map([["test-agent", { fetchedAt: Date.now(), data: { player: { credits: 5 }, ship: { fuel: 10, cargo: [] } } }]]),
      agentDeniedTools: {},
      handlePassthrough: async (tool, args) => {
        calls.push({ tool, args });
        return { status: "ok" };
      },
      maxSteps: 10,
      maxLoopIters: 10,
      maxWallClockMs: 60_000,
    });
    expect(result.status).toBe("completed");
    expect(calls[0].args).toEqual({ item_id: "copper_ore", quantity: 1 });
  });

  test("buy dispatches to buy passthrough with item_id + quantity", async () => {
    const calls: Array<{ tool: string; args: unknown }> = [];
    const result = await runPrayerScript("buy fuel 10;", {
      agentName: "test-agent",
      client: makeClient(),
      compoundActions: {},
      statusCache: new Map([["test-agent", { fetchedAt: Date.now(), data: { player: { credits: 500 }, ship: { fuel: 10, cargo: [] } } }]]),
      agentDeniedTools: {},
      handlePassthrough: async (tool, args) => {
        calls.push({ tool, args });
        return { status: "ok" };
      },
      maxSteps: 10,
      maxLoopIters: 10,
      maxWallClockMs: 60_000,
    });
    expect(result.status).toBe("completed");
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe("buy");
    expect(calls[0].args).toEqual({ item_id: "fuel", quantity: 10 });
  });

  test("accept_mission dispatches to accept_mission passthrough with mission_id", async () => {
    const calls: Array<{ tool: string; args: unknown }> = [];
    const result = await runPrayerScript("accept_mission common_iron_supply;", {
      agentName: "test-agent",
      client: makeClient(),
      compoundActions: {},
      statusCache: new Map([["test-agent", { fetchedAt: Date.now(), data: { player: { credits: 100 }, ship: { fuel: 10, cargo: [] } } }]]),
      agentDeniedTools: {},
      handlePassthrough: async (tool, args) => {
        calls.push({ tool, args });
        return { status: "ok" };
      },
      maxSteps: 10,
      maxLoopIters: 10,
      maxWallClockMs: 60_000,
    });
    expect(result.status).toBe("completed");
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe("accept_mission");
    expect(calls[0].args).toEqual({ mission_id: "common_iron_supply" });
  });

  test("MISSION_ACTIVE predicate gates accept_mission correctly", async () => {
    const calls: string[] = [];
    const result = await runPrayerScript("if MISSION_ACTIVE() == 0 { accept_mission common_iron_supply; }", {
      agentName: "test-agent",
      client: makeClient(),
      compoundActions: {},
      statusCache: new Map([["test-agent", { fetchedAt: Date.now(), data: { player: { credits: 100 }, ship: { fuel: 10, cargo: [] }, active_missions: [] } }]]),
      agentDeniedTools: {},
      handlePassthrough: async (tool) => {
        calls.push(tool);
        return { status: "ok" };
      },
      maxSteps: 10,
      maxLoopIters: 10,
      maxWallClockMs: 60_000,
    });
    // active_missions is empty → MISSION_ACTIVE() == 0 is true → accept_mission fires
    expect(result.status).toBe("completed");
    expect(calls).toEqual(["accept_mission"]);
  });

  test("MISSION_ACTIVE predicate skips accept_mission when missions exist", async () => {
    const calls: string[] = [];
    const result = await runPrayerScript("if MISSION_ACTIVE() == 0 { accept_mission common_iron_supply; }", {
      agentName: "test-agent",
      client: makeClient(),
      compoundActions: {},
      statusCache: new Map([["test-agent", { fetchedAt: Date.now(), data: { player: { credits: 100 }, ship: { fuel: 10, cargo: [] }, active_missions: [{ id: "m1" }] } }]]),
      agentDeniedTools: {},
      handlePassthrough: async (tool) => {
        calls.push(tool);
        return { status: "ok" };
      },
      maxSteps: 10,
      maxLoopIters: 10,
      maxWallClockMs: 60_000,
    });
    // active_missions has 1 entry → MISSION_ACTIVE() == 0 is false → accept_mission does NOT fire
    expect(result.status).toBe("completed");
    expect(calls).toHaveLength(0);
  });

  test("accept_mission no-such-mission error classifies as fatal", async () => {
    const result = await runPrayerScript("accept_mission nonexistent_mission;", {
      agentName: "test-agent",
      client: makeClient(),
      compoundActions: {},
      statusCache: new Map([["test-agent", { fetchedAt: Date.now(), data: { player: { credits: 100 }, ship: { fuel: 10, cargo: [] } } }]]),
      agentDeniedTools: {},
      handlePassthrough: async () => ({ error: "mission_not_found", message: "No such mission" }),
      maxSteps: 10,
      maxLoopIters: 10,
      maxWallClockMs: 60_000,
    });
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("tool_fatal");
  });
});
