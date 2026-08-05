/**
 * compound-tools/flee.test.ts
 *
 * Tests the phantom-in-battle detection branch — the v1.8.1 logic that
 * recognizes when the game server's in_combat flag is stuck despite no
 * active battle. This branch is hard to exercise live (requires the server
 * to enter the bug state), so we drive it through a mocked game client.
 *
 * Fixtures below mirror the REAL `GetBattleStatusResponse`/`BattleCombatState` shapes from the
 * live OpenAPI spec (game.spacemolt.com/api/openapi.json, x-gameserver-version v0.552.0, verified
 * 2026-08-04): `additionalProperties: false`, no `status` field, `is_participant`/`battle_id`/
 * `system_id` required. A previous version of this file mocked a fictitious `status` field that
 * does not exist on the real response — see "fixture-drift guard" below, which pins that the
 * code does not (re)gate on it.
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

  it("returns not_in_battle (not phantom) when dock probe succeeds despite is_participant: false", async () => {
    const client = makeClient(async (tool) => {
      if (tool === "get_battle_status") {
        // Real shape: a battle can exist in-system (battle_id present) without us being a
        // participant in it. is_participant is the field that matters, not battle_id alone.
        return { result: { battle_id: "someone-elses-battle", system_id: "sys-1", is_participant: false } };
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

describe("flee — v0.414.0 combat_state escape mechanics (real GetBattleStatusResponse shape)", () => {
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
            battle_id: "battle-1",
            system_id: "sys-1",
            is_participant: true,
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

  it("fixture-drift guard: treats a battle as active via is_participant+battle_id even when a spurious status field is present", async () => {
    // Regression guard for CRIT-1: the OLD code gated on `battleStatus.status`, a field that does
    // not exist on the real GetBattleStatusResponse (additionalProperties: false). A response
    // with status: "none" would have made the old code treat real, active combat as "no battle"
    // and fall into the phantom-probe branch (calling "dock") instead of attempting to flee. If
    // someone reintroduces status-gating, this test fails because "battle" never gets called.
    const calls: string[] = [];
    const client = makeClient(async (tool) => {
      calls.push(tool);
      if (tool === "get_battle_status") {
        return {
          result: {
            battle_id: "battle-1",
            system_id: "sys-1",
            is_participant: true,
            status: "none", // spurious field the real API never sends — must be ignored
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
            participants: [{ stance: "flee", zone: "outer" }],
          },
        };
      }
      if (tool === "battle") {
        return { result: { ok: true } };
      }
      if (tool === "get_status") {
        return { result: { ship: { battle_id: null } } }; // escapes immediately
      }
      return { result: { ok: true } };
    });

    const result = await flee(makeDeps("rust-vane", client));

    expect(calls).toContain("battle");
    expect(calls).not.toContain("dock");
    expect(result.status).toBe("success");
  });

  it("CRIT-2 regression: never waits shorter than FLEE_FALLBACK_WAIT_TICKS even when flee_required + zones is small", async () => {
    // flee_required=1 with the ship already at the outer ring (zones_to_outer=0) sums to 1 —
    // shorter than the old fixed 5-tick wait. The fix must floor at 5 regardless. flee_counter
    // increments realistically tick-over-tick (accumulating at the outer ring, per spec) so the
    // mid-loop refresh sees genuine, steady progress and the budget correctly holds at the floor
    // instead of ratcheting upward from a stale/unrealistic reading.
    let getStatusCalls = 0;
    let gbsCalls = 0;
    const client = makeClient(async (tool) => {
      if (tool === "get_battle_status") {
        gbsCalls++;
        return {
          result: {
            battle_id: "battle-1",
            system_id: "sys-1",
            is_participant: true,
            combat_state: {
              can_escape: true,
              warp_disrupted: false,
              webbed: false,
              em_disrupted: false,
              effective_speed: 20,
              flee_counter: gbsCalls - 1, // 0 on the initial fetch, incrementing once per refresh
              flee_required: 1,
              max_weapon_reach: 3,
            },
            participants: [{ stance: "flee", zone: "outer" }],
          },
        };
      }
      if (tool === "battle") return { result: { ok: true } };
      if (tool === "get_status") {
        getStatusCalls++;
        return { result: { ship: { battle_id: "battle-1" } } }; // never escapes
      }
      return { result: { ok: true } };
    });

    const result = await flee(makeDeps("rust-vane", client));

    expect(result.status).toBe("timeout");
    expect(getStatusCalls).toBe(5);
    expect((result as Record<string, unknown>).escape_diagnostics).toMatchObject({
      flee_required: 1,
      zones_to_outer: 0,
      ticks_waited: 5,
    });
  });

  it("CRIT-2 regression: the reviewer's exact probe scenario (escape on tick 4, flee_required 3) still succeeds", async () => {
    // No participants supplied -> zones_to_outer assumes the documented worst case (3, "engaged").
    // max(3 + 3, 5) = 6 ticks budgeted, comfortably covering the tick-4 escape that the old
    // adaptive-only code (budget = 3) timed out on.
    let getStatusCalls = 0;
    const client = makeClient(async (tool) => {
      if (tool === "get_battle_status") {
        return {
          result: {
            battle_id: "battle-1",
            system_id: "sys-1",
            is_participant: true,
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
      if (tool === "battle") return { result: { ok: true } };
      if (tool === "get_status") {
        getStatusCalls++;
        // Escapes on the 4th poll (tick index 3), not before.
        const battleId = getStatusCalls >= 4 ? null : "battle-1";
        return { result: { ship: { battle_id: battleId } } };
      }
      return { result: { ok: true } };
    });

    const result = await flee(makeDeps("rust-vane", client));

    expect(result.status).toBe("success");
    expect(result.fled).toBe(true);
    expect(getStatusCalls).toBe(4);
  });

  it("defaults zones_to_outer to the documented worst case (3) when participants are absent, distinct from assuming 0 — and HOLDS there on a genuinely stalled flee (HIGH regression, 2026-08)", async () => {
    // No `participants` field at all (a legitimate partial response). flee_required=10 is well
    // above the 5-tick floor, so the worst-case default is the only thing keeping the budget at
    // 13 instead of 10 — a mutant that defaults to 0 instead of 3 would under-wait here.
    //
    // flee_counter is STATIC (0 on every read) — a genuinely stalled flee makes no progress at
    // all. A previous version of this fixture incremented flee_counter once per refresh
    // specifically to avoid ever exercising this path; its own comment said so. That made the
    // test blind to the HIGH regression: the old wait-bound formula combined ELAPSED ticks with
    // the remaining estimate on every refresh, so with a static counter the bound grew by ~1 tick
    // every iteration with no new information at all, ratcheting up to FLEE_MAX_WAIT_TICKS (60)
    // regardless of whether anything had actually changed. The fixed code only extends the bound
    // in response to a genuine worsening (flee_required or zones-to-outer increasing beyond what
    // has already been observed) — with both pinned flat here, the budget must hold at its
    // original value (13), not diverge to 60.
    let getStatusCalls = 0;
    const client = makeClient(async (tool) => {
      if (tool === "get_battle_status") {
        return {
          result: {
            battle_id: "battle-1",
            system_id: "sys-1",
            is_participant: true,
            combat_state: {
              can_escape: true,
              warp_disrupted: false,
              webbed: false,
              em_disrupted: false,
              effective_speed: 20,
              flee_counter: 0, // static — no progress, ever
              flee_required: 10,
              max_weapon_reach: 3,
            },
            // no participants[] — must fall back to the documented worst case, not 0
          },
        };
      }
      if (tool === "battle") return { result: { ok: true } };
      if (tool === "get_status") {
        getStatusCalls++;
        return { result: { ship: { battle_id: "battle-1" } } }; // never escapes
      }
      return { result: { ok: true } };
    });

    const result = await flee(makeDeps("rust-vane", client));

    expect(result.status).toBe("timeout");
    // Exact count, not "at least" — the whole point of this guard is to catch the bound
    // reproducing the divergence-to-60 regression.
    expect(getStatusCalls).toBe(13);
    expect((result as Record<string, unknown>).escape_diagnostics).toMatchObject({
      zones_to_outer: 3,
      ticks_waited: 13,
    });
  });

  it("HIGH regression (2026-08), Opus probe A shape: participants present but self never identifiable (no row has `stance`) — stalled flee terminates at a small bound, not 60", async () => {
    // All participants at zone "outer", flee_required: 3, but no row carries the self-only
    // `stance` field (spec-legal: a partner/enemy snapshot without our own marker). zonesToOuterRing
    // can't find self, so it falls back to the worst case (3) on every read — consistently, not
    // escalating. Combined with a static flee_counter (0 always), nothing about the estimate
    // actually worsens over time, so the fixed bound must hold at its original value
    // (3 + 3 = 6, floor 5 doesn't apply) instead of ratcheting to FLEE_MAX_WAIT_TICKS (60), which
    // is what the pre-fix formula did (reproduced live by two independent reviewers).
    let getStatusCalls = 0;
    const client = makeClient(async (tool) => {
      if (tool === "get_battle_status") {
        return {
          result: {
            battle_id: "battle-1",
            system_id: "sys-1",
            is_participant: true,
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
            participants: [
              { zone: "outer" }, // no `stance` — not identifiable as self
              { zone: "outer" },
            ],
          },
        };
      }
      if (tool === "battle") return { result: { ok: true } };
      if (tool === "get_status") {
        getStatusCalls++;
        return { result: { ship: { battle_id: "battle-1" } } }; // never escapes
      }
      return { result: { ok: true } };
    });

    const result = await flee(makeDeps("rust-vane", client));

    expect(result.status).toBe("timeout");
    // Exact count: 3 (flee_required) + 3 (worst-case zones, self unmatched) = 6. A regression to
    // the old elapsed-tick formula would drive this to 60.
    expect(getStatusCalls).toBe(6);
    expect((result as Record<string, unknown>).escape_diagnostics).toMatchObject({
      zones_to_outer: 3,
      ticks_waited: 6,
    });
  });

  it("HIGH regression (2026-08), Opus probe B shape: self matched but pinned at 'engaged' with a static flee_counter — stalled flee terminates at a small bound, not 60", async () => {
    // Self is identifiable (stance present) but never advances past "engaged" (3 zones from
    // outer) and flee_counter never increments — a ship that is genuinely pinned in place, not
    // making progress. Neither term worsens over time, so the bound must hold at its initial
    // value instead of diverging.
    let getStatusCalls = 0;
    const client = makeClient(async (tool) => {
      if (tool === "get_battle_status") {
        return {
          result: {
            battle_id: "battle-1",
            system_id: "sys-1",
            is_participant: true,
            combat_state: {
              can_escape: true,
              warp_disrupted: false,
              webbed: true,
              em_disrupted: false,
              effective_speed: 1,
              flee_counter: 0,
              flee_required: 3,
              max_weapon_reach: 3,
            },
            participants: [{ stance: "flee", zone: "engaged" }],
          },
        };
      }
      if (tool === "battle") return { result: { ok: true } };
      if (tool === "get_status") {
        getStatusCalls++;
        return { result: { ship: { battle_id: "battle-1" } } }; // never escapes
      }
      return { result: { ok: true } };
    });

    const result = await flee(makeDeps("rust-vane", client));

    expect(result.status).toBe("timeout");
    // Exact count: 3 (flee_required) + 3 (zones from "engaged") = 6.
    expect(getStatusCalls).toBe(6);
    expect((result as Record<string, unknown>).escape_diagnostics).toMatchObject({
      zones_to_outer: 3,
      ticks_waited: 6,
    });
  });

  it("LOW: ticks_waited reports ticks ACTUALLY waited, not the (possibly much larger) bound, on an early success after a mid-loop extension", async () => {
    // The bound gets extended way up (to 51, from a genuine flee_required jump to 50) on the very
    // first refresh, but the ship escapes on tick index 2 (the 3rd poll) anyway. escape_diagnostics
    // must report 3, not the inflated bound (51) — a mutant that reports the bound here would pass
    // every timeout-path test (where bound == actual by definition) while silently misreporting on
    // every early-success path.
    let gbsCalls = 0;
    let getStatusCalls = 0;
    const client = makeClient(async (tool) => {
      if (tool === "get_battle_status") {
        gbsCalls++;
        if (gbsCalls === 1) {
          return {
            result: {
              battle_id: "battle-1",
              system_id: "sys-1",
              is_participant: true,
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
              participants: [{ stance: "flee", zone: "outer" }],
            },
          };
        }
        // Every in-loop refresh: flee_required jumped to 50 (extends the bound way past what
        // will actually be used).
        return {
          result: {
            battle_id: "battle-1",
            system_id: "sys-1",
            is_participant: true,
            combat_state: {
              can_escape: true,
              warp_disrupted: false,
              webbed: false,
              em_disrupted: false,
              effective_speed: 20,
              flee_counter: 0,
              flee_required: 50,
              max_weapon_reach: 3,
            },
            participants: [{ stance: "flee", zone: "outer" }],
          },
        };
      }
      if (tool === "battle") return { result: { ok: true } };
      if (tool === "get_status") {
        getStatusCalls++;
        // Escapes on the 3rd poll (tick index 2).
        const battleId = getStatusCalls >= 3 ? null : "battle-1";
        return { result: { ship: { battle_id: battleId } } };
      }
      return { result: { ok: true } };
    });

    const result = await flee(makeDeps("rust-vane", client));

    expect(result.status).toBe("success");
    expect(result.fled).toBe(true);
    expect(getStatusCalls).toBe(3);
    expect((result as Record<string, unknown>).escape_diagnostics).toMatchObject({
      ticks_waited: 3,
    });
  });

  it("adapts beyond the floor when flee_required + zones_to_outer exceeds it", async () => {
    // Starting at "engaged" (3 zones from outer) with flee_required=10 sums to 13, above the
    // 5-tick floor — the adaptive part of the bound must still take effect, not just the floor.
    // The fixture auto-retreats one zone per tick (engaged -> inner -> mid -> outer) and only
    // starts accumulating flee_counter once at the outer ring, mirroring the documented mechanic
    // exactly, so the mid-loop refresh sees steady, real progress and the budget holds at 13.
    let getStatusCalls = 0;
    let gbsCalls = 0;
    const ZONES_FROM_ENGAGED = ["engaged", "inner", "mid", "outer"];
    const client = makeClient(async (tool) => {
      if (tool === "get_battle_status") {
        gbsCalls++;
        const refreshIndex = gbsCalls - 1; // 0 = initial fetch, 1.. = in-loop refreshes (tick 0..)
        const zone = ZONES_FROM_ENGAGED[Math.min(refreshIndex, 3)];
        const ticksAtOuter = Math.max(0, refreshIndex - 3);
        return {
          result: {
            battle_id: "battle-1",
            system_id: "sys-1",
            is_participant: true,
            combat_state: {
              can_escape: true,
              warp_disrupted: false,
              webbed: true,
              em_disrupted: false,
              effective_speed: 1,
              flee_counter: ticksAtOuter,
              flee_required: 10,
              max_weapon_reach: 3,
            },
            participants: [{ stance: "flee", zone }],
          },
        };
      }
      if (tool === "battle") return { result: { ok: true } };
      if (tool === "get_status") {
        getStatusCalls++;
        return { result: { ship: { battle_id: "battle-1" } } }; // never escapes
      }
      return { result: { ok: true } };
    });

    const result = await flee(makeDeps("rust-vane", client));

    expect(result.status).toBe("timeout");
    expect(getStatusCalls).toBe(13);
    expect((result as Record<string, unknown>).escape_diagnostics).toMatchObject({
      flee_required: 10,
      zones_to_outer: 3,
      ticks_waited: 13,
    });
  });

  it("clamps an extreme flee_required to the raised FLEE_MAX_WAIT_TICKS ceiling instead of waiting unbounded", async () => {
    let getStatusCalls = 0;
    const client = makeClient(async (tool) => {
      if (tool === "get_battle_status") {
        return {
          result: {
            battle_id: "battle-1",
            system_id: "sys-1",
            is_participant: true,
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
            participants: [{ stance: "flee", zone: "outer" }],
          },
        };
      }
      if (tool === "battle") return { result: { ok: true } };
      if (tool === "get_status") {
        getStatusCalls++;
        return { result: { ship: { battle_id: "battle-1" } } }; // never escapes
      }
      return { result: { ok: true } };
    });

    const result = await flee(makeDeps("rust-vane", client));

    expect(result.status).toBe("timeout");
    expect(getStatusCalls).toBe(60); // clamped to the raised FLEE_MAX_WAIT_TICKS, not 999
    expect((result as Record<string, unknown>).escape_diagnostics).toMatchObject({
      flee_required: 999,
      ticks_waited: 60,
    });
  });

  it("falls back to the fixed 5-tick timeout when combat_state is absent (older/partial game response)", async () => {
    let getStatusCalls = 0;
    const client = makeClient(async (tool) => {
      if (tool === "get_battle_status") {
        return { result: { battle_id: "battle-1", system_id: "sys-1", is_participant: true } }; // no combat_state at all
      }
      if (tool === "battle") return { result: { ok: true } };
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

  it("MED-2: reports timeout (not error) when a premature undock fails with in_combat while still in battle, and does NOT clear the battle cache", async () => {
    // A timeout that leaves the ship still in battle causes undock to legitimately fail with
    // in_combat. That's the timeout outcome surfacing, not a distinct error — it must be reported
    // as status "timeout" with diagnostics preserved.
    //
    // It must NOT clear the battle cache (revised, codex review 2026-08): every poll in the loop
    // reported an active battle, so persisting `null` here would tell a restarted proxy the ship
    // is out of combat when it demonstrably is not. A prior version of this test asserted the
    // opposite (that persistBattleState(null) fired) — that assertion enshrined the staleness bug
    // rather than catching it.
    let persistedNull = false;
    let gbsCalls = 0;
    const client = makeClient(async (tool) => {
      if (tool === "get_battle_status") {
        gbsCalls++;
        return {
          result: {
            battle_id: "battle-1",
            system_id: "sys-1",
            is_participant: true,
            combat_state: {
              can_escape: true,
              warp_disrupted: false,
              webbed: false,
              em_disrupted: false,
              effective_speed: 20,
              flee_counter: gbsCalls - 1, // realistic tick-over-tick progress at the outer ring
              flee_required: 1,
              max_weapon_reach: 3,
            },
            participants: [{ stance: "flee", zone: "outer" }],
          },
        };
      }
      if (tool === "battle") return { result: { ok: true } };
      if (tool === "get_status") return { result: { ship: { battle_id: "battle-1" } } }; // never escapes
      if (tool === "undock") return { error: { code: "in_combat", message: "Cannot undock while in combat" } };
      return { result: { ok: true } };
    });

    const deps = makeDeps("rust-vane", client);
    deps.persistBattleState = (_agent, state) => {
      if (state === null) persistedNull = true;
    };

    const result = await flee(deps);

    expect(result.status).toBe("timeout");
    expect(result.escaped).toBe(false);
    expect((result as Record<string, unknown>).escape_diagnostics).toMatchObject({ ticks_waited: 5 });
    expect(persistedNull).toBe(false);
  });

  it("HIGH (codex review, 2026-08): a non-combat undock failure after a timed-out flee surfaces as a distinct error, not a masked timeout", async () => {
    // The undock failure here is session_invalid, not in_combat — a stale/expired session, not a
    // combat block. Reclassifying it as "timeout" would hide a real, more actionable failure
    // behind a combat-sounding message. Only a genuinely combat-blocked undock failure (in_combat)
    // may be reported as the timeout outcome surfacing.
    const client = makeClient(async (tool) => {
      if (tool === "get_battle_status") {
        return {
          result: {
            battle_id: "battle-1",
            system_id: "sys-1",
            is_participant: true,
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
            participants: [{ stance: "flee", zone: "outer" }],
          },
        };
      }
      if (tool === "battle") return { result: { ok: true } };
      if (tool === "get_status") return { result: { ship: { battle_id: "battle-1" } } }; // never escapes
      if (tool === "undock") return { error: { code: "session_invalid", message: "Session expired, please re-login" } };
      return { result: { ok: true } };
    });

    const result = await flee(makeDeps("rust-vane", client));

    expect(result.status).toBe("error");
    expect(result.status).not.toBe("timeout");
    expect(String(result.error)).toContain("session_invalid");
  });

  it("HIGH (codex review, 2026-08): flee_counter is only credited when self is confirmed at the outer ring, not while pinned elsewhere (e.g. 'engaged')", async () => {
    // flee_required=10 with a nonzero flee_counter=8 but self at "engaged" (not outer) the whole
    // time: the counter has NOT actually banked any progress (it only accumulates AT THE OUTER
    // RING per spec), so the budget must be based on the full flee_required (10) plus the 3 zones
    // from "engaged", not on (10 - 8). A mutant that subtracts the counter unconditionally would
    // under-budget to 5 (floored) instead of 13 — the same failure class as the original CRIT-2
    // under-wait bug.
    let getStatusCalls = 0;
    const client = makeClient(async (tool) => {
      if (tool === "get_battle_status") {
        return {
          result: {
            battle_id: "battle-1",
            system_id: "sys-1",
            is_participant: true,
            combat_state: {
              can_escape: true,
              warp_disrupted: false,
              webbed: false,
              em_disrupted: false,
              effective_speed: 20,
              flee_counter: 8, // stale/non-banked — self is NOT at outer, so this must be ignored
              flee_required: 10,
              max_weapon_reach: 3,
            },
            participants: [{ stance: "flee", zone: "engaged" }],
          },
        };
      }
      if (tool === "battle") return { result: { ok: true } };
      if (tool === "get_status") {
        getStatusCalls++;
        return { result: { ship: { battle_id: "battle-1" } } }; // never escapes
      }
      return { result: { ok: true } };
    });

    const result = await flee(makeDeps("rust-vane", client));

    expect(result.status).toBe("timeout");
    // Exact count: 10 (full flee_required, counter NOT credited) + 3 (zones from "engaged") = 13.
    // A regression that credits flee_counter unconditionally would under-budget to 5 (floored).
    expect(getStatusCalls).toBe(13);
    expect((result as Record<string, unknown>).escape_diagnostics).toMatchObject({
      flee_required: 10,
      zones_to_outer: 3,
      ticks_waited: 13,
    });
  });

  it("reads zones_to_outer from the participant identified as self (via the self-only stance field), not the documented worst-case default", async () => {
    // Two participants: an enemy first (no `stance` — not self-only-populated) and our own row
    // second, starting at "mid" (1 zone from outer) — distinct from both 0 (already outer) and
    // the worst-case default (3, "engaged"), so a mutant that ignores participants (always 0) or
    // always falls back to the worst case (always 3) produces a different, wrong total.
    // The fixture auto-retreats mid -> outer after 1 tick, then accumulates flee_counter, so the
    // mid-loop refresh sees real, steady progress (matching the documented mechanic) instead of
    // an unrealistic static reading that would spuriously ratchet the budget upward.
    let getStatusCalls = 0;
    let gbsCalls = 0;
    const client = makeClient(async (tool) => {
      if (tool === "get_battle_status") {
        gbsCalls++;
        const refreshIndex = gbsCalls - 1; // 0 = initial fetch, 1.. = in-loop refreshes (tick 0..)
        const zone = refreshIndex === 0 ? "mid" : "outer";
        const ticksAtOuter = Math.max(0, refreshIndex - 1);
        return {
          result: {
            battle_id: "battle-1",
            system_id: "sys-1",
            is_participant: true,
            combat_state: {
              can_escape: true,
              warp_disrupted: false,
              webbed: false,
              em_disrupted: false,
              effective_speed: 20,
              flee_counter: ticksAtOuter,
              flee_required: 10,
              max_weapon_reach: 3,
            },
            participants: [
              { zone: "engaged" }, // enemy row: no `stance` field, must NOT be mistaken for self
              { stance: "flee", zone }, // our row: identifiable via the self-only field
            ],
          },
        };
      }
      if (tool === "battle") return { result: { ok: true } };
      if (tool === "get_status") {
        getStatusCalls++;
        return { result: { ship: { battle_id: "battle-1" } } }; // never escapes
      }
      return { result: { ok: true } };
    });

    const result = await flee(makeDeps("rust-vane", client));

    expect(result.status).toBe("timeout");
    expect(getStatusCalls).toBe(11); // 10 (flee_required) + 1 (mid -> outer), not 13 (worst case) or 10
    expect((result as Record<string, unknown>).escape_diagnostics).toMatchObject({
      zones_to_outer: 1,
      ticks_waited: 11,
    });
  });

  it("subtracts an already-accumulated flee_counter from flee_required for the initial wait budget", async () => {
    // flee_required=10 with flee_counter=6 already banked (e.g. flee was already active before
    // this call) means only 4 more ticks are needed at the outer ring. A mutant that uses
    // flee_required alone (ignoring flee_counter) would budget 10 instead of 4. flee_counter
    // keeps incrementing realistically tick-over-tick so the mid-loop refresh doesn't spuriously
    // extend the budget from a stale/unrealistic static reading.
    let getStatusCalls = 0;
    let gbsCalls = 0;
    const client = makeClient(async (tool) => {
      if (tool === "get_battle_status") {
        gbsCalls++;
        return {
          result: {
            battle_id: "battle-1",
            system_id: "sys-1",
            is_participant: true,
            combat_state: {
              can_escape: true,
              warp_disrupted: false,
              webbed: false,
              em_disrupted: false,
              effective_speed: 20,
              flee_counter: 6 + (gbsCalls - 1), // 6 on the initial fetch, +1 per subsequent refresh
              flee_required: 10,
              max_weapon_reach: 3,
            },
            participants: [{ stance: "flee", zone: "outer" }],
          },
        };
      }
      if (tool === "battle") return { result: { ok: true } };
      if (tool === "get_status") {
        getStatusCalls++;
        return { result: { ship: { battle_id: "battle-1" } } }; // never escapes
      }
      return { result: { ok: true } };
    });

    const result = await flee(makeDeps("rust-vane", client));

    expect(result.status).toBe("timeout");
    // remaining = max(0, 10 - 6) = 4, + 0 zones = 4, floored to FLEE_FALLBACK_WAIT_TICKS (5).
    expect(getStatusCalls).toBe(5);
  });

  it("MED-3: extends the wait mid-loop when a re-read reports a higher flee_required than the initial snapshot, without regressing when flee_counter later catches up", async () => {
    // Initial snapshot: flee_required=1 at the outer ring -> floors to 5 ticks budgeted.
    // From tick index 2 onward, simulate a web landing: flee_required jumps to 8 and we're
    // pushed back to "mid" for one tick. The extension must widen the budget to 12 and then
    // hold steady as flee_counter counts back up (never re-shrinking below what was already
    // budgeted).
    let getStatusCalls = 0;
    let gbsCalls = 0;
    const client = makeClient(async (tool) => {
      if (tool === "get_battle_status") {
        gbsCalls++;
        if (gbsCalls <= 3) {
          // Initial fetch (call 1) + first two in-loop refreshes (tick 0, tick 1): unchanged.
          return {
            result: {
              battle_id: "battle-1",
              system_id: "sys-1",
              is_participant: true,
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
              participants: [{ stance: "flee", zone: "outer" }],
            },
          };
        }
        // gbsCalls 4.. correspond to loop tick index (gbsCalls - 2), i.e. tick 2 onward.
        const tickIndex = gbsCalls - 2;
        const counterSinceWebbed = Math.max(0, tickIndex - 2);
        const zone = tickIndex === 2 ? "mid" : "outer";
        return {
          result: {
            battle_id: "battle-1",
            system_id: "sys-1",
            is_participant: true,
            combat_state: {
              can_escape: true,
              warp_disrupted: false,
              webbed: true,
              em_disrupted: false,
              effective_speed: 5,
              flee_counter: counterSinceWebbed,
              flee_required: 8,
              max_weapon_reach: 3,
            },
            participants: [{ stance: "flee", zone }],
          },
        };
      }
      if (tool === "battle") return { result: { ok: true } };
      if (tool === "get_status") {
        getStatusCalls++;
        return { result: { ship: { battle_id: "battle-1" } } }; // never escapes
      }
      return { result: { ok: true } };
    });

    const result = await flee(makeDeps("rust-vane", client));

    expect(result.status).toBe("timeout");
    expect(getStatusCalls).toBe(12);
    expect((result as Record<string, unknown>).escape_diagnostics).toMatchObject({
      ticks_waited: 12,
    });
  });

  it("MED: mid-loop can_escape re-check bails out with cannot_escape when a tackle lands after the flee stance was already set (Opus probe E shape)", async () => {
    // can_escape starts true (so the stance change is attempted) and flips to false on the first
    // in-loop refresh — a tackle landing mid-flight. The old code only checked can_escape ONCE,
    // before the wait loop, so this flip was invisible until the loop ran out the clock and
    // reported a bare "timeout". It must bail immediately with "cannot_escape" instead.
    let gbsCalls = 0;
    let getStatusCalls = 0;
    const client = makeClient(async (tool) => {
      if (tool === "get_battle_status") {
        gbsCalls++;
        if (gbsCalls === 1) {
          return {
            result: {
              battle_id: "battle-1",
              system_id: "sys-1",
              is_participant: true,
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
              participants: [{ stance: "flee", zone: "outer" }],
            },
          };
        }
        // First in-loop refresh onward: tackled.
        return {
          result: {
            battle_id: "battle-1",
            system_id: "sys-1",
            is_participant: true,
            combat_state: {
              can_escape: false,
              warp_disrupted: true,
              webbed: false,
              em_disrupted: false,
              effective_speed: 20,
              flee_counter: 0,
              max_weapon_reach: 3,
              // flee_required omitted per spec while warp_disrupted
            },
            participants: [{ stance: "flee", zone: "outer" }],
          },
        };
      }
      if (tool === "battle") return { result: { ok: true } };
      if (tool === "get_status") {
        getStatusCalls++;
        return { result: { ship: { battle_id: "battle-1" } } }; // never escapes
      }
      return { result: { ok: true } };
    });

    const result = await flee(makeDeps("rust-vane", client));

    expect(result.status).toBe("cannot_escape");
    expect(result.escaped).toBe(false);
    expect(result.message).toContain("Warp disruption");
    // Bailed on the FIRST in-loop refresh — never even reached the get_status poll for that tick.
    expect(getStatusCalls).toBe(0);
  });

  it("MED: treats 'combat_state present, flee_required absent, warp_disrupted true' as tackled even when can_escape itself is missing on that read", async () => {
    // Explicit case called out in the brief: flee_required is OMITTED (not just falsy) while
    // warp_disrupted is true, per the OpenAPI spec ("escape is impossible until the tackle is
    // removed"). This must be treated as the tackled case even if can_escape is absent/stale on
    // this particular read, rather than falling through to "no update" and running out the clock.
    let gbsCalls = 0;
    let getStatusCalls = 0;
    const client = makeClient(async (tool) => {
      if (tool === "get_battle_status") {
        gbsCalls++;
        if (gbsCalls === 1) {
          return {
            result: {
              battle_id: "battle-1",
              system_id: "sys-1",
              is_participant: true,
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
              participants: [{ stance: "flee", zone: "outer" }],
            },
          };
        }
        return {
          result: {
            battle_id: "battle-1",
            system_id: "sys-1",
            is_participant: true,
            combat_state: {
              // can_escape omitted entirely on this read — only warp_disrupted + missing
              // flee_required signal the tackle.
              warp_disrupted: true,
              webbed: false,
              em_disrupted: false,
              effective_speed: 20,
              flee_counter: 0,
              max_weapon_reach: 3,
            },
            participants: [{ stance: "flee", zone: "outer" }],
          },
        };
      }
      if (tool === "battle") return { result: { ok: true } };
      if (tool === "get_status") {
        getStatusCalls++;
        return { result: { ship: { battle_id: "battle-1" } } };
      }
      return { result: { ok: true } };
    });

    const result = await flee(makeDeps("rust-vane", client));

    expect(result.status).toBe("cannot_escape");
    expect(getStatusCalls).toBe(0);
  });
});
