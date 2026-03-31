/**
 * compound-tools/utils.ts
 *
 * Shared utility functions used across multiple compound tool implementations.
 */

import type { GameClientLike } from "./types.js";
// Re-export from proxy-constants (single source of truth)
export { stripPendingFields } from "../proxy-constants.js";

export const MAX_BATTLE_TICKS = 30;
export const BATTLE_INIT_MAX_TICKS = 5;

/**
 * Check if a cargo item is ammo (kinetic/explosive rounds).
 * Matches item IDs containing "ammo" or "rounds", or starting with "ammo_".
 */
export function isAmmoItem(item: Record<string, unknown>): boolean {
  const id = String(item.item_id ?? item.id ?? "");
  return id.includes("ammo") || id.includes("rounds") || id.startsWith("ammo_");
}

/**
 * Extract a wreck array from a get_wrecks response.
 * Handles both raw array and `{wrecks: [...]}` shapes.
 */
export function extractWrecks(result: unknown): Array<Record<string, unknown>> {
  const raw = Array.isArray(result)
    ? result
    : result &&
        typeof result === "object" &&
        "wrecks" in (result as Record<string, unknown>)
      ? (result as Record<string, unknown>).wrecks
      : null;
  return (Array.isArray(raw) ? raw : []) as Array<Record<string, unknown>>;
}

/**
 * Wait for the nav cache to reflect a system change after a jump.
 * Returns true if the cache updated within maxTicks, false otherwise.
 */
export async function waitForNavCacheUpdate(
  client: { waitForTick: (ms?: number) => Promise<void>; lastArrivalTick: number | null; waitForNextArrival?: (beforeTick: number | null, timeoutMs?: number) => Promise<boolean>; waitForTickToReach?: (targetTick: number, timeoutMs?: number) => Promise<boolean> },
  agentName: string,
  beforeSystem: unknown,
  statusCache: Map<string, { data: Record<string, unknown>; fetchedAt: number }>,
  maxTicks = 18,
  /** The arrival tick value from BEFORE the nav action was sent. Pass this to
   *  avoid the race where the arrival signal arrives during execute() and is
   *  then missed because beforeTick matches the already-updated lastArrivalTick. */
  arrivalTickBeforeAction?: number | null,
): Promise<boolean> {
  // The game server flow for nav actions:
  // 1. Initial "ok" with pending:true — command accepted, ship entering hyperspace
  // 2. Deferred "ok" with arrival_tick — ship will arrive at this specific game tick
  // 3. At arrival_tick, game updates current_system — get_status now shows new location
  //
  // Previous bug: we polled get_status immediately after receiving arrival_tick (step 2),
  // but the game hadn't reached that tick yet, so current_system was still empty.
  // Fix: wait for the game tick to reach arrival_tick BEFORE polling get_status.
  if (client.waitForNextArrival) {
    const beforeTick = arrivalTickBeforeAction !== undefined ? arrivalTickBeforeAction : client.lastArrivalTick;
    const arrived = await client.waitForNextArrival(beforeTick, maxTicks * 10000);

    if (arrived && client.lastArrivalTick !== null && client.waitForTickToReach) {
      // We know the exact tick the ship arrives — wait for it instead of blind polling
      const reached = await client.waitForTickToReach(client.lastArrivalTick, 60000);
      if (reached) {
        // Game tick has reached arrival — one status poll should show the new location
        await client.waitForTick();
        const cached = statusCache.get(agentName);
        const player = cached?.data?.player as Record<string, unknown> | undefined;
        if (player?.current_system && player.current_system !== beforeSystem) return true;
        // One more try — settle delay
        await client.waitForTick();
        const cached2 = statusCache.get(agentName);
        const player2 = cached2?.data?.player as Record<string, unknown> | undefined;
        return !!(player2?.current_system && player2.current_system !== beforeSystem);
      }
    }

    // Fallback: arrival signal timed out or waitForTickToReach not available.
    // Poll get_status up to 6 ticks hoping the game catches up.
    for (let i = 0; i < 6; i++) {
      await client.waitForTick();
      const cached = statusCache.get(agentName);
      const player = cached?.data?.player as Record<string, unknown> | undefined;
      if (player?.current_system && player.current_system !== beforeSystem) return true;
    }
    return false;
  }

  // Legacy polling fallback (used in tests / clients without waitForNextArrival)
  for (let tick = 0; tick < maxTicks; tick++) {
    await client.waitForTick();
    const cached = statusCache.get(agentName);
    const player = cached?.data?.player as Record<string, unknown> | undefined;
    if (player?.current_system !== beforeSystem) return true;

    const cacheTick = cached?.data?.tick as number | undefined;
    const arrivalTick = client.lastArrivalTick;
    if (arrivalTick && cacheTick && cacheTick >= arrivalTick) {
      await client.waitForTick();
      const cached2 = statusCache.get(agentName);
      const player2 = cached2?.data?.player as Record<string, unknown> | undefined;
      return player2?.current_system !== beforeSystem;
    }
  }
  return false;
}

/**
 * Wait for the status cache to reflect a docking change.
 * Returns true if the agent is docked within maxTicks, false otherwise.
 */
export async function waitForDockCacheUpdate(
  client: { waitForTick: (ms?: number) => Promise<void> },
  agentName: string,
  statusCache: Map<string, { data: Record<string, unknown>; fetchedAt: number }>,
  maxTicks = 5,
): Promise<boolean> {
  for (let tick = 0; tick < maxTicks; tick++) {
    await client.waitForTick();
    const cached = statusCache.get(agentName);
    const player = cached?.data?.player as Record<string, unknown> | undefined;
    if (player?.docked_at_base) return true;
  }
  return false;
}

/**
 * Find PvP-attackable targets from nearby entities.
 *
 * IMPORTANT: NPC/pirate combat is AUTOMATIC in SpaceMolt — the game server resolves
 * NPC aggro when players travel through lawless space. The `attack` command is PvP ONLY.
 * Anonymous entities are NPCs and cannot be targeted with `attack`. Only real players
 * with a visible username are valid attack targets.
 *
 * Excludes: already in combat, our fleet agents, faction mates (QTCG), anonymous (NPCs).
 */
export function findTargets(
  entities: Array<Record<string, unknown>>,
  agentName: string,
  ourAgentNames: Set<string>,
): Array<Record<string, unknown>> {
  return entities
    .filter((e) => {
      // Anonymous entities are NPCs — cannot be targeted with attack (PvP only)
      if (e.anonymous === true) return false;
      if (e.in_combat === true) return false;
      const username = String(e.username ?? "").toLowerCase();
      if (!username) return false; // no username = NPC/system entity, skip
      if (ourAgentNames.has(username)) return false;
      const theirTag = String(e.faction_tag ?? "").toLowerCase();
      if (theirTag === "qtcg") return false;
      return true;
    });
}
