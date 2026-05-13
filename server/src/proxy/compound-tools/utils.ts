/**
 * compound-tools/utils.ts
 *
 * Shared utility functions used across multiple compound tool implementations.
 */

import type { GameClientLike } from "./types.js";
// Re-export from proxy-constants (single source of truth)
export { stripPendingFields } from "../proxy-constants.js";

interface MarketEntry {
  item_id?: string;
  id?: string;
  buy_price?: number;
  sell_price?: number;
  best_buy?: number;
  best_sell?: number;
  price?: number;
}

export function buildPriceMap(
  marketResult: unknown,
): Map<string, { buy: number; sell: number }> {
  const out = new Map<string, { buy: number; sell: number }>();
  if (!marketResult || typeof marketResult !== "object") return out;
  const raw = marketResult as Record<string, unknown>;
  const list = Array.isArray(raw.items)
    ? raw.items
    : Array.isArray(raw.listings)
      ? raw.listings
      : Array.isArray(raw.market)
        ? raw.market
        : Array.isArray(marketResult)
          ? (marketResult as unknown[])
          : [];
  for (const entry of list as MarketEntry[]) {
    const itemId = String(entry.item_id ?? entry.id ?? "");
    if (!itemId) continue;
    const buy = entry.buy_price ?? entry.best_buy ?? entry.price ?? 0;
    const sell = entry.sell_price ?? entry.best_sell ?? entry.price ?? 0;
    out.set(itemId, { buy: Number(buy), sell: Number(sell) });
  }
  return out;
}

/**
 * Normalize a system name for comparison.
 * The game returns display names ("Epsilon Eridani") while cache stores IDs ("epsilon_eridani").
 */
export function normalizeSystemName(name: string): string {
  return name.toLowerCase().replace(/[\s\-']+/g, "_").replace(/_+/g, "_");
}

export const MAX_BATTLE_TICKS = 30;
export const BATTLE_INIT_MAX_TICKS = 5;

/**
 * Check if a cargo item is ammo (kinetic/explosive rounds).
 * Matches item IDs containing "ammo" or "rounds", or starting with "ammo_".
 */
export function isAmmoItem(item: Record<string, unknown>): boolean {
  const id = String(item.item_id ?? item.id ?? "");
  return id.includes("ammo") || id.includes("rounds");
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
  client: Pick<GameClientLike, "waitForTick" | "lastArrivalTick" | "waitForNextArrival" | "waitForTickToReach">,
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
 * Refresh status with retries, detecting whether the underlying refreshStatus
 * actually advanced the cache. Compound tools that read post-action state
 * (e.g. multi_sell computing credits_delta) need to know whether the cache
 * is fresh or whether refreshStatus hit a transport error like rate-limit
 * (-32029) and silently fell back to the stale snapshot.
 *
 * Implementation: client.waitForTick() calls refreshStatus() internally and
 * fires onStateUpdate (which advances cache.fetchedAt) only on success. By
 * snapshotting fetchedAt before and comparing after, we can tell whether the
 * refresh succeeded without depending on refreshStatus's return value.
 *
 * Behavior:
 *   - Snapshot fetchedAt, call waitForTick().
 *   - If fetchedAt advanced → updated:true, return immediately.
 *   - Otherwise sleep `backoffMs` and retry up to `maxRetries` more times.
 *   - On exhaustion, return updated:false. Caller is expected to surface a
 *     verification_status flag rather than report stale data as authoritative.
 *
 * Caller must NOT use post-refresh cache values to compute deltas (credits,
 * cargo, etc.) when updated is false — the cache is pre-action.
 */
export async function refreshStatusOrFlag(
  client: Pick<GameClientLike, "waitForTick">,
  agentName: string,
  statusCache: Map<string, { data: Record<string, unknown>; fetchedAt: number }>,
  opts: { maxRetries?: number; backoffMs?: number } = {},
): Promise<{ updated: boolean; attempts: number }> {
  const maxRetries = opts.maxRetries ?? 2;
  const backoffMs = opts.backoffMs ?? 1000;

  const before = statusCache.get(agentName)?.fetchedAt ?? 0;
  let attempts = 0;

  for (let i = 0; i <= maxRetries; i++) {
    attempts++;
    try {
      await client.waitForTick();
    } catch {
      // waitForTick is documented as never throwing in production, but be
      // defensive — a thrown error is equivalent to a failed refresh.
    }
    const after = statusCache.get(agentName)?.fetchedAt ?? 0;
    if (after > before) return { updated: true, attempts };

    // Don't sleep after the final attempt
    if (i < maxRetries) {
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }

  return { updated: false, attempts };
}

/**
 * Wait for the status cache to reflect a docking change.
 * Returns true if the agent is docked within maxTicks, false otherwise.
 */
export async function waitForDockCacheUpdate(
  client: Pick<GameClientLike, "waitForTick">,
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
