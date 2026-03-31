/**
 * compound-tools/batch-mine.test.ts
 *
 * Tests for the batch_mine compound tool, imported directly from the source module.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createDatabase, closeDb } from "../../services/database.js";
import { resetSessionShutdownManager, getSessionShutdownManager } from "../session-shutdown.js";
import { batchMine } from "./batch-mine.js";
import type { CompoundToolDeps, GameClientLike } from "./types.js";
import { SellLog } from "../sell-log.js";
import { GalaxyGraph } from "../pathfinder.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type StatusEntry = { data: Record<string, unknown>; fetchedAt: number };

function makeClient(
  overrides: Partial<{
    execute: GameClientLike["execute"];
    waitForTick: GameClientLike["waitForTick"];
  }> = {},
): GameClientLike {
  return {
    execute: overrides.execute ?? (async () => ({ result: { ok: true } })),
    waitForTick: overrides.waitForTick ?? (async () => {}),
    lastArrivalTick: null,
  };
}

function makeStatusCache(
  agentName: string,
  data: Record<string, unknown>,
): Map<string, StatusEntry> {
  const cache = new Map<string, StatusEntry>();
  cache.set(agentName, { data, fetchedAt: Date.now() });
  return cache;
}

function makeDeps(
  agentName: string,
  client: GameClientLike,
  statusCache: Map<string, StatusEntry>,
): CompoundToolDeps {
  return {
    client,
    agentName,
    statusCache,
    battleCache: new Map(),
    sellLog: new SellLog(),
    galaxyGraph: new GalaxyGraph(),
    persistBattleState: () => {},
    upsertNote: () => {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("batch-mine (direct import)", () => {
  beforeEach(() => {
    createDatabase(":memory:");
    resetSessionShutdownManager();
  });

  afterEach(() => {
    closeDb();
  });

  it("mines the specified count and returns completed status with aggregated results", async () => {
    let mineCount = 0;
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_cargo") return { result: { items: [] } };
        mineCount++;
        return { result: { ore: "iron", amount: mineCount } };
      },
    });
    const cache = makeStatusCache("agent", {
      player: { docked_at_base: null },
      ship: { cargo_used: 5, cargo_capacity: 100 },
    });
    const deps = makeDeps("agent", client, cache);

    const result = await batchMine(deps, 3);

    expect(result.status).toBe("completed");
    expect(result.mines_completed).toBe(3);
    expect((result.mined as unknown[]).length).toBe(3);
    expect(result.cargo_after).toEqual({ items: [] });
    expect(result.stopped_reason).toBeUndefined();
  });

  it("returns error immediately when the first mine call fails", async () => {
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_cargo") return { result: {} };
        return { error: { code: "not_at_belt", message: "No asteroid belt nearby" } };
      },
    });
    const cache = makeStatusCache("agent", {
      player: { docked_at_base: null },
    });
    const deps = makeDeps("agent", client, cache);

    const result = await batchMine(deps, 5);

    expect(result.error).toEqual({ code: "not_at_belt", message: "No asteroid belt nearby" });
    expect(result.status).toBeUndefined();
    expect(result.mined).toBeUndefined();
  });

  it("stops mid-run on depletion error and returns stopped_reason=depleted", async () => {
    let callCount = 0;
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_cargo") return { result: {} };
        callCount++;
        if (callCount >= 3) return { error: { code: "belt_depleted" } };
        return { result: { ore: "iron" } };
      },
    });
    const cache = makeStatusCache("agent", {
      player: { docked_at_base: null },
    });
    const deps = makeDeps("agent", client, cache);

    const result = await batchMine(deps, 10);

    expect(result.status).toBe("completed");
    expect(result.mines_completed).toBe(2);
    expect(result.stopped_reason).toBe("depleted");
    // last_error is preserved so callers can log the depletion code
    expect(result.last_error).toEqual({ code: "belt_depleted" });
  });

  it("stops mid-run on non-depletion error and returns stopped_reason=error", async () => {
    let callCount = 0;
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_cargo") return { result: {} };
        callCount++;
        if (callCount >= 3) return { error: { code: "server_error", message: "Internal server error" } };
        return { result: { ore: "iron" } };
      },
    });
    const cache = makeStatusCache("agent", {
      player: { docked_at_base: null },
    });
    const deps = makeDeps("agent", client, cache);

    const result = await batchMine(deps, 10);

    expect(result.status).toBe("completed");
    expect(result.mines_completed).toBe(2);
    expect(result.stopped_reason).toBe("error");
    expect(result.last_error).toEqual({ code: "server_error", message: "Internal server error" });
  });

  it("blocks mining when agent is docked", async () => {
    const executeCalls: string[] = [];
    const client = makeClient({
      execute: async (tool) => {
        executeCalls.push(tool);
        return { result: {} };
      },
    });
    const cache = makeStatusCache("agent", {
      player: { docked_at_base: "sol_station" },
    });
    const deps = makeDeps("agent", client, cache);

    const result = await batchMine(deps, 5);

    expect(result.error).toBeTruthy();
    expect(String(result.error)).toContain("docked");
    // mine should never be called
    expect(executeCalls).not.toContain("mine");
  });

  it("clamps count to minimum of 1", async () => {
    let mineCount = 0;
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_cargo") return { result: {} };
        mineCount++;
        return { result: {} };
      },
    });
    const cache = makeStatusCache("agent", { player: { docked_at_base: null } });
    const deps = makeDeps("agent", client, cache);

    await batchMine(deps, 0);
    expect(mineCount).toBe(1);

    mineCount = 0;
    await batchMine(deps, -10);
    expect(mineCount).toBe(1);
  });

  it("clamps count to maximum of 50", async () => {
    let mineCount = 0;
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_cargo") return { result: {} };
        mineCount++;
        return { result: {} };
      },
    });
    const cache = makeStatusCache("agent", { player: { docked_at_base: null } });
    const deps = makeDeps("agent", client, cache);

    await batchMine(deps, 200);
    expect(mineCount).toBe(50);
  });

  it("stops with cargo_full when ship cargo is at capacity (checked every 5 mines)", async () => {
    let mineCount = 0;
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_cargo") return { result: {} };
        mineCount++;
        return { result: { ore: "iron" } };
      },
    });
    // Set cargo at 100% capacity so the check at mine 5 triggers
    const cache = makeStatusCache("agent", {
      player: { docked_at_base: null },
      ship: { cargo_used: 100, cargo_capacity: 100 },
    });
    const deps = makeDeps("agent", client, cache);

    const result = await batchMine(deps, 20);

    expect(result.mines_completed).toBe(5);
    expect(result.stopped_reason).toBe("cargo_full");
  });

  it("waits for tick when mine returns a pending result", async () => {
    let tickCount = 0;
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_cargo") return { result: {} };
        return { result: { pending: true, command: "mine" } };
      },
      waitForTick: async () => {
        tickCount++;
      },
    });
    const cache = makeStatusCache("agent", {
      player: { docked_at_base: null },
      ship: { cargo_used: 0, cargo_capacity: 100 },
    });
    const deps = makeDeps("agent", client, cache);

    await batchMine(deps, 2);

    // Each pending mine triggers a tick wait
    expect(tickCount).toBeGreaterThanOrEqual(2);
  });

  it("strips pending flag from mine results after tick wait", async () => {
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_cargo") return { result: {} };
        return { result: { pending: true, command: "mine", message: "action pending" } };
      },
    });
    const cache = makeStatusCache("agent", {
      player: { docked_at_base: null },
      ship: { cargo_used: 0, cargo_capacity: 100 },
    });
    const deps = makeDeps("agent", client, cache);

    const result = await batchMine(deps, 1);

    const mined = result.mined as Array<Record<string, unknown>>;
    expect(mined[0]).not.toHaveProperty("pending");
    expect(mined[0].message).toBe("mine completed");
  });

  it("stops immediately when shutdown signal is set for the agent", async () => {
    const shutdownManager = getSessionShutdownManager();
    shutdownManager.requestShutdown("agent", false, "test");

    let mineCount = 0;
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_cargo") return { result: {} };
        mineCount++;
        return { result: { ore: "iron" } };
      },
    });
    const cache = makeStatusCache("agent", {
      player: { docked_at_base: null },
    });
    const deps = makeDeps("agent", client, cache);

    const result = await batchMine(deps, 10);

    expect(result.stopped_reason).toBe("shutdown_signal");
    expect(mineCount).toBe(0);
  });

  it("always calls get_cargo at the end to return final cargo state", async () => {
    let getCargoCallCount = 0;
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_cargo") {
          getCargoCallCount++;
          return { result: { items: [{ id: "iron_ore", qty: 5 }] } };
        }
        return { result: { ore: "iron" } };
      },
    });
    const cache = makeStatusCache("agent", {
      player: { docked_at_base: null },
    });
    const deps = makeDeps("agent", client, cache);

    const result = await batchMine(deps, 2);

    expect(getCargoCallCount).toBe(1);
    expect(result.cargo_after).toEqual({ items: [{ id: "iron_ore", qty: 5 }] });
  });

  it("stops with depleted when mine returns explicit amount=0 three times in a row", async () => {
    let mineCount = 0;
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_cargo") return { result: {} };
        mineCount++;
        // Return explicit 0-amount result — belt exhausted but no error code
        return { result: { amount: 0, ore: "iron" } };
      },
    });
    const cache = makeStatusCache("agent", {
      player: { docked_at_base: null },
    });
    const deps = makeDeps("agent", client, cache);

    const result = await batchMine(deps, 20);

    expect(result.stopped_reason).toBe("depleted");
    // 3 empty mines trigger stop; third result is not added before break
    expect(result.mines_completed).toBe(2);
  });

  it("does not stop for empty {} results (ambiguous — game may return plain ok)", async () => {
    let mineCount = 0;
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_cargo") return { result: {} };
        mineCount++;
        return { result: {} }; // empty but ambiguous
      },
    });
    const cache = makeStatusCache("agent", {
      player: { docked_at_base: null },
      ship: { cargo_used: 0, cargo_capacity: 100 },
    });
    const deps = makeDeps("agent", client, cache);

    const result = await batchMine(deps, 5);

    // Should run all 5 without stopping at 3 (empty {} is not treated as depletion)
    expect(result.mines_completed).toBe(5);
    expect(result.stopped_reason).toBeUndefined();
  });
});
