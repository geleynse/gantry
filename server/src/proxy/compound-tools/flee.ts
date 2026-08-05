/**
 * compound-tools/flee.ts
 *
 * Implementation of the flee compound tool.
 * Reliable escape mechanism for active combat or critical hull situations.
 */

import { createLogger } from "../../lib/logger.js";
import type { CompoundToolDeps, CompoundResult } from "./types.js";

const log = createLogger("compound-tools");

/** Fallback wait, used only when the game omits `combat_state` (older/partial responses). */
const FLEE_FALLBACK_WAIT_TICKS = 5;
/** Hard ceiling on the adaptive wait derived from `combat_state.flee_required` — never unbounded. */
const FLEE_MAX_WAIT_TICKS = 10;

/**
 * `combat_state` block added to `get_battle_status` in game v0.414.0. All fields are
 * read defensively (typeof-checked) since older/partial game responses omit it entirely.
 */
interface BattleCombatState {
  /** Whether escape is possible at all. False only when warp disruption (a tackle) holds you in place. */
  can_escape?: boolean;
  /** An enemy warp disruptor/scrambler is blocking escape. */
  warp_disrupted?: boolean;
  webbed?: boolean;
  em_disrupted?: boolean;
  /** Ship speed after disruption penalties; lower than the pursuer's means you're effectively pinned. */
  effective_speed?: number;
  /** Consecutive flee-stance ticks accumulated at the outer ring. */
  flee_counter?: number;
  /** Flee ticks needed to escape under current conditions. Omitted when warp_disrupted (escape is impossible). */
  flee_required?: number;
  max_weapon_reach?: number;
}

/**
 * Reliable escape mechanism for active combat or critical hull situations.
 *
 * Flow:
 * 1. Check if agent is in battle (via get_battle_status)
 * 1.5. Read v0.414.0 combat_state: if can_escape is false (warp disruption holding the
 *      ship in place), report that directly instead of burning a timeout to find out.
 * 2. If in battle and escape is possible: use battle(action="stance", stance="flee")
 * 3. Wait for status to change to "fled"/"escaped", bounded by combat_state.flee_required
 *    when available (clamped to FLEE_MAX_WAIT_TICKS), else the fixed FLEE_FALLBACK_WAIT_TICKS
 * 4. If fled: call undock() + travel_to(nearest_safe_station) to safety
 * 5. If still in battle after the wait: force undock anyway (prevent stuck state)
 * 6. Return: {status: "success"/"timeout"/"cannot_escape"/"error", escaped: boolean, location_after: {...}}
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
  const isV2 = typeof client.isV2 === "function" && client.isV2();
  const t0 = Date.now();

  log.info("flee START", { agent: agentName, target_poi: targetPoi ?? "auto" });

  // Step 1: Get current battle status
  const battleStatusResp = isV2
    ? await client.execute("spacemolt_battle", { action: "status" })
    : await client.execute("get_battle_status");

  // The game returns error.code === "not_in_battle" instead of a result when no battle exists.
  // Treat that as "no active battle" rather than an opaque failure.
  const isNotInBattleErr = battleStatusResp.error != null &&
    typeof battleStatusResp.error === "object" &&
    (battleStatusResp.error as Record<string, unknown>).code === "not_in_battle";

  if (battleStatusResp.error && !isNotInBattleErr) {
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
  if (isNotInBattleErr || !currentBattle || currentBattle === "none" || currentBattle === "ended") {
    // Caller invoked flee but the game reports no active battle.
    // Probe for phantom in_battle: server's in_combat flag stuck despite battle ending.
    // Symptom: dock/travel/undock return ERROR: in_combat while get_battle_status says not_in_battle.
    // Recovery requires logout+login to resync server state (lumen-shoal 2026-04-27).
    log.info("flee: no active battle reported; probing for phantom in_combat state", {
      agent: agentName, battle_status: currentBattle ?? "not_in_battle_err",
    });

    const dockProbe = isV2
      ? await client.execute("spacemolt", { action: "dock" }, { noRetry: true })
      : await client.execute("dock", undefined, { noRetry: true });
    const probeErrStr = dockProbe.error
      ? (typeof dockProbe.error === "string" ? dockProbe.error : JSON.stringify(dockProbe.error))
      : "";
    const phantomDetected = /in_combat/i.test(probeErrStr);

    if (phantomDetected) {
      log.warn("flee: PHANTOM in_combat detected — server flag stuck despite no active battle", {
        agent: agentName, dock_error: dockProbe.error,
      });
      upsertNote(
        agentName,
        "phantom_battle",
        `PHANTOM in_combat detected at ${new Date().toISOString()}. ` +
          `dock returned in_combat but get_battle_status returned not_in_battle. ` +
          `Recovery requires logout() then login() to resync server state.`,
      );
      // Clear local battle cache as defense-in-depth.
      persistBattleState(agentName, null);
      return {
        status: "phantom_in_battle",
        escaped: false,
        message:
          "PHANTOM in_combat: server flag stuck despite no active battle. " +
          "Recovery: call logout() then login() to resync.",
        recovery: "logout_then_login",
        detected_via: { dock_error: dockProbe.error },
      };
    }

    return {
      status: "not_in_battle",
      escaped: false,
      message: "No active battle to flee from",
    };
  }

  // Step 1.5: v0.414.0 combat_state — if the game says escape is impossible right now,
  // say so directly instead of burning a fixed timeout to discover it. combat_state is
  // optional (older/partial responses omit it); every field is read defensively.
  const combatState = battleStatus?.combat_state as BattleCombatState | undefined;
  const canEscape = typeof combatState?.can_escape === "boolean" ? combatState.can_escape : undefined;
  const warpDisrupted = typeof combatState?.warp_disrupted === "boolean" ? combatState.warp_disrupted : undefined;

  if (canEscape === false) {
    const reason = warpDisrupted
      ? "Warp disruption (tackled) is holding your ship in place. Kill the tackler or out-stabilize it before you can flee."
      : "The game reports escape is not currently possible.";
    log.warn("flee: cannot escape per combat_state", {
      agent: agentName,
      warp_disrupted: warpDisrupted,
      combat_state: combatState,
    });
    upsertNote(
      agentName,
      "escape_log",
      `FLEE BLOCKED: can_escape=false. ${reason}`,
    );
    return {
      status: "cannot_escape",
      escaped: false,
      message: reason,
      combat_state: combatState,
    };
  }

  // Step 2: Attempt flee stance
  log.debug("flee: attempting flee stance", { agent: agentName });
  const fleeStanceResp = isV2
    ? await client.execute("spacemolt_battle", { action: "stance", stance: "flee" })
    : await client.execute("battle", { action: "stance", stance: "flee" });

  if (fleeStanceResp.error) {
    log.warn("flee: stance change failed", { agent: agentName, error: fleeStanceResp.error });
    return {
      status: "error",
      escaped: false,
      error: `Failed to change stance to flee: ${fleeStanceResp.error}`,
    };
  }

  // Step 3: Wait for battle status to change. Bound the wait using the game's own
  // flee_required estimate when available (clamped to FLEE_MAX_WAIT_TICKS so this can
  // never spin unbounded); fall back to the fixed timeout when the field is absent.
  const fleeRequired = typeof combatState?.flee_required === "number" && combatState.flee_required > 0
    ? combatState.flee_required
    : undefined;
  const maxWaitTicks = fleeRequired !== undefined
    ? Math.min(Math.max(Math.ceil(fleeRequired), 1), FLEE_MAX_WAIT_TICKS)
    : FLEE_FALLBACK_WAIT_TICKS;

  let fleeSucceeded = false;
  let finalBattleStatus = currentBattle;

  for (let tick = 0; tick < maxWaitTicks; tick++) {
    await client.waitForTick();

    const statusResp = isV2
      ? await client.execute("spacemolt", { action: "get_status" })
      : await client.execute("get_status");
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

  const undockResp = isV2
    ? await client.execute("spacemolt", { action: "undock" }, { noRetry: true })
    : await client.execute("undock", undefined, { noRetry: true });
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

  const travelResp = isV2
    ? await client.execute("spacemolt", { action: "travel", target_poi: destination }, { noRetry: true })
    : await client.execute("travel", { target_poi: destination }, { noRetry: true });
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
  const logEntry = `FLEE ATTEMPT: ${fleeSucceeded ? "escaped" : `timeout after ${maxWaitTicks} ticks`}. ` +
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
    // Diagnostic only; present whenever the game supplied combat_state (v0.414.0+).
    // Does not change status/escaped semantics — just explains the wait bound used.
    ...(combatState
      ? {
          escape_diagnostics: {
            can_escape: canEscape,
            warp_disrupted: warpDisrupted,
            webbed: combatState.webbed,
            em_disrupted: combatState.em_disrupted,
            effective_speed: combatState.effective_speed,
            flee_required: fleeRequired,
            ticks_waited: maxWaitTicks,
          },
        }
      : {}),
  };
}
