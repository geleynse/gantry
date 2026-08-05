/**
 * compound-tools/scan-and-attack.ts
 *
 * PvP combat loop: scan for nearby PLAYER entities, initiate attack, run battle loop,
 * auto-loot wrecks on victory.
 *
 * IMPORTANT: `attack` is PvP ONLY. NPC/pirate combat is automatic — the game server
 * resolves NPC aggro when players travel through lawless space. Anonymous entities are
 * NPCs and are excluded from targeting. Only real players (with visible usernames) can
 * be attacked with this tool.
 *
 * For NPC combat: simply travel through lawless systems. Combat resolves automatically.
 * Use loot_wrecks after traveling to collect NPC wreck loot.
 */

import { createLogger } from "../../lib/logger.js";
import type { CompoundToolDeps, CompoundResult, BattleStateForCache } from "./types.js";
import {
  MAX_BATTLE_TICKS,
  BATTLE_INIT_MAX_TICKS,
  stripPendingFields,
  findTargets,
  isAmmoItem,
  findSelfParticipant,
  type BattleParticipant,
} from "./utils.js";
import { battleReadiness } from "./battle-readiness.js";
import { lootWrecks } from "./loot-wrecks.js";

const log = createLogger("compound-tools");

/**
 * PvP combat loop: scan for nearby player entities, attack, run battle loop,
 * auto-loot wrecks on victory.
 *
 * NOTE: This tool is for PvP (player vs player) ONLY. NPC combat is automatic.
 *
 * @param ourAgentNames - Set of lowercase agent names to avoid targeting fleet-mates.
 * @param targetArg     - Optional specific player username or player_id. If omitted,
 *                        auto-selects non-anonymous players via findTargets().
 * @param stanceArg     - Initial combat stance ("aggressive"|"defensive"|"evasive").
 *                        Maps to game stances fire/brace/evade.
 */
export async function scanAndAttack(
  deps: CompoundToolDeps,
  ourAgentNames: Set<string>,
  targetArg?: string,
  stanceArg = "aggressive",
): Promise<CompoundResult> {
  const { client, agentName, statusCache, battleCache, persistBattleState, upsertNote } = deps;
  const isV2 = typeof client.isV2 === "function" && client.isV2();

  // Step 0: Pre-combat readiness check
  const readinessReport = battleReadiness(
    { agentName, statusCache },
    ourAgentNames,
  );

  // Check readiness — battleReadiness now checks weapons, hull, fuel, and ammo
  if (!readinessReport.ready) {
    const issues = readinessReport.issues as string[];
    const reason = issues[0] ?? "Not ready for combat.";
    log.warn("scan_and_attack early exit: not ready", {
      agent: agentName,
      reason,
      readiness: readinessReport,
    });
    return {
      status: "not_ready",
      reason,
      readiness_details: readinessReport,
    };
  }

  const cached = statusCache.get(agentName);

  // Step 1: Get nearby entities
  const nearbyResp = isV2
    ? await client.execute("spacemolt", { action: "get_nearby" })
    : await client.execute("get_nearby");
  const nearbyData = (nearbyResp.result ?? {}) as Record<string, unknown>;
  const liveEntities = (
    Array.isArray(nearbyData.nearby) ? nearbyData.nearby :
    Array.isArray(nearbyData) ? nearbyData : []
  ) as Array<Record<string, unknown>>;

  // Supplement from cache if get_nearby returned nothing
  const allEntities =
    liveEntities.length > 0
      ? liveEntities
      : ((Array.isArray(cached?.data?.nearby) ? cached?.data?.nearby : []) as Array<Record<string, unknown>>);

  log.debug("scan_and_attack scanning", {
    agent: agentName,
    nearby_entities: allEntities.length,
  });

  let targetId: string;
  let targetName: string;

  if (targetArg) {
    // Specific target requested
    targetId = targetArg;
    targetName = targetArg;
    const match = allEntities.find(
      (e) =>
        String(e.player_id ?? "") === targetArg ||
        String(e.username ?? "") === targetArg,
    );
    if (match) {
      targetId = String(match.player_id ?? match.username ?? targetArg);
      targetName = String(match.username ?? targetArg);
    }
  } else {
    // Auto-target: find best candidate
    const targets = findTargets(allEntities, agentName, ourAgentNames);
    if (targets.length === 0) {
      return {
        status: "no_targets",
        nearby_count: allEntities.length,
        nearby: allEntities.slice(0, 10).map((e) => ({
          username: e.username ?? "(anonymous)",
          ship_class: e.ship_class ?? "unknown",
          anonymous: e.anonymous ?? false,
          in_combat: e.in_combat ?? false,
          faction: e.faction_tag ?? null,
        })),
        message:
          "No PvP targets nearby (anonymous entities are NPCs — they cannot be attacked with the attack command). " +
          "NPC combat is automatic: just travel through lawless asteroid belts and combat resolves server-side. " +
          "Use loot_wrecks to collect NPC wreck loot after traveling.",
      };
    }
    const target = targets[0];
    targetId = String(target.player_id ?? target.username ?? "");
    targetName = String(target.username ?? "(anonymous)");
    if (!targetId) {
      return {
        status: "no_target_id",
        nearby_count: allEntities.length,
        message:
          "Found targets but could not extract ID. Try attack(target=username) directly.",
      };
    }
  }

  // Step 1b: Location safety check — can't attack at stations/bases (safe zones)
  const playerData = (cached?.data?.player ?? {}) as Record<string, unknown>;
  const currentPoi = String(playerData.current_poi ?? "");
  const dockedAt = playerData.docked_at_base;
  const isAtSafeZone =
    currentPoi.includes("station") ||
    currentPoi.includes("base") ||
    !!dockedAt;
  if (isAtSafeZone) {
    log.warn("scan_and_attack skipped: safe zone", {
      agent: agentName,
      poi: currentPoi,
      docked: !!dockedAt,
    });
    return {
      status: "safe_zone",
      current_poi: currentPoi,
      docked: !!dockedAt,
      nearby_count: allEntities.length,
      message:
        "Cannot attack at stations or bases — they are safe zones. Travel to an asteroid belt, gas cloud, or other open-space POI first.",
    };
  }
  log.debug("scan_and_attack pre-checks passed", {
    agent: agentName,
    location: currentPoi,
    docked: !!dockedAt,
  });

  // Step 1c: Ammo check
  const shipData = (cached?.data?.ship ?? {}) as Record<string, unknown>;
  const cargoCache = shipData.cargo;
  const cargoItems = (
    Array.isArray(cargoCache) ? cargoCache : []
  ) as Array<Record<string, unknown>>;
  const hasAmmo = cargoItems.some(isAmmoItem);
  let ammoWarning: string | null = null;
  if (!hasAmmo && cargoItems.length > 0) {
    ammoWarning =
      "WARNING: No ammo detected in cargo. Kinetic/explosive weapons won't fire without ammo. Dock and buy ammo.";
  }

  // Map agent-facing stances to game stances
  const stanceMap: Record<string, string> = {
    aggressive: "fire",
    defensive: "brace",
    evasive: "evade",
  };
  const gameStance = stanceMap[stanceArg] ?? stanceArg;

  // Step 2: Attack target to initiate combat
  log.info("scan_and_attack attacking", {
    agent: agentName,
    target: targetName,
    target_id: targetId,
    stance: gameStance,
    no_ammo: !!ammoWarning,
  });
  const attackResp = isV2
    ? await client.execute("spacemolt_battle", { action: "engage", target_id: targetId }, { noRetry: true })
    : await client.execute("attack", { target_id: targetId }, { noRetry: true });

  if (attackResp.error) {
    log.warn("scan_and_attack attack failed", {
      agent: agentName,
      target: targetName,
    });
    return {
      status: "battle_failed",
      target: { id: targetId, name: targetName },
      scan_count: allEntities.length,
      error: attackResp.error,
      hint: "Target may be untargetable, already in combat, or out of range. Try a different target.",
    };
  }

  if (
    attackResp.result &&
    typeof attackResp.result === "object" &&
    "pending" in (attackResp.result as Record<string, unknown>)
  ) {
    await client.waitForTick();
    stripPendingFields(attackResp.result);
  }

  // Wait for battle to initialize — game may need multiple ticks
  let battleStarted = false;
  for (let waitTick = 0; waitTick < BATTLE_INIT_MAX_TICKS; waitTick++) {
    await client.waitForTick();
    log.debug("scan_and_attack battle init attempt", {
      agent: agentName,
      attempt: `${waitTick + 1}/${BATTLE_INIT_MAX_TICKS}`,
    });
    const initCheck = isV2
      ? await client.execute("spacemolt_battle", { action: "status" })
      : await client.execute("get_battle_status");
    // Gate on `is_participant` (required on GetBattleStatusResponse per the live OpenAPI spec,
    // x-gameserver-version v0.552.0), not merely "the call didn't error" — a schema-valid response
    // can succeed with is_participant:false (e.g. a stale read raced ahead of the server actually
    // registering the battle). Same gate flee.ts already uses to decide "are we in a battle".
    const initResult = initCheck.result as Record<string, unknown> | undefined;
    if (!initCheck.error && initResult?.is_participant === true) {
      battleStarted = true;
      log.debug("scan_and_attack battle started", {
        agent: agentName,
        ticks_waited: waitTick + 1,
      });
      break;
    }
  }

  if (!battleStarted) {
    log.warn("scan_and_attack battle init timeout", {
      agent: agentName,
      max_ticks: BATTLE_INIT_MAX_TICKS,
      attempts: BATTLE_INIT_MAX_TICKS,
    });
    return {
      status: "battle_init_timeout",
      target: { id: targetId, name: targetName },
      attack_response: attackResp.result,
      current_poi: currentPoi,
      reason: `No hostiles scanned after ${BATTLE_INIT_MAX_TICKS} ticks`,
      attempts: BATTLE_INIT_MAX_TICKS,
      message:
        "Attack was accepted but battle did not start. Target may have left, be in a protected zone, or be untargetable at this POI.",
    };
  }

  // Set stance via battle command (game stances: fire, evade, brace, flee)
  if (gameStance !== "fire") {
    if (isV2) {
      await client.execute("spacemolt_battle", { action: "stance", stance: gameStance }, { noRetry: true });
    } else {
      await client.execute("battle", { action: "stance", stance: gameStance }, { noRetry: true });
    }
  }

  log.info("scan_and_attack battle engaged", {
    agent: agentName,
    target: targetName,
    stance: gameStance,
  });

  // Log battle start event (use the cache snapshot from before the battle loop)
  const systemAtBattleStart = String(playerData.current_system ?? "unknown");
  const poiAtBattleStart = String(playerData.current_poi ?? "unknown");
  const shipAtBattleStart = (cached?.data?.ship ?? {}) as Record<string, unknown>;
  const hullAtBattleStart = typeof shipAtBattleStart.hull === "number"
    ? shipAtBattleStart.hull
    : -1;

  const battleStartLog = `BATTLE START at ${systemAtBattleStart}/${poiAtBattleStart}. Target: ${targetName}. Your hull: ${hullAtBattleStart}%.`;
  try {
    upsertNote(agentName, "report", battleStartLog);
  } catch (err) {
    log.error("battle start log failed", {
      agent: agentName,
      error: String(err),
    });
  }

  // Step 3: Battle loop — poll get_battle_status until battle ends.
  //
  // GetBattleStatusResponse has NO outcome/status field at all (additionalProperties: false;
  // required: battle_id/system_id/is_participant only — verified against the live OpenAPI spec,
  // x-gameserver-version v0.552.0, 2026-08-04). This loop used to gate on `.status`/`.zone`/
  // `.stance`/`.hull`/`.shields`/`.target`, none of which exist on the response — the
  // victory/defeat/fled comparisons therefore always compared against `undefined`/empty string and
  // could never match, so every battle ran to MAX_BATTLE_TICKS regardless of actual outcome, and
  // the cache written for the dashboard was constants (hull:-1, zone:"unknown", status:"active")
  // every tick. Same defect class as the flee gate this tool's `is_participant` gating mirrors.
  //
  // Fix: gate "still in battle" on `is_participant` (the field flee.ts already gates on), and read
  // per-ship state from `participants[]` (`BattleParticipant.hull_pct`/`shield_pct`/`zone` — see
  // findSelfParticipant in utils.ts). `stance` self-identification there is optional per the spec
  // (BattleParticipant.stance, "self only", not a required field), so self can be unidentifiable on
  // a spec-legal payload; every self-dependent read below is typeof-guarded and degrades to -1/
  // "unknown" rather than assuming a result (ASSUMPTION: reuse flee.ts's exact self-detection
  // signal via the shared findSelfParticipant helper rather than inventing a new one, per the
  // "reuse, don't reinvent" guidance — a stronger signal exists, i.e. matching `participants[].
  // username` against our logged-in username in statusCache, but that touches a file that has
  // already been hardened through several rounds of CRIT/HIGH review and is out of scope here).
  //
  // There is likewise no field distinguishing victory/defeat/fled once the battle ends — see
  // classifyBattleEnd() below for the honest, spec-grounded classification this uses instead.
  let battleOutcome: "victory" | "defeat" | "fled" | "ended" | "unknown" = "unknown";
  let lastStatus: Record<string, unknown> = {};
  let currentStance: string = gameStance;
  let combatAlertSent = false;
  // Last real reading of hull_pct for us / the target, captured from whichever tick actually
  // carried `participants[]` data. The terminal tick that flips `is_participant` to false may
  // carry only `{battle_id, system_id, is_participant}` with no participant rows at all, so the
  // classification below reads these last-known values rather than losing the data.
  let lastSelfHullPct: number | undefined;
  let lastTargetHullPct: number | undefined;

  // Honest battle-end classification. GetBattleStatusResponse never tells us who won — only that
  // we are no longer a participant. Infer from the last real hull_pct readings we captured
  // (0 or below = that side's ship was destroyed) and, failing that, from whether flee was our own
  // last commanded stance. When none of those signals fire, report "ended" rather than guessing —
  // an honest "don't know" beats a fabricated victory/defeat.
  const classifyBattleEnd = (): "victory" | "defeat" | "fled" | "ended" => {
    if (typeof lastSelfHullPct === "number" && lastSelfHullPct <= 0) return "defeat";
    if (typeof lastTargetHullPct === "number" && lastTargetHullPct <= 0) return "victory";
    if (currentStance === "flee") return "fled";
    return "ended";
  };

  for (let i = 0; i < MAX_BATTLE_TICKS; i++) {
    await client.waitForTick();

    const statusResp = isV2
      ? await client.execute("spacemolt_battle", { action: "status" })
      : await client.execute("get_battle_status");
    if (statusResp.error) {
      log.debug("scan_and_attack battle ended (status error)", {
        agent: agentName,
        tick: i,
      });
      battleOutcome = classifyBattleEnd();
      break;
    }

    const statusData = (statusResp.result ?? {}) as Record<string, unknown>;
    if (statusData.pending) {
      await client.waitForTick();
      stripPendingFields(statusData);
    }
    lastStatus = statusData;

    const participants = Array.isArray(statusData.participants)
      ? (statusData.participants as BattleParticipant[])
      : [];
    const self = findSelfParticipant(statusData);
    const selfHullPct = typeof self?.hull_pct === "number" ? self.hull_pct : undefined;
    const selfShieldPct = typeof self?.shield_pct === "number" ? self.shield_pct : undefined;
    const selfZone = typeof self?.zone === "string" ? self.zone : undefined;
    if (typeof selfHullPct === "number") lastSelfHullPct = selfHullPct;
    const targetRow = participants.find((p) => String(p.player_id ?? "") === targetId);
    if (targetRow && typeof targetRow.hull_pct === "number") lastTargetHullPct = targetRow.hull_pct;

    // Update battle cache for UI. Only fields the live response can actually supply: `battle_id`
    // (required top-level field) and our own hull_pct/shield_pct/zone from participants[]
    // (best-effort — see the self-identification note above). `stance` and `target` are what THIS
    // tool commanded, not read back from the response, since the response has no such fields.
    const battleState: BattleStateForCache = {
      battle_id: typeof statusData.battle_id === "string" ? statusData.battle_id : "",
      zone: selfZone ?? "unknown",
      stance: currentStance,
      hull: selfHullPct ?? -1,
      shields: selfShieldPct ?? -1,
      target: targetId,
      status: statusData.is_participant === true ? "active" : "ended",
      updatedAt: Date.now(),
    };
    battleCache.set(agentName, battleState);
    persistBattleState(agentName, battleState);

    if (statusData.is_participant !== true) {
      battleOutcome = classifyBattleEnd();
      log.info("scan_and_attack battle ended", {
        agent: agentName,
        tick: i,
        outcome: battleOutcome,
      });
      break;
    }

    // Hull-based stance switching (self hull_pct only — degrade silently when self isn't
    // identifiable this tick rather than acting on a sentinel/undefined value).
    if (typeof selfHullPct === "number") {
      if (selfHullPct < 20 && currentStance !== "flee") {
        log.warn("scan_and_attack switching to flee", {
          agent: agentName,
          hull_percent: selfHullPct,
        });
        const fleeResp = isV2
          ? await client.execute("spacemolt_battle", { action: "stance", stance: "flee" })
          : await client.execute("battle", { action: "stance", stance: "flee" });
        if (!fleeResp.error) currentStance = "flee";
      } else if (selfHullPct < 30 && (currentStance === "fire" || currentStance === "aggressive")) {
        log.warn("scan_and_attack switching to brace", {
          agent: agentName,
          hull_percent: selfHullPct,
        });
        const braceResp = isV2
          ? await client.execute("spacemolt_battle", { action: "stance", stance: "brace" })
          : await client.execute("battle", { action: "stance", stance: "brace" });
        if (!braceResp.error) currentStance = "brace";
      }

      // Zone advance: move to inner zone when hull is healthy for better hit chance
      const zone = (selfZone ?? "").toLowerCase();
      if (
        selfHullPct > 50 &&
        (currentStance === "fire" || currentStance === "aggressive") &&
        (zone === "outer" || zone === "mid")
      ) {
        if (isV2) {
          await client.execute("spacemolt_battle", { action: "advance" });
        } else {
          await client.execute("battle", { action: "advance" });
        }
      }

      // Combat alert: auto-report when hull drops below 30%
      if (selfHullPct < 30 && !combatAlertSent) {
        combatAlertSent = true;
        const cachedStatus = statusCache.get(agentName);
        const player = (cachedStatus?.data?.player ??
          cachedStatus?.data ??
          {}) as Record<string, unknown>;
        const system = String(player.current_system ?? "unknown");
        const poi = String(player.current_poi ?? "unknown");
        const alertContent = `COMBAT ALERT: Hull critical (${selfHullPct}%) fighting ${targetName} at ${system}/${poi}. Stance: ${currentStance}.`;

        try {
          upsertNote(agentName, "report", alertContent);
        } catch (err) {
          log.error("combat alert report failed", {
            agent: agentName,
            error: String(err),
          });
        }

        log.warn("combat alert: hull critical", {
          agent: agentName,
          hull_percent: selfHullPct,
          target: targetName,
          location: `${system}/${poi}`,
          stance: currentStance,
        });
      }
    }
  }

  // Clear battle cache — fight is over
  battleCache.set(agentName, null);
  persistBattleState(agentName, null);

  // Log battle end event (lastStatus has no `.hull` field on the real response — use the last
  // known self hull_pct captured from participants[] during the loop).
  const finalHull = typeof lastSelfHullPct === "number" ? lastSelfHullPct : -1;
  const battleEndLog = `BATTLE END - ${battleOutcome.toUpperCase()}. Final hull: ${finalHull}%.`;
  try {
    upsertNote(agentName, "report", battleEndLog);
  } catch (err) {
    log.error("battle end log failed", {
      agent: agentName,
      error: String(err),
    });
  }

  // Step 4: Post-kill loot — salvage up to 5 wrecks
  let lootResult: unknown = null;
  if (battleOutcome === "victory" || battleOutcome === "ended") {
    lootResult = await lootWrecks(deps, 5);
  }

  return {
    status: battleOutcome,
    target: { id: targetId, name: targetName },
    stance_final: currentStance,
    battle_status: lastStatus,
    nearby_count: allEntities.length,
    loot: lootResult,
    ...(ammoWarning ? { ammo_warning: ammoWarning } : {}),
    hint:
      battleOutcome === "victory"
        ? "Kill confirmed. Loot collected. Ready for next scan_and_attack (PvP only)."
        : battleOutcome === "defeat"
          ? "You were defeated. Dock for repairs before continuing."
          : battleOutcome === "fled"
            ? "Escaped. Consider repairing before re-engaging."
            : "Battle ended. Check your status. Note: scan_and_attack is PvP only — for NPC loot, use loot_wrecks after traveling through lawless space.",
  };
}
