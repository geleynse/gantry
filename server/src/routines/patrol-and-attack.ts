/**
 * patrol_and_attack routine — Patrol systems, engage hostiles, loot wrecks.
 *
 * State machine:
 *   INIT → [JUMP_SYSTEM →] SCAN_AND_ATTACK → [LOOT_WRECKS] → (next system) → DONE
 *
 * Inputs:
 *   - systems?: system IDs to patrol (default: current system only)
 *   - max_targets?: max hostiles to engage total (default: 5)
 *
 * Handoff triggers:
 *   - Hull < 30% at any point
 *   - Defeat or fled from combat
 *   - Jump fails after retries
 *
 * Implemented — Phase 3
 */

import type { RoutineContext, RoutineDefinition, RoutinePhase, RoutineResult } from "./types.js";
import { withRetry, done, handoff, phase, completePhase } from "./routine-utils.js";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export interface PatrolAndAttackParams {
  systems?: string[];
  max_targets?: number;
}

function parseParams(raw: unknown): PatrolAndAttackParams {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const obj = raw as Record<string, unknown>;
  const params: PatrolAndAttackParams = {};
  if (Array.isArray(obj.systems)) {
    params.systems = obj.systems.filter((s): s is string => typeof s === "string" && s.length > 0);
  }
  if (obj.max_targets !== undefined) {
    if (typeof obj.max_targets !== "number" || obj.max_targets < 1) {
      throw new Error("max_targets must be a positive number");
    }
    params.max_targets = obj.max_targets;
  }
  return params;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

async function run(ctx: RoutineContext, params: PatrolAndAttackParams): Promise<RoutineResult> {
  const phases: RoutinePhase[] = [];
  const maxTargets = params.max_targets ?? 5;
  let totalKills = 0;
  let totalLoot = 0;
  let systemsPatrolled = 0;

  // --- Phase 1: Init — check hull and location ---
  const initPhase = phase("init");
  const statusResp = await ctx.client.execute("get_status");
  const status = statusResp.result as Record<string, unknown> | undefined;
  const ship = status?.ship as Record<string, unknown> | undefined;
  const hullCurrent = typeof ship?.hull === "number" ? ship.hull : undefined;
  const hullMax = typeof ship?.hull_max === "number" ? ship.hull_max : undefined;
  const hullPct = (hullCurrent !== undefined && hullMax !== undefined && hullMax > 0)
    ? (hullCurrent / hullMax) * 100 : 100;

  // Use live status for currentSystem, fall back to cache
  const statusPlayer = status?.player as Record<string, unknown> | undefined;
  const currentSystem = (statusPlayer?.current_system as string | undefined)
    ?? (ctx.statusCache.get(ctx.agentName)?.data?.player as Record<string, unknown> | undefined)?.current_system as string | undefined;

  phases.push(completePhase(initPhase, { hullPct: Math.round(hullPct), currentSystem }));

  if (hullPct < 30) {
    return handoff(
      `Hull critically low (${Math.round(hullPct)}%) — cannot patrol`,
      { hull_pct: Math.round(hullPct), hull: hullCurrent, hull_max: hullMax },
      phases,
    );
  }

  ctx.log("info", `patrol_and_attack: starting, hull=${Math.round(hullPct)}%, max_targets=${maxTargets}`);

  // Determine systems to patrol
  const systems = (params.systems && params.systems.length > 0) ? params.systems : [currentSystem ?? "current"];

  // --- Patrol each system ---
  for (const system of systems) {
    if (totalKills >= maxTargets) break;

    // Jump to system if not current
    const isCurrentSystem = system === "current" || system === currentSystem;
    if (!isCurrentSystem) {
      const jumpPhase = phase(`jump_${system}`);
      try {
        const jumpResult = await withRetry(async () => {
          const resp = await ctx.client.execute("jump", { system_id: system });
          if (resp.error) throw new Error(`jump failed: ${JSON.stringify(resp.error)}`);
          return resp.result;
        }, 2);
        await ctx.client.waitForTick();
        phases.push(completePhase(jumpPhase, jumpResult));
        ctx.log("info", `patrol_and_attack: jumped to ${system}`);
      } catch (err) {
        phases.push(completePhase(jumpPhase, { error: String(err) }));
        return handoff(
          `Jump to ${system} failed: ${err instanceof Error ? err.message : String(err)}`,
          { system, total_kills: totalKills, total_loot: totalLoot },
          phases,
        );
      }
    }

    systemsPatrolled++;

    // Scan and attack in this system
    const combatPhase = phase(`combat_${system}`);
    const combatResp = await ctx.client.execute("scan_and_attack");

    if (combatResp.error) {
      const errStr = JSON.stringify(combatResp.error);
      // "no_targets" is not a failure — just nothing to fight
      if (errStr.includes("no_targets") || errStr.includes("no targets") || errStr.includes("no_hostiles")) {
        phases.push(completePhase(combatPhase, { no_targets: true }));
        ctx.log("info", `patrol_and_attack: no targets in ${system}`);
        continue;
      }
      phases.push(completePhase(combatPhase, { error: combatResp.error }));
      ctx.log("warn", `patrol_and_attack: scan_and_attack error in ${system}: ${errStr}`);
      continue;
    }

    const combatResult = combatResp.result as Record<string, unknown> | undefined;
    const outcome = combatResult?.outcome as string | undefined;
    const kills = typeof combatResult?.kills === "number" ? combatResult.kills : (outcome === "victory" ? 1 : 0);

    phases.push(completePhase(combatPhase, combatResult));

    // Check defeat/fled — handoff to LLM
    if (outcome === "defeat" || outcome === "fled" || outcome === "destroyed") {
      // Get updated hull status
      const postStatusResp = await ctx.client.execute("get_status");
      const postStatus = postStatusResp.result as Record<string, unknown> | undefined;
      const postShip = postStatus?.ship as Record<string, unknown> | undefined;
      const postHull = typeof postShip?.hull === "number" ? postShip.hull : hullCurrent;
      const postHullMax = typeof postShip?.hull_max === "number" ? postShip.hull_max : hullMax;
      const postHullPct = (postHull !== undefined && postHullMax !== undefined && postHullMax > 0)
        ? (postHull / postHullMax) * 100 : 0;

      return handoff(
        `Combat ${outcome} in ${system} — hull at ${Math.round(postHullPct)}%`,
        { system, outcome, hull_pct: Math.round(postHullPct), hull: postHull, hull_max: postHullMax, total_kills: totalKills, total_loot: totalLoot },
        phases,
      );
    }

    // Victory — loot wrecks
    if (outcome === "victory" || kills > 0) {
      totalKills += kills;

      const lootPhase = phase(`loot_${system}`);
      const lootResp = await ctx.client.execute("loot_wrecks");
      if (lootResp.error) {
        ctx.log("warn", `patrol_and_attack: loot_wrecks error: ${JSON.stringify(lootResp.error)}`);
        phases.push(completePhase(lootPhase, { error: lootResp.error }));
      } else {
        const lootResult = lootResp.result as Record<string, unknown> | undefined;
        const credits = typeof lootResult?.credits_looted === "number" ? lootResult.credits_looted : 0;
        const value = typeof lootResult?.total_value === "number" ? lootResult.total_value : credits;
        totalLoot += value;
        phases.push(completePhase(lootPhase, lootResult));
        ctx.log("info", `patrol_and_attack: looted +${value}cr in ${system}`);
      }
    }

    // Check hull after combat
    const postCombatStatus = await ctx.client.execute("get_status");
    const postShip = (postCombatStatus.result as Record<string, unknown> | undefined)?.ship as Record<string, unknown> | undefined;
    const postHull = typeof postShip?.hull === "number" ? postShip.hull : undefined;
    const postHullMax2 = typeof postShip?.hull_max === "number" ? postShip.hull_max : undefined;
    const postHullPct = (postHull !== undefined && postHullMax2 !== undefined && postHullMax2 > 0)
      ? (postHull / postHullMax2) * 100 : 100;

    if (postHullPct < 30) {
      return handoff(
        `Hull dropped to ${Math.round(postHullPct)}% after combat in ${system} — aborting patrol`,
        { system, hull_pct: Math.round(postHullPct), hull: postHull, hull_max: postHullMax2, total_kills: totalKills, total_loot: totalLoot, systems_patrolled: systemsPatrolled },
        phases,
      );
    }
  }

  const summary = `Patrolled ${systemsPatrolled} system${systemsPatrolled !== 1 ? "s" : ""}, ${totalKills} kill${totalKills !== 1 ? "s" : ""}, +${totalLoot.toLocaleString()}cr loot`;
  ctx.log("info", `patrol_and_attack: ${summary}`);

  return done(summary, {
    systems_patrolled: systemsPatrolled,
    total_kills: totalKills,
    total_loot: totalLoot,
    max_targets: maxTargets,
  }, phases);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const patrolAndAttackRoutine: RoutineDefinition<PatrolAndAttackParams> = {
  name: "patrol_and_attack",
  description: "Patrol systems, engage hostiles with scan_and_attack, loot wrecks. Handoff on low hull or defeat.",
  parseParams,
  run,
};
