/**
 * compound-tools/flee.ts
 *
 * Implementation of the flee compound tool.
 * Reliable escape mechanism for active combat or critical hull situations.
 */

import { createLogger } from "../../lib/logger.js";
import type { CompoundToolDeps, CompoundResult } from "./types.js";
import { findSelfParticipant } from "./utils.js";

const log = createLogger("compound-tools");

/**
 * These names say "ticks" (matching the game's own `combat_state.flee_required`/`flee_counter`
 * units) but the loop below does NOT wait on real game-tick boundaries. `client.waitForTick()` on
 * the production v2 client (`http-game-client-v2.ts`) is a no-op poll — it fires two parallel HTTP
 * calls and returns immediately, with no sleep and no synchronization to the game's actual ~10s
 * tick cadence (tracked separately; not in scope for this fix). So each loop iteration here is
 * really a POLL BUDGET (up to 3 HTTP round-trips: waitForTick's refresh, a combat_state re-read,
 * a status re-read), not a wall-clock tick count. Read `FLEE_MAX_WAIT_TICKS` as "at most 60 polls,
 * realistically well under a minute of wall clock at typical LAN/API latency" — NOT "60 game
 * ticks / ~10 minutes", which is what the name would otherwise imply (codex review, 2026-08).
 */
/** Fallback wait, used only when the game omits `combat_state` (older/partial responses). This
 *  is also the floor for the adaptive poll budget — the adaptive bound must never be shorter than
 *  this, or a scenario the old fixed timeout used to catch turns into a spurious timeout (CRIT,
 *  2026-08). */
const FLEE_FALLBACK_WAIT_TICKS = 5;
/**
 * Sane upper bound on the adaptive poll budget. NOT a documented game limit — the OpenAPI spec
 * places no cap on `combat_state.flee_required` ("slower-than-pursuer and webbing raise it"), so
 * this exists only to stop a corrupt/extreme value from spinning the wait loop indefinitely. Set
 * well above any documented/observed value; a cap that's too tight turns real escapes into
 * timeouts. Since polls are cheap (no per-poll sleep — see the block comment above), 60 is not a
 * meaningful wall-clock cap by itself; it is a call-volume cap (bounds how many times flee will
 * hammer the game API before giving up on one call).
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

/**
 * Best-effort read of how many zones separate us from the outer ring right now, using
 * `participants[]` from a `get_battle_status`/`spacemolt_battle(action="status")` result.
 * Falls back to the documented worst case (`MAX_ZONES_TO_OUTER`) when participants are absent
 * or our own row can't be identified — understating this value is what caused CRIT-2.
 */
function zonesToOuterRing(battleStatus: Record<string, unknown> | undefined): number {
  const self = findSelfParticipant(battleStatus);
  const zone = typeof self?.zone === "string" ? self.zone.toLowerCase() : undefined;
  const idx = zone ? (ZONE_ORDER as readonly string[]).indexOf(zone) : -1;
  return idx >= 0 ? idx : MAX_ZONES_TO_OUTER;
}

/**
 * True only when our own participant row is BOTH identifiable (self-only `stance` field present)
 * AND currently at the outer ring. `combat_state.flee_counter` only accumulates "ONLY while in
 * the flee stance AT THE OUTER RING" per the OpenAPI spec, so it is only valid to credit that
 * counter against `flee_required` when we can confirm we're actually there right now. Subtracting
 * it unconditionally (as a prior version of this code did) let a stale/nonzero `flee_counter` read
 * while at some OTHER zone (e.g. "engaged") under-budget the wait — the same failure class as the
 * original CRIT-2 under-wait bug (codex review, 2026-08: flee_required=10, flee_counter=8, zone
 * "engaged" must budget ~13 ticks, not 5).
 */
function isSelfAtOuterRing(battleStatus: Record<string, unknown> | undefined): boolean {
  const self = findSelfParticipant(battleStatus);
  return typeof self?.zone === "string" && self.zone.toLowerCase() === "outer";
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
 *    FLEE_MAX_WAIT_TICKS. Re-checked each tick, but the bound is only ever EXTENDED in response
 *    to a genuinely worse estimate (flee_required or zones-to-outer increasing beyond what has
 *    already been observed) — never merely because ticks elapsed without progress. A stalled
 *    flee (no genuine new obstacle) times out at its original bound instead of ratcheting up to
 *    FLEE_MAX_WAIT_TICKS on every call (HIGH regression fix, 2026-08).
 * 3.5. Re-check combat_state.can_escape on every refresh (not just before step 2): a tackle that
 *      lands mid-flight bails out immediately with "cannot_escape", the same as step 1.5, instead
 *      of running out the wait loop and reporting a bare "timeout".
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
  // battle_id is a REQUIRED field on GetBattleStatusResponse per the live OpenAPI spec, so it is
  // always present whenever is_participant is true for any schema-valid response — checking it
  // here was vacuous (reviewer mutation: dropping `battleId !== undefined` changed 0 test
  // outcomes, 106 pass / 0 fail). Gate on is_participant alone; keep battle_id only for logging
  // below (LOW, 2026-08).
  const battleId = typeof battleStatus?.battle_id === "string" ? battleStatus.battle_id : undefined;
  const inBattle = isParticipant;

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
  const initialAtOuterRing = isSelfAtOuterRing(battleStatus);
  const fleeRequired = typeof combatState?.flee_required === "number" && combatState.flee_required > 0
    ? combatState.flee_required
    : undefined;
  // flee_counter only accumulates ticks already spent fleeing AT THE OUTER RING, so it's only
  // valid to subtract it from flee_required when we can confirm that's where we are right now —
  // see isSelfAtOuterRing. Otherwise (not at outer, or zone unknown) the counter hasn't started
  // banking yet as far as we can tell, so the full flee_required is still ahead of us.
  const remainingFleeTicks = fleeRequired !== undefined
    ? (initialAtOuterRing ? Math.max(0, Math.ceil(fleeRequired) - initialFleeCounter) : Math.ceil(fleeRequired))
    : undefined;
  let maxWaitTicks = remainingFleeTicks !== undefined
    ? Math.min(Math.max(remainingFleeTicks + initialZonesToOuter, FLEE_FALLBACK_WAIT_TICKS), FLEE_MAX_WAIT_TICKS)
    : FLEE_FALLBACK_WAIT_TICKS;

  let fleeSucceeded = false;
  // Proxy-derived outcome label — GetBattleStatusResponse has no `status` field at all (see the
  // is_participant/battle_id comment above), so this must never look like it echoes a real game
  // value. "active" previously masqueraded as one; renamed to make the derivation obvious (LOW,
  // 2026-08).
  let finalBattleStatus: "still_in_battle" | "fled" = "still_in_battle";
  // Number of ticks actually waited before the loop exited (success, mid-loop cannot_escape, or
  // exhaustion). Distinct from maxWaitTicks, which is the BOUND — on an early success/bailout the
  // bound can be larger than what was actually waited (LOW, 2026-08: ticks_waited previously
  // reported the bound in every case, which was only coincidentally correct on timeout).
  let ticksActuallyWaited = 0;
  // Set when a mid-loop combat_state re-check finds escape has become impossible (e.g. a tackle
  // lands after the flee stance was already set). Distinct from the pre-loop cannot_escape gate.
  let midLoopCannotEscape: { message: string; state: BattleCombatState | undefined } | undefined;

  // Tracks the worst flee_required / zones-to-outer actually OBSERVED so far, so the bound below
  // only extends in response to a genuine worsening of the escape estimate (a web/disruptor
  // raising flee_required, or the ship being pushed further from the outer ring) — never merely
  // because ticks have elapsed without progress.
  //
  // HIGH regression fix, 2026-08: the previous formula (`neededFromNow = (tick + 1) + remainingFlee
  // + refreshedZonesToOuter`) combined ELAPSED ticks with the remaining estimate on every refresh.
  // On a stalled flee (remaining not shrinking — self unmatched so zonesToOuter pins at the worst
  // case every tick, or flee_counter genuinely static), that sum grows by ~1 per tick with no new
  // information at all, so the bound always ratcheted up to FLEE_MAX_WAIT_TICKS regardless of
  // whether anything had actually changed. Gating the extension on maxSeenFleeRequired/
  // maxSeenZonesToOuter strictly increasing fixes that: no genuine new obstacle -> no extension ->
  // a stalled flee times out at its original (small) bound instead of the ceiling.
  let maxSeenFleeRequired = fleeRequired ?? 0;
  let maxSeenZonesToOuter = initialZonesToOuter;

  // NOTE (codex review, 2026-08): `tick` here indexes POLLS of this loop, not confirmed game
  // ticks — `client.waitForTick()` on the production v2 client does not block on a real tick
  // boundary (see the FLEE_FALLBACK_WAIT_TICKS/FLEE_MAX_WAIT_TICKS comments above). That's a
  // separate, already-tracked issue; the wait-bound math below is written to be correct in terms
  // of "budgeted polls", and does not assume any particular wall-clock spacing between them.
  for (let tick = 0; tick < maxWaitTicks; tick++) {
    await client.waitForTick();
    ticksActuallyWaited = tick + 1;

    // Re-read combat_state every tick: a web or EM disruptor applied mid-flight can raise
    // flee_required (or leave us further from the outer ring) after the initial snapshot.
    // Only ever EXTEND the bound here, never shrink it — a stale/degraded read must not be
    // able to reproduce the CRIT-2 under-wait bug. See maxSeenFleeRequired/maxSeenZonesToOuter
    // above for why the extension is gated on genuine worsening rather than elapsed time.
    const refreshResp = isV2
      ? await client.execute("spacemolt_battle", { action: "status" })
      : await client.execute("get_battle_status");
    if (!refreshResp.error && refreshResp.result && typeof refreshResp.result === "object") {
      const refreshedResult = refreshResp.result as Record<string, unknown>;
      const refreshedState = refreshedResult.combat_state as BattleCombatState | undefined;

      // MED fix, 2026-08: re-check can_escape on every refresh, not just before the flee stance
      // was set. A tackle that lands mid-flight must bail out of the wait loop immediately rather
      // than run out the clock and report a bare "timeout" (Opus probe E: can_escape flipped
      // true->false after the stance was set; old code returned "timeout", never "cannot_escape").
      // Per the OpenAPI spec, flee_required is OMITTED entirely while warp_disrupted is true
      // ("escape is impossible until the tackle is removed") — treat that combination as the
      // tackled case explicitly, even if can_escape itself is missing/stale on this read.
      const refreshedCanEscape = typeof refreshedState?.can_escape === "boolean" ? refreshedState.can_escape : undefined;
      const refreshedWarpDisrupted = typeof refreshedState?.warp_disrupted === "boolean" ? refreshedState.warp_disrupted : undefined;
      const refreshedFleeRequiredPresent = typeof refreshedState?.flee_required === "number";
      const nowTackled = refreshedCanEscape === false ||
        (refreshedState !== undefined && !refreshedFleeRequiredPresent && refreshedWarpDisrupted === true);

      if (nowTackled) {
        midLoopCannotEscape = {
          message: refreshedWarpDisrupted
            ? "Warp disruption (tackled) is holding your ship in place. Kill the tackler or out-stabilize it before you can flee."
            : "The game reports escape is not currently possible.",
          state: refreshedState,
        };
        break;
      }

      const refreshedRequired = refreshedFleeRequiredPresent && (refreshedState!.flee_required as number) > 0
        ? Math.ceil(refreshedState!.flee_required as number)
        : undefined;
      if (refreshedRequired !== undefined) {
        // Only re-apply the worst-case zone assumption when this refresh actually carries zone
        // evidence (participants[]). Without it, re-adding the worst case every single tick would
        // make the bound diverge forever once remainingFlee bottoms out at 0 (the estimate would
        // permanently "need" one more tick than has elapsed) — the worst case is only meant to
        // cover the INITIAL unknown, not to be re-asserted indefinitely absent new evidence.
        const refreshedZonesToOuter = Array.isArray(refreshedResult.participants)
          ? zonesToOuterRing(refreshedResult)
          : 0;

        if (refreshedRequired > maxSeenFleeRequired || refreshedZonesToOuter > maxSeenZonesToOuter) {
          maxSeenFleeRequired = Math.max(maxSeenFleeRequired, refreshedRequired);
          maxSeenZonesToOuter = Math.max(maxSeenZonesToOuter, refreshedZonesToOuter);
          const refreshedCounter = typeof refreshedState?.flee_counter === "number" ? refreshedState.flee_counter : 0;
          // Same outer-ring gating as the initial budget above: only credit flee_counter when
          // this refresh confirms we're actually at the outer ring right now (codex review,
          // 2026-08 — a stale/nonzero counter read at any other zone must not shrink the
          // remaining estimate).
          const refreshedAtOuterRing = Array.isArray(refreshedResult.participants) && isSelfAtOuterRing(refreshedResult);
          const remainingFlee = refreshedAtOuterRing
            ? Math.max(0, refreshedRequired - refreshedCounter)
            : refreshedRequired;
          const neededFromNow = (tick + 1) + remainingFlee + refreshedZonesToOuter;
          maxWaitTicks = Math.min(Math.max(maxWaitTicks, neededFromNow), FLEE_MAX_WAIT_TICKS);
        }
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

  // Step 3.5: mid-loop cannot_escape bail-out. Mirrors the pre-loop cannot_escape gate (Step 1.5)
  // exactly — no undock/travel attempt, since the game has told us escape is impossible until the
  // tackle is cleared and an undock attempt would just fail with in_combat.
  if (midLoopCannotEscape) {
    log.warn("flee: cannot escape (combat_state re-check mid-loop)", {
      agent: agentName,
      ticks_waited: ticksActuallyWaited,
      combat_state: midLoopCannotEscape.state,
    });
    persistBattleState(agentName, null);
    upsertNote(
      agentName,
      "escape_log",
      `FLEE BLOCKED mid-flight: can_escape=false after ${ticksActuallyWaited} ticks. ${midLoopCannotEscape.message}`,
    );
    return {
      status: "cannot_escape",
      escaped: false,
      message: midLoopCannotEscape.message,
      combat_state: midLoopCannotEscape.state,
    };
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
        ticks_waited: ticksActuallyWaited,
      }
    : undefined;

  const undockResp = isV2
    ? await client.execute("spacemolt", { action: "undock" }, { noRetry: true })
    : await client.execute("undock", undefined, { noRetry: true });
  if (undockResp.error) {
    log.warn("flee: undock failed", { agent: agentName, error: undockResp.error });
    const undockErrStr = typeof undockResp.error === "string" ? undockResp.error : JSON.stringify(undockResp.error);
    // Only a COMBAT-BLOCKED undock failure is legitimately "the timeout outcome surfacing" — every
    // other undock failure (stale/expired session, transport error, an unrelated server error) is
    // a distinct, more actionable failure and must not be masked as "timeout". The previous version
    // of this branch reclassified EVERY undock failure after a timed-out flee as "timeout" as long
    // as fleeSucceeded was false, which would have hidden e.g. a session_invalid error behind a
    // combat-sounding message (HIGH, codex review 2026-08). Same substring check the phantom-detection
    // probe above already uses for this exact error code.
    const undockBlockedByCombat = /in_combat/i.test(undockErrStr);
    if (!fleeSucceeded && undockBlockedByCombat) {
      // Timeout while still in combat means undock legitimately fails with in_combat — that's
      // the timeout outcome surfacing, not a new/different error. Report it as "timeout" (with
      // diagnostics) instead of masking it as a bare "error" with no diagnostics (MED, 2026-08).
      //
      // Deliberately NOT calling persistBattleState(null) here (MED, codex review 2026-08): every
      // poll in the wait loop above still reported an active battle, so persisting "no battle" now
      // would tell a restarted proxy the ship is out of combat when it is, in fact, still in one.
      // persistBattleState only writes the DB snapshot (see cache-persistence.ts) — it does not
      // touch the live in-memory battleCache — so this was a real cross-restart staleness risk,
      // not a harmless redundant clear.
      const elapsed = Date.now() - t0;
      upsertNote(
        agentName,
        "escape_log",
        `FLEE ATTEMPT: timeout after ${ticksActuallyWaited} ticks; undock blocked (still in combat): ` +
          `${undockErrStr}.`,
      );
      log.info("flee DONE (timeout, undock blocked)", { agent: agentName, elapsed_ms: elapsed });
      return {
        status: "timeout",
        escaped: false,
        battle_status_final: finalBattleStatus,
        fled: false,
        error: `Undock failed: ${undockErrStr}`,
        ...(escapeDiagnostics ? { escape_diagnostics: escapeDiagnostics } : {}),
      };
    }
    return {
      status: "error",
      escaped: false,
      error: `Undock failed: ${undockErrStr}`,
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
  const logEntry = `FLEE ATTEMPT: ${fleeSucceeded ? "escaped" : `timeout after ${ticksActuallyWaited} ticks`}. ` +
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
