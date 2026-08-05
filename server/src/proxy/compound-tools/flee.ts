/**
 * compound-tools/flee.ts
 *
 * Implementation of the flee compound tool.
 * Reliable escape mechanism for active combat or critical hull situations.
 */

import { createLogger } from "../../lib/logger.js";
import type { CompoundToolDeps, CompoundResult } from "./types.js";

const log = createLogger("compound-tools");

/** Fallback wait, used only when the game omits `combat_state` (older/partial responses). This
 *  is also the floor for the adaptive wait — the adaptive bound must never be shorter than this,
 *  or a scenario the old fixed timeout used to catch turns into a spurious timeout (CRIT, 2026-08). */
const FLEE_FALLBACK_WAIT_TICKS = 5;
/**
 * Sane upper bound on the adaptive wait. NOT a documented game limit — the OpenAPI spec places
 * no cap on `combat_state.flee_required` ("slower-than-pursuer and webbing raise it"), so this
 * exists only to stop a corrupt/extreme value from spinning the wait loop indefinitely. Set well
 * above any documented/observed value; a cap that's too tight turns real escapes into timeouts.
 */
const FLEE_MAX_WAIT_TICKS = 60;
/**
 * Zone order from outermost to innermost, per the live OpenAPI spec's `BattleParticipant.zone`
 * enum ("outer/mid/inner/engaged") and the `/battle` stance doc ("advance: outer→mid→inner→engaged").
 */
const ZONE_ORDER = ["outer", "mid", "inner", "engaged"] as const;
/**
 * Worst-case zones-from-outer, used whenever we can't determine our current zone. `engaged` (the
 * innermost ring) is 3 zones from outer, matching the `/battle` stance doc's "flee ... auto-retreats,
 * 3 ticks from outer to escape". Assuming this worst case (rather than 0) is required for CRIT-2:
 * understating zones-to-outer understates the wait and turns real escapes into timeouts.
 */
const MAX_ZONES_TO_OUTER = 3;

/**
 * `combat_state` block added to `get_battle_status` in game v0.414.0. All fields are
 * read defensively (typeof-checked) since older/partial game responses omit it entirely.
 * Shape verified against the live OpenAPI spec (game.spacemolt.com/api/openapi.json,
 * x-gameserver-version v0.552.0) on 2026-08-04.
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
  /** Remaining ticks of EM disruption. Present only while em_disrupted. */
  disruption_ticks?: number;
  /** Current speed reduction from EM disruption, as a percentage. Present only while em_disrupted. */
  speed_penalty_pct?: number;
}

/** Minimal shape of a `GetBattleStatusResponse.participants[]` entry that we read. */
interface BattleParticipantLike {
  zone?: string;
  /** Populated ("self only" per the OpenAPI spec) on the row that corresponds to the calling
   *  player; omitted/empty on every other combatant's row. Used to pick out our own row. */
  stance?: string;
}

/**
 * Best-effort read of how many zones separate us from the outer ring right now, using
 * `participants[]` from a `get_battle_status`/`spacemolt_battle(action="status")` result.
 * Falls back to the documented worst case (`MAX_ZONES_TO_OUTER`) when participants are absent
 * or our own row can't be identified — understating this value is what caused CRIT-2.
 */
function zonesToOuterRing(battleStatus: Record<string, unknown> | undefined): number {
  const participants = Array.isArray(battleStatus?.participants)
    ? (battleStatus!.participants as BattleParticipantLike[])
    : undefined;
  const self = participants?.find((p) => typeof p.stance === "string" && p.stance.length > 0);
  const zone = typeof self?.zone === "string" ? self.zone.toLowerCase() : undefined;
  const idx = zone ? (ZONE_ORDER as readonly string[]).indexOf(zone) : -1;
  return idx >= 0 ? idx : MAX_ZONES_TO_OUTER;
}

/**
 * Reliable escape mechanism for active combat or critical hull situations.
 *
 * Flow:
 * 1. Check if agent is in battle via get_battle_status, gating on the documented
 *    `is_participant`/`battle_id` fields (the response has no `status` field — verified
 *    against the live OpenAPI spec, x-gameserver-version v0.552.0, 2026-08-04).
 * 1.5. Read v0.414.0 combat_state: if can_escape is false (warp disruption holding the
 *      ship in place), report that directly instead of burning a timeout to find out.
 * 2. If in battle and escape is possible: use battle(action="stance", stance="flee")
 * 3. Wait for the battle to clear, bounded by combat_state.flee_required PLUS the zones
 *    separating us from the outer ring (flee auto-retreats zone-by-zone before flee_counter
 *    starts accumulating there — see zonesToOuterRing), floored at FLEE_FALLBACK_WAIT_TICKS
 *    so the adaptive bound is never shorter than the old fixed wait, and clamped to
 *    FLEE_MAX_WAIT_TICKS. Re-checked each tick so a mid-flight web/disruption can only
 *    extend the bound, never shrink it.
 * 4. If fled: call undock() + travel_to(nearest_safe_station) to safety
 * 5. If still in battle after the wait: attempt undock anyway (prevent stuck state); if that
 *    also fails (still in_combat), report "timeout" rather than masking it as "error"
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
  // GetBattleStatusResponse has NO `status` field (verified against the live OpenAPI spec,
  // additionalProperties: false, required: battle_id/system_id/is_participant only). Gating on
  // a nonexistent `.status` made `!currentBattle` always true, so real combat always fell into
  // the phantom-probe branch below instead of reaching the flee logic (CRIT, 2026-08).
  const isParticipant = battleStatus?.is_participant === true;
  const battleId = typeof battleStatus?.battle_id === "string" ? battleStatus.battle_id : undefined;
  const inBattle = isParticipant && battleId !== undefined;

  // Check if actually in battle
  if (isNotInBattleErr || !inBattle) {
    // Caller invoked flee but the game reports no active battle.
    // Probe for phantom in_battle: server's in_combat flag stuck despite battle ending.
    // Symptom: dock/travel/undock return ERROR: in_combat while get_battle_status says not_in_battle.
    // Recovery requires logout+login to resync server state (lumen-shoal 2026-04-27).
    log.info("flee: no active battle reported; probing for phantom in_combat state", {
      agent: agentName,
      is_participant: isParticipant,
      battle_id: battleId ?? (isNotInBattleErr ? "not_in_battle_err" : null),
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

  // Step 3: Wait for the battle to clear. The true cost of a flee is NOT just flee_required —
  // flee_counter only accumulates "ONLY while in the flee stance AT THE OUTER RING" (per the
  // OpenAPI spec), and the ship must first auto-retreat zone-by-zone to reach the outer ring
  // (up to MAX_ZONES_TO_OUTER ticks from "engaged", per the /battle stance doc). Waiting
  // flee_required alone undercounts the zone-transit time and turns real escapes into timeouts
  // (CRIT, 2026-08: proven with escapeOnTick=4/flee_required=3 -> old adaptive-only code timed
  // out at 3 polls where the true fixed-5 wait succeeded at poll 4).
  //
  // combat_state.flee_counter counts ticks already spent fleeing at the outer ring, so the
  // remaining wait is (flee_required - flee_counter), not flee_required itself.
  //
  // The bound is floored at FLEE_FALLBACK_WAIT_TICKS (never shorter than the old fixed wait)
  // and clamped to FLEE_MAX_WAIT_TICKS (a safety net, not a documented limit).
  const initialZonesToOuter = zonesToOuterRing(battleStatus);
  const initialFleeCounter = typeof combatState?.flee_counter === "number" ? combatState.flee_counter : 0;
  const fleeRequired = typeof combatState?.flee_required === "number" && combatState.flee_required > 0
    ? combatState.flee_required
    : undefined;
  // flee_counter only accumulates ticks already spent fleeing at the outer ring, so what's left
  // to wait for is (flee_required - flee_counter), not flee_required itself.
  const remainingFleeTicks = fleeRequired !== undefined
    ? Math.max(0, Math.ceil(fleeRequired) - initialFleeCounter)
    : undefined;
  let maxWaitTicks = remainingFleeTicks !== undefined
    ? Math.min(Math.max(remainingFleeTicks + initialZonesToOuter, FLEE_FALLBACK_WAIT_TICKS), FLEE_MAX_WAIT_TICKS)
    : FLEE_FALLBACK_WAIT_TICKS;

  let fleeSucceeded = false;
  let finalBattleStatus = "active";

  for (let tick = 0; tick < maxWaitTicks; tick++) {
    await client.waitForTick();

    // Re-read combat_state every tick: a web or EM disruptor applied mid-flight can raise
    // flee_required (or leave us further from the outer ring) after the initial snapshot.
    // Only ever EXTEND the bound here, never shrink it — a stale/degraded read must not be
    // able to reproduce the CRIT-2 under-wait bug.
    const refreshResp = isV2
      ? await client.execute("spacemolt_battle", { action: "status" })
      : await client.execute("get_battle_status");
    if (!refreshResp.error && refreshResp.result && typeof refreshResp.result === "object") {
      const refreshedResult = refreshResp.result as Record<string, unknown>;
      const refreshedState = refreshedResult.combat_state as BattleCombatState | undefined;
      const refreshedRequired = typeof refreshedState?.flee_required === "number" && refreshedState.flee_required > 0
        ? Math.ceil(refreshedState.flee_required)
        : undefined;
      if (refreshedRequired !== undefined) {
        const refreshedCounter = typeof refreshedState?.flee_counter === "number" ? refreshedState.flee_counter : 0;
        const remainingFlee = Math.max(0, refreshedRequired - refreshedCounter);
        // Only re-apply the worst-case zone assumption when this refresh actually carries zone
        // evidence (participants[]). Without it, re-adding the worst case every single tick would
        // make the bound diverge forever once remainingFlee bottoms out at 0 (the estimate would
        // permanently "need" one more tick than has elapsed) — the worst case is only meant to
        // cover the INITIAL unknown, not to be re-asserted indefinitely absent new evidence.
        const refreshedZonesToOuter = Array.isArray(refreshedResult.participants)
          ? zonesToOuterRing(refreshedResult)
          : 0;
        const neededFromNow = (tick + 1) + remainingFlee + refreshedZonesToOuter;
        maxWaitTicks = Math.min(Math.max(maxWaitTicks, neededFromNow), FLEE_MAX_WAIT_TICKS);
      }
    }

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
  const escapeDiagnostics = combatState
    ? {
        can_escape: canEscape,
        warp_disrupted: warpDisrupted,
        webbed: combatState.webbed,
        em_disrupted: combatState.em_disrupted,
        effective_speed: combatState.effective_speed,
        disruption_ticks: combatState.disruption_ticks,
        flee_required: fleeRequired,
        flee_counter: combatState.flee_counter,
        zones_to_outer: initialZonesToOuter,
        ticks_waited: maxWaitTicks,
      }
    : undefined;

  const undockResp = isV2
    ? await client.execute("spacemolt", { action: "undock" }, { noRetry: true })
    : await client.execute("undock", undefined, { noRetry: true });
  if (undockResp.error) {
    log.warn("flee: undock failed", { agent: agentName, error: undockResp.error });
    if (!fleeSucceeded) {
      // Timeout while still in combat means undock legitimately fails with in_combat — that's
      // the timeout outcome surfacing, not a new/different error. Report it as "timeout" (with
      // diagnostics) instead of masking it as a bare "error" with no diagnostics and no cache
      // clear (MED, 2026-08).
      persistBattleState(agentName, null);
      const elapsed = Date.now() - t0;
      upsertNote(
        agentName,
        "escape_log",
        `FLEE ATTEMPT: timeout after ${maxWaitTicks} ticks; undock blocked (still in combat): ` +
          `${JSON.stringify(undockResp.error)}.`,
      );
      log.info("flee DONE (timeout, undock blocked)", { agent: agentName, elapsed_ms: elapsed });
      return {
        status: "timeout",
        escaped: false,
        battle_status_final: finalBattleStatus,
        fled: false,
        error: `Undock failed: ${JSON.stringify(undockResp.error)}`,
        ...(escapeDiagnostics ? { escape_diagnostics: escapeDiagnostics } : {}),
      };
    }
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
    ...(escapeDiagnostics ? { escape_diagnostics: escapeDiagnostics } : {}),
  };
}
