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
});
