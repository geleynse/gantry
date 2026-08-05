/**
 * compound-tools/flee.test.ts
 *
 * Tests the phantom-in-battle detection branch — the v1.8.1 logic that
 * recognizes when the game server's in_combat flag is stuck despite no
 * active battle. This branch is hard to exercise live (requires the server
 * to enter the bug state), so we drive it through a mocked game client.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createDatabase, closeDb } from "../../services/database.js";
import { resetSessionShutdownManager } from "../session-shutdown.js";
import { flee } from "./flee.js";
import type { CompoundToolDeps, GameClientLike } from "./types.js";
import { SellLog } from "../sell-log.js";
import { GalaxyGraph } from "../pathfinder.js";

type StatusEntry = { data: Record<string, unknown>; fetchedAt: number };

function makeClient(
  execute: GameClientLike["execute"],
): GameClientLike {
  return {
    execute,
    waitForTick: async () => {},
    lastArrivalTick: null,
  };
}

function makeDeps(
  agentName: string,
  client: GameClientLike,
  upsertNoteFn: (agent: string, key: string, value: string) => void = () => {},
): CompoundToolDeps {
  return {
    client,
    agentName,
    statusCache: new Map<string, StatusEntry>(),
    battleCache: new Map(),
    sellLog: new SellLog(),
    galaxyGraph: new GalaxyGraph(),
    persistBattleState: () => {},
    upsertNote: upsertNoteFn,
  };
}

describe("flee — phantom in_battle detection", () => {
  beforeEach(() => {
    createDatabase(":memory:");
    resetSessionShutdownManager();
  });

  afterEach(() => {
    closeDb();
  });

  it("returns phantom_in_battle when get_battle_status reports not_in_battle but dock returns in_combat", async () => {
    const calls: string[] = [];
    const client = makeClient(async (tool) => {
      calls.push(tool);
      if (tool === "get_battle_status") {
        return { error: { code: "not_in_battle", message: "no active battle" } };
      }
      if (tool === "dock") {
        return { error: { code: "in_combat", message: "Cannot dock while in combat" } };
      }
      return { result: { ok: true } };
    });

    const result = await flee(makeDeps("rust-vane", client));

    expect(result.status).toBe("phantom_in_battle");
    expect(result.escaped).toBe(false);
    expect((result as Record<string, unknown>).recovery).toBe("logout_then_login");
    expect(calls).toContain("get_battle_status");
    expect(calls).toContain("dock");
  });

  it("returns not_in_battle (not phantom) when dock probe succeeds despite no battle", async () => {
    const client = makeClient(async (tool) => {
      if (tool === "get_battle_status") {
        return { result: { status: "none" } };
      }
      if (tool === "dock") {
        return { result: { docked: true } };
      }
      return { result: { ok: true } };
    });

    const result = await flee(makeDeps("rust-vane", client));

    expect(result.status).toBe("not_in_battle");
    expect(result.escaped).toBe(false);
  });

  it("phantom detection writes a phantom_battle note for the agent", async () => {
    let noteWritten: { key: string; value: string } | null = null;
    const client = makeClient(async (tool) => {
      if (tool === "get_battle_status") {
        return { error: { code: "not_in_battle", message: "no active battle" } };
      }
      if (tool === "dock") {
        return { error: { code: "in_combat", message: "Cannot dock while in combat" } };
      }
      return { result: { ok: true } };
    });

    await flee(makeDeps("rust-vane", client, (_agent, key, value) => {
      noteWritten = { key, value };
    }));

    expect(noteWritten).not.toBeNull();
    expect(noteWritten!.key).toBe("phantom_battle");
    expect(noteWritten!.value).toContain("PHANTOM in_combat detected");
    expect(noteWritten!.value).toContain("logout()");
  });
});

describe("flee — v0.414.0 combat_state escape mechanics", () => {
  beforeEach(() => {
    createDatabase(":memory:");
    resetSessionShutdownManager();
  });

  afterEach(() => {
    closeDb();
  });

  it("returns cannot_escape immediately when combat_state.can_escape is false (warp disrupted), without attempting a stance change", async () => {
    const calls: string[] = [];
    const client = makeClient(async (tool) => {
      calls.push(tool);
      if (tool === "get_battle_status") {
        return {
          result: {
            status: "active",
            combat_state: {
              can_escape: false,
              warp_disrupted: true,
              webbed: false,
              em_disrupted: false,
              effective_speed: 10,
              flee_counter: 0,
              max_weapon_reach: 3,
            },
          },
        };
      }
      return { result: { ok: true } };
    });

    const result = await flee(makeDeps("rust-vane", client));

    expect(result.status).toBe("cannot_escape");
    expect(result.escaped).toBe(false);
    expect(result.message).toContain("Warp disruption");
    expect(calls).toContain("get_battle_status");
    expect(calls).not.toContain("battle");
  });

  it("bounds the wait using combat_state.flee_required instead of the fixed 5-tick timeout", async () => {
    // flee_required: 1 means the tool should only wait 1 tick before giving up.
    // The mocked get_status never reports an escaped ship, so with the fix the loop
    // runs exactly once (1 waitForTick + 1 get_status) and times out. If the code
    // regressed to the old fixed-5 behavior, it would run 5 iterations instead.
    let getStatusCalls = 0;
    const client = makeClient(async (tool) => {
      if (tool === "get_battle_status") {
        return {
          result: {
            status: "active",
            combat_state: {
              can_escape: true,
              warp_disrupted: false,
              webbed: false,
              em_disrupted: false,
              effective_speed: 20,
              flee_counter: 0,
              flee_required: 1,
              max_weapon_reach: 3,
            },
          },
        };
      }
      if (tool === "battle") {
        return { result: { ok: true } };
      }
      if (tool === "get_status") {
        getStatusCalls++;
        return { result: { ship: { battle_id: "battle-1" } } }; // never escapes
      }
      return { result: { ok: true } };
    });

    const result = await flee(makeDeps("rust-vane", client));

    expect(result.status).toBe("timeout");
    expect(getStatusCalls).toBe(1);
    expect((result as Record<string, unknown>).escape_diagnostics).toMatchObject({
      flee_required: 1,
      ticks_waited: 1,
    });
  });

  it("escapes normally and reports success once get_status shows battle_id cleared", async () => {
    let getStatusCalls = 0;
    const client = makeClient(async (tool) => {
      if (tool === "get_battle_status") {
        return {
          result: {
            status: "active",
            combat_state: {
              can_escape: true,
              warp_disrupted: false,
              webbed: false,
              em_disrupted: false,
              effective_speed: 20,
              flee_counter: 0,
              flee_required: 3,
              max_weapon_reach: 3,
            },
          },
        };
      }
      if (tool === "get_status") {
        getStatusCalls++;
        return { result: { ship: { battle_id: null } } }; // escaped on first check
      }
      return { result: { ok: true } };
    });

    const result = await flee(makeDeps("rust-vane", client));

    expect(result.status).toBe("success");
    expect(result.fled).toBe(true);
    expect(getStatusCalls).toBe(1);
  });

  it("clamps an extreme flee_required to the FLEE_MAX_WAIT_TICKS ceiling instead of waiting unbounded", async () => {
    let getStatusCalls = 0;
    const client = makeClient(async (tool) => {
      if (tool === "get_battle_status") {
        return {
          result: {
            status: "active",
            combat_state: {
              can_escape: true,
              warp_disrupted: false,
              webbed: true,
              em_disrupted: false,
              effective_speed: 1,
              flee_counter: 0,
              flee_required: 999,
              max_weapon_reach: 3,
            },
          },
        };
      }
      if (tool === "get_status") {
        getStatusCalls++;
        return { result: { ship: { battle_id: "battle-1" } } }; // never escapes
      }
      return { result: { ok: true } };
    });

    const result = await flee(makeDeps("rust-vane", client));

    expect(result.status).toBe("timeout");
    expect(getStatusCalls).toBe(10); // clamped to FLEE_MAX_WAIT_TICKS, not 999
    expect((result as Record<string, unknown>).escape_diagnostics).toMatchObject({
      flee_required: 999,
      ticks_waited: 10,
    });
  });

  it("falls back to the fixed 5-tick timeout when combat_state is absent (older/partial game response)", async () => {
    let getStatusCalls = 0;
    const client = makeClient(async (tool) => {
      if (tool === "get_battle_status") {
        return { result: { status: "active" } }; // no combat_state at all
      }
      if (tool === "get_status") {
        getStatusCalls++;
        return { result: { ship: { battle_id: "battle-1" } } }; // never escapes
      }
      return { result: { ok: true } };
    });

    const result = await flee(makeDeps("rust-vane", client));

    expect(result.status).toBe("timeout");
    expect(getStatusCalls).toBe(5);
    expect((result as Record<string, unknown>).escape_diagnostics).toBeUndefined();
  });
});
