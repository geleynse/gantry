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
