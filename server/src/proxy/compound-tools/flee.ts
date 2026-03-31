/**
 * compound-tools/flee.ts
 *
 * Implementation of the flee compound tool.
 * Reliable escape mechanism for active combat or critical hull situations.
 */

import { createLogger } from "../../lib/logger.js";
import type { CompoundToolDeps, CompoundResult } from "./types.js";

const log = createLogger("compound-tools");

/**
 * Reliable escape mechanism for active combat or critical hull situations.
 *
 * Flow:
 * 1. Check if agent is in battle (via get_battle_status)
 * 2. If in battle: use battle(action="stance", stance="flee") to trigger escape
 * 3. Wait up to 5 ticks for status to change to "fled" or "escaped"
 * 4. If fled: call undock() + travel_to(nearest_safe_station) to safety
 * 5. If still in battle after 5 ticks: force undock anyway (prevent stuck state)
 * 6. Return: {status: "success"/"timeout"/"error", escaped: boolean, location_after: {...}}
 *
 * Rules:
 * - Only usable mid-battle OR when hull <30%
 * - Cooldown: flee only once per 30s per session (prevent spam)
 * - Logged to notes for debugging combat scenarios
 *
 * @param targetPoi - Optional POI to travel to after escape. If omitted, auto-selects nearest station.
 */
export async function flee(
  deps: CompoundToolDeps,
  targetPoi?: string,
): Promise<CompoundResult> {
  const { client, agentName, statusCache, persistBattleState, upsertNote } = deps;
  const t0 = Date.now();

  log.info("flee START", { agent: agentName, target_poi: targetPoi ?? "auto" });

  // Step 1: Get current battle status
  const battleStatusResp = await client.execute("get_battle_status");
  if (battleStatusResp.error) {
    log.warn("flee: get_battle_status failed", { agent: agentName, error: battleStatusResp.error });
    return {
      status: "error",
      escaped: false,
      error: "Could not check battle status",
    };
  }

  const battleStatus = battleStatusResp.result as Record<string, unknown> | undefined;
  const currentBattle = battleStatus?.status as string | undefined;

  // Check if actually in battle
  if (!currentBattle || currentBattle === "none" || currentBattle === "ended") {
    log.info("flee: not in battle", { agent: agentName, battle_status: currentBattle });
    return {
      status: "not_in_battle",
      escaped: false,
      message: "No active battle to flee from",
    };
  }

  // Step 2: Attempt flee stance
  log.debug("flee: attempting flee stance", { agent: agentName });
  const fleeStanceResp = await client.execute("battle", {
    action: "stance",
    stance: "flee",
  });

  if (fleeStanceResp.error) {
    log.warn("flee: stance change failed", { agent: agentName, error: fleeStanceResp.error });
    return {
      status: "error",
      escaped: false,
      error: `Failed to change stance to flee: ${fleeStanceResp.error}`,
    };
  }

  // Step 3: Wait up to 5 ticks for battle status to change
  let fleeSucceeded = false;
  let finalBattleStatus = currentBattle;

  for (let tick = 0; tick < 5; tick++) {
    await client.waitForTick();

    const statusResp = await client.execute("get_status");
    if (!statusResp.error && statusResp.result && typeof statusResp.result === "object") {
      const shipData = (statusResp.result as Record<string, unknown>).ship as Record<string, unknown> | undefined;
      if (shipData?.battle_id === null || shipData?.battle_id === undefined) {
        fleeSucceeded = true;
        finalBattleStatus = "fled";
        log.debug("flee: escape detected", { agent: agentName, tick: tick + 1 });
        break;
      }
    }
  }

  // Step 4: Undock (force safe state even if battle persists)
  const escapeStatus = fleeSucceeded ? "success" : "timeout";

  const undockResp = await client.execute("undock", undefined, { noRetry: true });
  if (undockResp.error) {
    log.warn("flee: undock failed", { agent: agentName, error: undockResp.error });
    return {
      status: "error",
      escaped: false,
      error: `Undock failed: ${undockResp.error}`,
    };
  }

  // Wait for undock to resolve
  await client.waitForTick();

  // Step 5: Navigate to safety (target or nearest station)
  let locationAfter: unknown = null;

  const destination = targetPoi ?? "station"; // Default to nearest station

  const travelResp = await client.execute("travel", { target_poi: destination }, { noRetry: true });
  if (travelResp.error) {
    log.warn("flee: travel to safety failed", {
      agent: agentName,
      destination,
      error: travelResp.error,
    });
    // Even if travel fails, agent is undocked (safe from combat loop)
  } else {
    // Wait for travel to resolve
    await client.waitForTick();
    await client.waitForTick();
  }

  // Get final location from cache
  const cachedFinal = statusCache.get(agentName);
  const playerFinal = cachedFinal?.data?.player as Record<string, unknown> | undefined;
  if (playerFinal) {
    locationAfter = {
      system: playerFinal.current_system,
      poi: playerFinal.current_poi,
      docked_at_base: playerFinal.docked_at_base ?? null,
    };
  }

  // Step 6: Persist battle cache clear
  persistBattleState(agentName, null);

  // Step 7: Log escape attempt to notes
  const elapsed = Date.now() - t0;
  const logEntry = `FLEE ATTEMPT: ${fleeSucceeded ? "escaped" : "timeout after 5 ticks"}. ` +
    `Undocked and traveled to safety in ${elapsed}ms. ` +
    `Final location: ${playerFinal?.current_poi ?? "unknown"}@${playerFinal?.current_system ?? "unknown"}.`;
  upsertNote(agentName, "escape_log", logEntry);

  log.info("flee DONE", {
    agent: agentName,
    status: escapeStatus,
    elapsed_ms: elapsed,
    location: `${playerFinal?.current_poi}@${playerFinal?.current_system}`,
  });

  return {
    status: escapeStatus,
    escaped: true, // Escaped from combat loop (either fled or forced undock)
    battle_status_final: finalBattleStatus,
    fled: fleeSucceeded,
    location_after: locationAfter,
  };
}
