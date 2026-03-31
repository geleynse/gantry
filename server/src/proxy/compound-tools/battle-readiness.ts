/**
 * compound-tools/battle-readiness.ts
 *
 * Implementation of the battle_readiness compound tool.
 * Checks combat readiness from cached status without executing any game tools.
 */

import type { CompoundToolDeps, CompoundResult } from "./types.js";
import { findTargets, isAmmoItem } from "./utils.js";

/**
 * Check combat readiness from cached status: hull, fuel, ammo, nearby threats.
 * Does not execute any game tools — reads only from the status cache.
 */
export function battleReadiness(
  deps: Pick<CompoundToolDeps, "agentName" | "statusCache">,
  ourAgentNames: Set<string>,
): CompoundResult {
  const { agentName, statusCache } = deps;

  const cached = statusCache.get(agentName);
  const player = (cached?.data?.player ?? cached?.data ?? {}) as Record<
    string,
    unknown
  >;
  const ship = (cached?.data?.ship ?? {}) as Record<string, unknown>;
  const cargo = (
    Array.isArray(ship.cargo) ? ship.cargo : []
  ) as Array<Record<string, unknown>>;

  const hull = typeof ship.hull === "number" ? ship.hull : -1;
  const fuel = typeof ship.fuel === "number" ? ship.fuel : -1;
  const ammoItems = cargo.filter(isAmmoItem);
  const hasAmmo = ammoItems.length > 0;

  // Check nearby threats from cache
  const nearby = (cached?.data?.nearby ?? []) as Array<Record<string, unknown>>;
  const threats = findTargets(nearby, agentName, ourAgentNames);

  // Check weapons equipped
  const weapons = Array.isArray(ship.weapons) ? ship.weapons : [];

  const issues: string[] = [];
  if (weapons.length === 0) issues.push("No weapons equipped — dock and fit weapons before combat");
  if (hull < 30) issues.push(`Hull critical (${hull}%) — dock for repairs first`);
  else if (hull < 60) issues.push(`Hull low (${hull}%) — fight cautiously`);
  if (fuel < 20) issues.push(`Low fuel (${fuel}%) — refuel before combat`);
  if (!hasAmmo && weapons.length > 0) issues.push("No ammo in cargo — kinetic/explosive weapons won't fire");

  return {
    ready: issues.length === 0,
    hull,
    fuel,
    ammo: ammoItems.map((i) => ({
      id: i.item_id ?? i.id,
      qty: i.quantity ?? i.qty,
    })),
    location: { system: player.current_system, poi: player.current_poi },
    nearby_threats: threats.length,
    total_nearby: nearby.length,
    issues,
  };
}
