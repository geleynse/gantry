/**
 * Post-processing handlers for handlePassthrough.
 *
 * Extracted from passthrough-handler.ts. These run AFTER the game call has been
 * dispatched. They operate on the raw client response (`resp`) plus a
 * PassthroughExecContext carrying the execution-phase state (log ids, elapsed
 * time, captured nav-before snapshot, poi warning).
 *
 * Convention mirrors the guards module:
 *   - Handlers that may short-circuit return `McpTextResult | null`
 *     (non-null = "return this to the agent", null = "continue the pipeline").
 *   - Side-effect-only handlers (log lines, cache mutations, resp mutations)
 *     return void — every mutation of `resp` / `resp.result` is applied in place
 *     against the same object reference the orchestrator holds.
 *
 * ORDER IS LOAD-BEARING. handleSuccessPath is the terminal phase and always
 * returns an McpTextResult.
 */

import {
  textResult,
  executeForClient,
  waitForActionResult,
  extractLocalBids,
  type McpTextResult,
  type PassthroughExecContext,
} from "./passthrough-handler.js";
import { createLogger } from "../lib/logger.js";
import { summarizeToolResult } from "./summarizers.js";
import { addErrorHint, type HintContext } from "./error-hints.js";
import { enrichWithGlobalContext } from "./market-enrichment.js";
import { parseMarketInsights } from "../services/market-insights.js";
import { recordStationObservation } from "../services/market-history.js";
import { CACHE_INVALIDATING_TOOLS } from "./analyze-market-cache.js";
import { cacheSystemPois } from "./poi-resolver.js";
import { addDiaryEntry } from "../services/notes-db.js";
import { validateCaptainsLogFormat } from "./pipeline.js";
import { syncCaptainsLogsFromServer, persistCaptainsLogEntry } from "../services/captains-logs-db.js";
import { syncActionLog, persistActionLogEntries } from "../services/action-log-parser.js";
import { markDockable, isDockable, recordDockFailure } from "../services/galaxy-poi-registry.js";
import { enrichWithThreatAssessment } from "./threat-assessment.js";
import { normalizeSystemName } from "./compound-tools/utils.js";
import { autoRecordLoreFromResult, buildLoreHint } from "../services/poi-lore.js";
import { recordMarketResources } from "../services/resource-knowledge.js";

const log = createLogger("passthrough");

type ClientResp = { result?: unknown; error?: { code?: unknown; message?: unknown } | null };

// Known response fields for nav tools — used for schema drift detection.
const KNOWN_NAV_FIELDS: Record<string, Set<string>> = {
  jump: new Set(["status", "completed", "location_after", "system", "message", "pending", "error", "tick", "command", "arrival_tick", "fuel_cost", "transit_destination", "destination", "ticks_remaining"]),
  travel: new Set(["status", "completed", "location_after", "poi", "message", "pending", "error", "tick", "command", "arrival_tick", "fuel_cost", "transit_destination", "destination", "ticks_remaining"]),
  jump_route: new Set(["status", "completed", "location_after", "jumps_completed", "jumps_total", "stopped_reason", "error", "fuel_used"]),
};

// --- 2a. Unknown field detection for nav tools ---
// Log any top-level response fields we don't recognize so we can spot schema drift.
export function detectUnknownNavFields(ctx: PassthroughExecContext, resp: ClientResp): void {
  const { agentName, v1ToolName } = ctx;
  if (!resp.error && resp.result && typeof resp.result === "object") {
    const knownFields = KNOWN_NAV_FIELDS[v1ToolName];
    if (knownFields) {
      const resultObj = resp.result as Record<string, unknown>;
      const unexpected: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(resultObj)) {
        if (!knownFields.has(k)) unexpected[k] = v;
      }
      if (Object.keys(unexpected).length > 0) {
        log.warn("unexpected_nav_field", {
          agent: agentName,
          tool: v1ToolName,
          unexpected_fields: JSON.stringify(unexpected),
        });
      }
    }
  }
}

// --- 2c. Nav-cache refresh on jump error/timeout ---
// When a jump or jump_route times out, the game server may have moved the ship even though
// the HTTP response was an error. waitForNavCacheUpdate is gated on !resp.error (below) so
// it never runs on timeout. Force a status refresh here so the cache reflects authoritative
// game state — otherwise the next adjacency check uses a stale "from" location and rejects
// all subsequent jumps from the agent's actual position.
//
// Cap the refresh at 15s (separate from the underlying client's COMMAND_TIMEOUT_MS=90s).
// If the refresh itself stalls or fails to update the cache, mutate the error response
// to include _nav_cache_stale:true so the agent knows to call get_status before the next
// jump rather than retrying blind on a stale "from" location (which produced already_here
// loops in the 2026-04-28 stability investigation).
export async function refreshNavCacheOnJumpError(ctx: PassthroughExecContext, resp: ClientResp): Promise<void> {
  const { agentName, v1ToolName, isNavTool, client, deps } = ctx;
  const { statusCache } = deps;

  if (resp.error && isNavTool && (v1ToolName === "jump" || v1ToolName === "jump_route")) {
    const REFRESH_TIMEOUT_MS = 15_000;
    const cachedFetchedAtBefore = statusCache.get(agentName)?.fetchedAt ?? 0;
    let refreshTimedOut = false;
    let refreshFailed = false;

    try {
      await Promise.race([
        client.waitForTick(),
        new Promise<void>((_, reject) =>
          setTimeout(() => {
            refreshTimedOut = true;
            reject(new Error("nav-cache refresh exceeded 15s cap"));
          }, REFRESH_TIMEOUT_MS),
        ),
      ]);
    } catch (err) {
      refreshFailed = true;
      log.warn("nav-tool error: post-timeout cache refresh failed", {
        agent: agentName,
        tool: v1ToolName,
        timed_out: refreshTimedOut,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Even if waitForTick resolved without throwing, the cache might not have
    // been updated (refreshStatus returned null). Detect that by checking
    // whether fetchedAt advanced. If not, treat as a refresh failure.
    const cachedFetchedAtAfter = statusCache.get(agentName)?.fetchedAt ?? 0;
    const cacheUpdated = cachedFetchedAtAfter > cachedFetchedAtBefore;

    if (refreshFailed || !cacheUpdated) {
      // Mutate error response so the agent knows the cache is unreliable.
      // Defensive: only mutate if error is a plain object we can extend.
      if (resp.error && typeof resp.error === "object" && !Array.isArray(resp.error)) {
        (resp.error as Record<string, unknown>)._nav_cache_stale = true;
      }
      log.warn("nav-tool error: nav cache may be stale after refresh attempt", {
        agent: agentName,
        tool: v1ToolName,
        refresh_failed: refreshFailed,
        cache_updated: cacheUpdated,
      });
    } else {
      log.info("nav-tool error: forced status refresh to resync nav cache", {
        agent: agentName,
        tool: v1ToolName,
        error: JSON.stringify(resp.error).slice(0, 120),
      });
    }
  }
}

// --- 3. State-changing tick wait ---
// Returns a short-circuit McpTextResult (dock-verification failure / commission
// mismatch) or null to continue the pipeline. All resp.result mutations are
// applied in place.
export async function handleStateChangingTickWait(
  ctx: PassthroughExecContext,
  resp: ClientResp,
): Promise<McpTextResult | null> {
  const {
    agentName, action, v1ToolName, payload, navDest, isNavTool, client, deps,
    pendingId, completeLog, elapsed, navBefore,
  } = ctx;
  const { statusCache, gameHealthRef, stateChangingTools, waitForNavCacheUpdate, waitForDockCacheUpdate, stripPendingFields, withInjections } = deps;
  const { navBeforeSystem, navStartMs, arrivalTickBeforeNav } = navBefore;

  if (!resp.error && stateChangingTools.has(v1ToolName)) {
    // Normalize result to an object — game server sometimes returns empty string or non-object
    // for state-changing tools like dock. Without this, the tick-wait and verification blocks
    // are skipped entirely, causing silent failures (e.g. dock "succeeds" but agent isn't docked).
    const resultObj: Record<string, unknown> = (resp.result && typeof resp.result === "object" && !Array.isArray(resp.result))
      ? resp.result as Record<string, unknown>
      : { _raw: resp.result ?? null };
    const wasPending = "pending" in resultObj && resultObj.pending === true;

    if (isNavTool) {
      // Navigation: skip generic tick wait, use smart cache wait.
      // Jump: loop until current_system changes (up to 3 ticks).
      // Travel: single tick wait is sufficient.
      if (wasPending) stripPendingFields(resultObj);

      if ((v1ToolName === "jump" || v1ToolName === "jump_route") && navBeforeSystem) {
        const updated = await waitForNavCacheUpdate(client, agentName, navBeforeSystem, undefined, arrivalTickBeforeNav);
        if (!updated) {
          const arrTick = client.lastArrivalTick ?? "none";
          const cacheTick = statusCache.get(agentName)?.data?.tick ?? "?";
          // Cache didn't update — server confirmation pending. Do NOT guess destination.
          // Injecting a warning into the tool response so the agent knows to call get_location.
          log.warn("jump cache lag — server confirmation not yet received", {
            agent: agentName,
            tool: v1ToolName,
            cached_system: String(navBeforeSystem),
            target_system: navDest ? String(navDest) : "unknown",
            arrival_tick: String(arrTick),
            cache_tick: String(cacheTick),
          });
          // Append a warning to the result so the agent knows to verify position
          if (resultObj && typeof resultObj === "object") {
            (resultObj as Record<string, unknown>)._nav_warning =
              "Server confirmation pending — call get_status to verify actual position before next jump.";
          }
        }
        // For jump_route with location_after in response, verify it matches expected destination
        if (v1ToolName === "jump_route" && resultObj.location_after && typeof resultObj.location_after === "object") {
          const locAfter = resultObj.location_after as Record<string, unknown>;
          if (navDest && locAfter.system !== navDest) {
            log.error("jump_route returned wrong destination", {
              agent: agentName,
              expected_system: String(navDest),
              actual_system: String(locAfter.system),
              response: JSON.stringify(resultObj).slice(0, 300),
            });
            // Update cache with actual location from response
            const cached = statusCache.get(agentName);
            if (cached?.data?.player && typeof cached.data.player === "object") {
              (cached.data.player as Record<string, unknown>).current_system = locAfter.system;
              (cached.data.player as Record<string, unknown>).current_poi = locAfter.poi;
              statusCache.set(agentName, { data: cached.data, fetchedAt: Date.now() });
            }
          }
        }
      } else {
        // travel or jump/jump_route without navBeforeSystem
        await client.waitForTick();
      }

      // --- 2b. location_after mismatch detection ---
      // If the game response includes a system hint AND cache disagrees, warn loudly.
      if (resp.result && typeof resp.result === "object") {
        const navResult = resp.result as Record<string, unknown>;
        const gameSystem = (navResult.system ?? navResult.current_system) as string | undefined;
        if (gameSystem) {
          const cacheAfterCheck = statusCache.get(agentName);
          const cacheSystem = (cacheAfterCheck?.data?.player as Record<string, unknown> | undefined)?.current_system as string | undefined;
          const locAfterSystem = (navResult.location_after as Record<string, unknown> | undefined)?.system as string | undefined;
          const effectiveCacheSystem = cacheSystem ?? locAfterSystem;
          if (effectiveCacheSystem && normalizeSystemName(effectiveCacheSystem) !== normalizeSystemName(gameSystem)) {
            log.warn("location_after_mismatch", {
              agent: agentName,
              tool: v1ToolName,
              game_response_system: gameSystem,
              cache_system: effectiveCacheSystem,
              warning: "Cache location_after may be stale — agent may navigate from wrong position",
            });
            // Inject warning into result
            if (resultObj && typeof resultObj === "object") {
              (resultObj as any)._cache_warning = `System mismatch: Game says ${gameSystem} but cache says ${effectiveCacheSystem}. Trust the game response and call get_status to sync.`;
            }
          }
        }
      }

      // Log post-navigation location for debugging
      const cachedAfter = statusCache.get(agentName);
      const playerAfter = cachedAfter?.data?.player as Record<string, unknown> | undefined;
      const afterAgentTick = cachedAfter?.data?.tick;
      const afterServerTick = gameHealthRef.current?.tick;
      const afterDrift =
        typeof afterAgentTick === "number" && afterServerTick ? afterServerTick - afterAgentTick : "?";
      const navElapsed = navStartMs ? Date.now() - navStartMs : "?";
      log.debug(`${v1ToolName} AFTER`, {
        agent: agentName,
        elapsed_ms: String(navElapsed),
        system: String(playerAfter?.current_system),
        poi: String(playerAfter?.current_poi),
        docked: playerAfter?.docked_at_base ?? "none",
        tick: String(afterAgentTick),
        server_tick: String(afterServerTick ?? "?"),
        drift: String(afterDrift),
        result: JSON.stringify(resp.result).slice(0, 100),
      });
    } else {
      // Non-nav state-changing tools: smart wait when pending, generic tick wait otherwise.
      if (wasPending) {
        log.debug("tool returned pending, waiting for action_result", {
          agent: agentName,
          tool: v1ToolName,
        });
      }

      // Pre-capture state for specific tools to verify success
      let fuelBefore: number | undefined;
      let cargoBefore: any[] | undefined;
      let cargoUsedBefore: number | undefined;
      const isWithdraw = v1ToolName === "withdraw_items";
      const isJettison = v1ToolName === "jettison";
      if (v1ToolName === "refuel" || isWithdraw || isJettison) {
        const cached = statusCache.get(agentName);
        fuelBefore = (cached?.data?.ship as any)?.fuel;
        cargoBefore = (cached?.data?.ship as any)?.cargo;
        cargoUsedBefore = (cached?.data?.ship as any)?.cargo_used;
      }

      if (wasPending) {
        // Use smart event-buffer poll when available so we return as soon as the
        // server confirms the action, rather than burning a full tick interval.
        const eventBuffer = deps.eventBuffers?.get(agentName);
        if (eventBuffer) {
          const actionTimeoutMs = deps.actionResultTimeoutMs ?? 15_000;
          await waitForActionResult(eventBuffer, v1ToolName, actionTimeoutMs);
          log.debug("action_result received (or timed out) for pending tool", {
            agent: agentName,
            tool: v1ToolName,
          });
        } else {
          // No event buffer wired up — fall back to blind tick wait
          await client.waitForTick();
        }
        stripPendingFields(resultObj);
      } else {
        await client.waitForTick();
      }

      if (wasPending) {
        log.debug("wait resolved for pending tool", {
          agent: agentName,
          tool: v1ToolName,
        });
      }

      // Explicit verification for refuel/withdraw/jettison
      if (v1ToolName === "refuel" || isWithdraw || isJettison) {
        const cached = statusCache.get(agentName);
        if (v1ToolName === "refuel") {
          const fuelAfter = (cached?.data?.ship as any)?.fuel;
          if (fuelAfter !== undefined && fuelBefore !== undefined && fuelAfter <= fuelBefore && fuelAfter < ((cached?.data?.ship as any)?.max_fuel ?? 0)) {
            const maxFuel = (cached?.data?.ship as any)?.max_fuel;
            log.warn("refuel verify failed — fuel did not increase", { agent: agentName, fuelBefore, fuelAfter, maxFuel });
            if (resultObj) (resultObj as any)._verify_warning = `Verification failed: fuel stayed at ${fuelAfter}/${maxFuel} after refuel. Possible causes: not docked, station has no fuel service, or insufficient credits (refuel costs 1cr per unit).`;
          }
        }
        if (isWithdraw) {
          const cargoUsedAfterW = (cached?.data?.ship as any)?.cargo_used;
          const cargoAfterW = (cached?.data?.ship as any)?.cargo;
          // Use cargo_used (numeric) as primary signal — more reliable than JSON-comparing arrays.
          // Only fire the warning if we have definitive pre/post numbers AND both show no change.
          // Skip if pre-capture data was unavailable (cache miss before execute).
          const cargoUsedUnchanged =
            cargoUsedAfterW !== undefined &&
            cargoUsedBefore !== undefined &&
            cargoUsedAfterW <= cargoUsedBefore;
          const cargoArrayUnchanged =
            cargoUsedAfterW === undefined &&
            cargoAfterW && cargoBefore &&
            JSON.stringify(cargoAfterW) === JSON.stringify(cargoBefore);
          if (cargoBefore !== undefined && (cargoUsedUnchanged || cargoArrayUnchanged)) {
            log.warn("withdraw_items verify: cargo unchanged after tick", {
              agent: agentName,
              cargo_used_before: cargoUsedBefore,
              cargo_used_after: cargoUsedAfterW,
            });
            // Use a softer warning — the game may send an async action_error separately.
            // Telling agent to call get_status avoids them looping on a wrong item_id.
            if (resultObj) (resultObj as any)._verify_warning =
              "Cargo hold unchanged after withdraw — item may not be in station storage, " +
              "or the action failed asynchronously. Call get_status to check current cargo, " +
              "then view_storage to verify item IDs in storage.";
          }
        }
        if (isJettison) {
          const cargoUsedAfter = (cached?.data?.ship as any)?.cargo_used;
          const cargoAfter = (cached?.data?.ship as any)?.cargo;
          // Check cargo_used first (fast path), fall back to full cargo array comparison
          const cargoUnchanged =
            (cargoUsedAfter !== undefined && cargoUsedBefore !== undefined && cargoUsedAfter >= cargoUsedBefore) ||
            (cargoAfter && cargoBefore && JSON.stringify(cargoAfter) === JSON.stringify(cargoBefore));
          if (cargoUnchanged) {
            log.warn("jettison verify failed — cargo unchanged", {
              agent: agentName,
              cargo_used_before: cargoUsedBefore,
              cargo_used_after: cargoUsedAfter,
            });
            if (resultObj) (resultObj as any)._verify_warning =
              "Verification failed: cargo unchanged after jettison. The item may not be in cargo, " +
              "may be a quest item (cannot be jettisoned), or you may not be docked. " +
              "Call get_status to verify cargo contents, then try a different item.";
          } else {
            log.info("jettison verified — cargo reduced", {
              agent: agentName,
              cargo_used_before: cargoUsedBefore,
              cargo_used_after: cargoUsedAfter,
            });
          }
        }
      }

      // install_mod verification: call get_ship after tick to confirm module appeared in loadout
      if (v1ToolName === "install_mod" && resultObj && typeof resultObj === "object") {
        const isError = "error" in (resultObj as any) || (resultObj as any).status === "error";
        if (!isError) {
          const installedId = (payload?.item_id ?? payload?.module_id ?? payload?.id) as string | undefined;
          log.info("[proxy] install_mod", { agent: agentName, module_id: installedId });
          try {
            const shipResp = await executeForClient(client, "get_ship", {});
            if (shipResp?.result) {
              const modules = (shipResp.result as any)?.modules as Array<Record<string, unknown>> | undefined;
              if (modules && Array.isArray(modules)) {
                // Merge verified ship data into result so agent sees confirmed loadout
                (resultObj as any).modules = modules;
                (resultObj as any).hint = "Module installed and verified. Current loadout included in response.";
                log.info("install_mod verified via get_ship", { agent: agentName, moduleCount: modules.length });
              }
            }
          } catch (err) {
            log.warn("install_mod get_ship verification failed", { agent: agentName, error: (err as Error).message });
          }
        }
      }


      // Dock verification: game server sometimes returns "dock completed" without
      // actually docking (observed at sirius_station, lacaille_belt_1).
      // Verify docked_at_base is set after a successful dock; retry once if not.
      if (v1ToolName === "dock") {
        const dockGameResponse = resultObj; // capture what the game actually returned
        const updated = await waitForDockCacheUpdate(client, agentName);
        if (updated) {
          const cachedOk = statusCache.get(agentName);
          const playerOk = cachedOk?.data?.player as Record<string, unknown> | undefined;
          log.debug("dock verified", {
            agent: agentName,
            docked_at_base: String(playerOk?.docked_at_base),
            poi: String(playerOk?.current_poi),
          });
          const poiIdOk = String(playerOk?.current_poi ?? "");
          if (poiIdOk) {
            markDockable(poiIdOk, true, {
              name: poiIdOk,
              system: String(playerOk?.current_system ?? ""),
              type: "station",
            });
          }
        }
        if (!updated) {
          const cachedAfterDock = statusCache.get(agentName);
          const playerAfterDock = cachedAfterDock?.data?.player as Record<string, unknown> | undefined;
          log.warn("dock completed but docked_at_base is null — retrying", {
            agent: agentName,
            poi: String(playerAfterDock?.current_poi),
            system: String(playerAfterDock?.current_system),
            game_response: JSON.stringify(dockGameResponse).slice(0, 500),
            cache_player_keys: playerAfterDock ? Object.keys(playerAfterDock).join(",") : "null",
            cache_age_ms: cachedAfterDock ? Date.now() - cachedAfterDock.fetchedAt : -1,
          });
          // Retry dock once
          const retryResp = await executeForClient(client, "dock", undefined);
          if (!retryResp.error) {
            await waitForDockCacheUpdate(client, agentName);
          }
          // Check again
          const cachedRetry = statusCache.get(agentName);
          const playerRetry = cachedRetry?.data?.player as Record<string, unknown> | undefined;
          if (!playerRetry?.docked_at_base) {
            log.error("dock failed after retry — POI may not have a dockable base", {
              agent: agentName,
              poi: String(playerRetry?.current_poi),
              system: String(playerRetry?.current_system),
              retry_response: JSON.stringify(retryResp).slice(0, 500),
              cache_age_ms: cachedRetry ? Date.now() - cachedRetry.fetchedAt : -1,
            });
            completeLog(pendingId, agentName, action,
              { error: "dock_failed", message: "Dock returned 'completed' but you are NOT docked. This POI may not have a dockable base. Try a different station." },
              elapsed, { success: false, errorCode: "dock_verification_failed" });
            const poiIdFail = String(playerRetry?.current_poi ?? "");
            if (poiIdFail) {
              recordDockFailure(poiIdFail, {
                name: poiIdFail,
                system: String(playerRetry?.current_system ?? ""),
              });
            }
            const poiName = String(playerRetry?.current_poi ?? "unknown");
            const isLikelyNonDockable = isDockable(poiName) === false ||
              /belt|sun|cloud|field|asteroid|vents|nebula|secundus|tollkeeper|shelf|reef|cluster|ring|deposit|harvesters|mineral|gas_pocket|_star$|^saturn$|_drift|comet|remnant|red_maw|_i+$|_world$|sentinel|cryobelt/.test(poiName);
            const systemName = playerRetry?.current_system ? String(playerRetry.current_system) : undefined;
            const systemClause = systemName
              ? `Use get_system for "${systemName}" to find dockable stations, then travel_to that station.`
              : "Use get_system to find stations with bases, then travel_to that station.";
            const hint = isLikelyNonDockable
              ? ` "${poiName}" is NOT a station — it is a celestial body or resource site. You CANNOT dock here. Stop retrying. ${systemClause}`
              : ` "${poiName}" does not have a dockable base. Do NOT retry docking here — it will never work. ${systemClause}`;
            return await withInjections(agentName, textResult({
              status: "error",
              error: "dock_verification_failed",
              message: `Dock returned 'completed' but you are NOT docked.${hint}`,
              system: playerRetry?.current_system,
              poi: playerRetry?.current_poi,
            }));
          }
        }
      }
      // Game bug: commission_ship charges credits but returns status=completed, then commission_status returns none.
      // Auto-verify commission_status and error if mismatch (prevents silent credit loss).
      if (v1ToolName === "commission_ship") {
        const commissionResp = await executeForClient(client, "commission_status", {});
        if (!commissionResp.error && typeof commissionResp.result === "object" && commissionResp.result !== null) {
          const commissionResult = commissionResp.result as Record<string, unknown>;
          if (commissionResult.status === "none") {
            log.error("commission_ship status mismatch", {
              agent: agentName,
              commission_response: JSON.stringify(resultObj).slice(0, 200),
              status_check: "none",
            });
            // Return error to agent instead of hiding the bug
            completeLog(pendingId, agentName, action,
              { error: "commission_failed", message: "Ship commission status is 'none'. Credits may have been charged without queuing ship. Contact operator." },
              elapsed);
            return await withInjections(agentName, textResult({
              status: "error",
              error: "commission_failed",
              message: "Ship commission failed: status returned 'none' (likely a game bug). Credits may have been charged but ship not queued. Contact operator immediately.",
              raw_response: resultObj,
              verification_status: commissionResult
            }));
          }
        }
      }
    }
  }
  return null;
}

// --- 3b. reload missing_ammo diagnostic injection ---
// The game's reload action is currently broken fleet-wide: it returns
// missing_ammo regardless of what's in cargo. Before handing the error
// to agents, we attach a get_cargo summary and the standing weapon's ammo
// state so they stop spinning through the 3-param-shape retry loop.
export async function handleReloadMissingAmmo(
  ctx: PassthroughExecContext,
  resp: ClientResp,
): Promise<McpTextResult | null> {
  const { agentName, action, v1ToolName, client, deps, pendingId, completeLog, elapsed } = ctx;
  const { statusCache, withInjections } = deps;

  if (resp.error && v1ToolName === "reload") {
    const reloadCode = String((resp.error as Record<string, unknown>).code ?? "");
    if (reloadCode === "missing_ammo") {
      const cached = statusCache.get(agentName);
      const ship = cached?.data?.ship as Record<string, unknown> | undefined;
      const cargo = ship?.cargo as Array<Record<string, unknown>> | undefined;
      const cargoUsed = ship?.cargo_used as number | undefined;
      const cargoCapacity = ship?.cargo_capacity as number | undefined;

      // Pull weapon ammo state from cached modules or weapons
      const isV2Client = typeof client.isV2 === "function" && client.isV2();
      let weaponAmmoState: Record<string, unknown> | null = null;
      if (isV2Client) {
        const modules = ship?.modules as Array<Record<string, unknown>> | undefined;
        const weaponMod = modules?.find((m) => String(m.slot ?? "").toLowerCase().includes("weapon"));
        if (weaponMod) {
          weaponAmmoState = {
            weapon_id: weaponMod.id,
            weapon_slot: weaponMod.slot,
            ammo_loaded: weaponMod.ammo_loaded ?? weaponMod.ammo ?? weaponMod.charges ?? null,
            ammo_item_id: weaponMod.ammo_item_id ?? weaponMod.ammo_type ?? null,
          };
        }
      } else {
        const weapons = ship?.weapons as Array<Record<string, unknown>> | undefined;
        const firstWeapon = weapons?.[0];
        if (firstWeapon) {
          weaponAmmoState = {
            weapon_instance_id: firstWeapon.instance_id ?? firstWeapon.id,
            ammo_loaded: firstWeapon.ammo_loaded ?? firstWeapon.ammo ?? firstWeapon.charges ?? null,
            ammo_item_id: firstWeapon.ammo_item_id ?? firstWeapon.ammo_type ?? null,
          };
        }
      }

      // Summarize cargo ammo candidates (items whose id or name contains "ammo" or "charge")
      const ammoInCargo = cargo?.filter((c) => {
        const id = String(c.item_id ?? c.id ?? "").toLowerCase();
        const name = String(c.name ?? "").toLowerCase();
        return id.includes("ammo") || id.includes("charge") || id.includes("shell") ||
               name.includes("ammo") || name.includes("charge") || name.includes("shell");
      }) ?? [];

      const reloadErrorMsg = `[missing_ammo] reload returned missing_ammo (known fleet-wide game bug — not a param error). ` +
        `Stop retrying with different param shapes. ` +
        `Diagnosis: cargo_used=${cargoUsed ?? "?"}, cargo_capacity=${cargoCapacity ?? "?"}, ` +
        `ammo_candidates_in_cargo=${JSON.stringify(ammoInCargo.map(c => ({ id: c.item_id ?? c.id, qty: c.quantity })))}` +
        (weaponAmmoState ? `, weapon_state=${JSON.stringify(weaponAmmoState)}` : "") +
        `. If ammo is present in cargo and weapon still misfires, this is a server-side bug — skip reload for now.`;

      completeLog(pendingId, agentName, action, reloadErrorMsg, elapsed, { success: false, errorCode: "missing_ammo" });
      return await withInjections(agentName, textResult({ error: reloadErrorMsg }));
    }
  }
  return null;
}

// --- 3c. Nav error-code mapping (v0.341.1 / v0.345.1) ---
// Map the game's new nav error codes to clean, actionable results for jump/travel
// instead of passing the raw error through. NOTE: the game's `in_transit` ERROR
// code here is distinct from the proxy's OWN internal `in_transit` status flag
// (transit-throttle.ts / cached-queries.ts) — this only handles the error code.
export async function handleNavErrorMapping(
  ctx: PassthroughExecContext,
  resp: ClientResp,
): Promise<McpTextResult | null> {
  const { agentName, action, v1ToolName, deps, pendingId, completeLog, elapsed } = ctx;
  const { withInjections } = deps;

  if (resp.error && (v1ToolName === "jump" || v1ToolName === "travel" || v1ToolName === "jump_route")) {
    const navCode = String((resp.error as Record<string, unknown>).code ?? "");
    const navMsg = String((resp.error as Record<string, unknown>).message ?? "");
    const lower = navMsg.toLowerCase();

    if (navCode === "fleet_moved" || lower.includes("fleet_moved")) {
      log.info("nav fleet_moved — leader moved during pending command", { agent: agentName, tool: v1ToolName });
      const mapped = {
        status: "error",
        error: "fleet_moved",
        message:
          "Your fleet leader jumped/traveled while this command was pending, so it was cancelled. " +
          "Call get_status to re-query your current position, then retry.",
      };
      completeLog(pendingId, agentName, action, mapped, elapsed, { success: false, errorCode: "fleet_moved" });
      return await withInjections(agentName, textResult(mapped));
    }

    if (navCode === "in_transit" || /\bin[_ ]transit\b/.test(lower)) {
      log.info("nav in_transit error — command sent mid-jump", { agent: agentName, tool: v1ToolName });
      const mapped = {
        status: "error",
        error: "in_transit",
        message:
          "Your ship is still moving (in transit), so this command was rejected. " +
          "Call get_status in 30-60 seconds to confirm arrival, then retry. " +
          "Do NOT call logout/login — the ship will arrive naturally.",
      };
      completeLog(pendingId, agentName, action, mapped, elapsed, { success: false, errorCode: "in_transit" });
      return await withInjections(agentName, textResult(mapped));
    }

    if (v1ToolName === "travel" && (navCode === "wrong_system" || lower.includes("wrong_system"))) {
      // The travel_to compound tool auto-jumps + retries on wrong_system. The raw
      // travel passthrough can't drive a multi-step route, so return a clean,
      // actionable message that names the destination system (v0.345.1 includes it).
      log.info("nav wrong_system on direct travel", { agent: agentName, tool: v1ToolName, detail: navMsg.slice(0, 120) });
      const mapped = {
        status: "error",
        error: "wrong_system",
        message:
          `That POI is in a different system. ${navMsg} ` +
          "jump (or jump_route) to that system first, then travel to the POI — " +
          "or use travel_to, which auto-routes across systems.",
      };
      completeLog(pendingId, agentName, action, mapped, elapsed, { success: false, errorCode: "wrong_system" });
      return await withInjections(agentName, textResult(mapped));
    }
  }
  return null;
}

// --- 4. Error path ---
export async function handleErrorPath(
  ctx: PassthroughExecContext,
  resp: ClientResp,
): Promise<McpTextResult | null> {
  const { agentName, action, deps, pendingId, completeLog, elapsed } = ctx;
  const { statusCache, withInjections } = deps;

  if (resp.error) {
    const code = (resp.error as Record<string, unknown>).code ?? "error";
    const message = (resp.error as Record<string, unknown>).message ?? String(resp.error);

    // Extract context from statusCache for context-aware hints
    const context: HintContext | undefined = (() => {
      const cached = statusCache.get(agentName);
      if (!cached) return undefined;

      const data = cached.data as Record<string, unknown>;
      const player = data.player as Record<string, unknown> | undefined;
      const ship = data.ship as Record<string, unknown> | undefined;

      return {
        docked: player?.docked_at_base !== undefined && player.docked_at_base !== null,
        currentPoi: player?.current_poi as string | undefined,
        cargoUsed: ship?.cargo_used as number | undefined,
        cargoCapacity: ship?.cargo_capacity as number | undefined,
        credits: player?.credits as number | undefined,
        fuel: ship?.fuel as number | undefined,
      };
    })();

    const errorMsg = addErrorHint(`[${code}] ${message}`, context);
    completeLog(pendingId, agentName, action, errorMsg, elapsed, { success: false, errorCode: String(code) });
    // Surface nav-cache staleness to the agent. The flag is set on resp.error
    // by the post-timeout refresh path above when the cache could not be
    // refreshed successfully — agents should call get_status before retrying.
    const navCacheStale = (resp.error as Record<string, unknown> | null | undefined)?._nav_cache_stale === true;
    const errorPayload: Record<string, unknown> = { error: errorMsg };
    if (navCacheStale) errorPayload._nav_cache_stale = true;
    return await withInjections(agentName, textResult(errorPayload));
  }
  return null;
}

// --- 5. Success path ---
// Terminal phase: normalizes the result, runs every per-tool success handler,
// and always returns an McpTextResult (possibly a short-circuit error).
export async function handleSuccessPath(
  ctx: PassthroughExecContext,
  resp: ClientResp,
): Promise<McpTextResult> {
  const {
    agentName, action, v1ToolName, payload, isNavTool, client, deps,
    pendingId, completeLog, elapsed, navBefore, poiWarning,
  } = ctx;
  const { statusCache, marketCache, stateChangingTools, decontaminateLog, withInjections } = deps;
  const { navBeforeStation } = navBefore;

  // Normalize result — game sometimes returns empty string or other non-object values
  // for state-changing tools. Fall back to the full response to preserve any data.
  let result: unknown = (resp.result !== undefined && resp.result !== null && resp.result !== "")
    ? resp.result
    : (resp.result === "" ? { status: "ok", _raw_empty: true } : resp);

  // Cache POI data from get_system responses for travel_to name resolution
  if (v1ToolName === "get_system") cacheSystemPois(result);

  // Enrich get_location and get_status responses with threat summary when ships are present
  if (v1ToolName === "get_location" || v1ToolName === "get_status") {
    try {
      enrichWithThreatAssessment(result);
    } catch {
      // non-fatal
    }
  }

  // Auto-record POI lore from get_poi responses
  if (v1ToolName === "get_poi" && result && typeof result === "object") {
    try {
      const r = result as Record<string, unknown>;
      const poiName = (r.id ?? r.poi_id ?? payload?.poi_id) as string | undefined;
      const system = (r.system as string | undefined)
        ?? (statusCache.get(agentName)?.data?.player as Record<string, unknown> | undefined)?.current_system as string | undefined;
      if (poiName && system) {
        autoRecordLoreFromResult(system, poiName, agentName, result);
      }
    } catch {
      // non-fatal
    }
  }

  // Inject known POI lore when navigating to a destination
  if ((v1ToolName === "travel" || v1ToolName === "dock") && result && typeof result === "object") {
    try {
      const cachedAfterNav = statusCache.get(agentName);
      const playerAfterNav = cachedAfterNav?.data?.player as Record<string, unknown> | undefined;
      const currentSystem = playerAfterNav?.current_system as string | undefined;
      const currentPoi = playerAfterNav?.current_poi as string | undefined;
      if (currentSystem && currentPoi) {
        const loreHint = buildLoreHint(currentSystem, currentPoi);
        if (loreHint && typeof result === "object") {
          (result as Record<string, unknown>)._poi_lore = loreHint;
        }
      }
    } catch {
      // non-fatal
    }
  }

  // Decontaminate captain's log entries to break the delusion cycle
  // and sync to local database
  if (v1ToolName === "captains_log_list") {
    result = decontaminateLog(result);
    try {
      const entries = (result as Record<string, unknown>)?.entries;
      if (Array.isArray(entries)) {
        syncCaptainsLogsFromServer(agentName, entries as Array<{
          id: string;
          entry: string;
          created_at: string;
        }>);
      }
    } catch (err) {
      log.warn("Failed to sync captain's logs to DB", {
        agent: agentName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Validate and mirror captains_log_add to local Gantry diary DB.
  // Game tool name varies: agents use `content=` (current v2), older code used `entry=`.
  // Accept both — `content` is authoritative when both are present.
  if (v1ToolName === "captains_log_add") {
    const payloadObj = payload as Record<string, unknown> | undefined;
    const entry = (payloadObj?.content ?? payloadObj?.entry) as unknown;
    if (typeof entry === "string" && entry.trim()) {
      // Validate captain's log format
      const validation = validateCaptainsLogFormat(entry);
      if (!validation.valid) {
        log.warn("captain's log format validation failed", {
          agent: agentName,
          error: validation.error,
          entry_preview: entry.slice(0, 100),
        });
        // Return error to agent instead of accepting the malformed entry
        completeLog(pendingId, agentName, action,
          { error: "invalid_log_format", message: validation.error },
          elapsed);
        return await withInjections(agentName, textResult({
          status: "error",
          error: "invalid_log_format",
          message: `Captain's log format error: ${validation.error} Please write EXACTLY 4 lines in format: LOC / CR / DID / NEXT.`,
        }));
      }

      try {
        addDiaryEntry(agentName, entry);
        log.debug("mirrored captains_log_add to local agent_diary (format valid)", {
          agent: agentName,
          entry_length: String(entry.length),
        });
      } catch (err) {
        log.warn("Failed to mirror diary entry to local DB", { agentName, err: String(err) });
      }

      // Also persist to captain's logs table if this was a successful add.
      // Game-server returns either a string ("Captain's log entry #N added.")
      // or, hypothetically, a structured {status, log_id} envelope. Handle both —
      // the string-only path was previously unhandled and silently dropped 100% of entries.
      let persistLogId: string | undefined;
      let persistSeq: number | undefined;
      if (typeof result === "string") {
        const m = result.match(/Captain's log entry #(\d+) added/);
        if (m) {
          persistLogId = m[1];
          persistSeq = Number(m[1]);
        }
      } else if (typeof result === "object" && result !== null) {
        const resultObj = result as Record<string, unknown>;
        if (resultObj.status === "ok" && resultObj.log_id) {
          persistLogId = String(resultObj.log_id);
        }
      }
      if (persistLogId !== undefined) {
        try {
          persistCaptainsLogEntry(agentName, entry, persistLogId, persistSeq);
          log.debug("persisted captain's log entry to captains_logs table", {
            agent: agentName,
            log_id: persistLogId,
          });
        } catch (err) {
          log.warn("Failed to persist captain's log to DB", {
            agent: agentName,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  // Proactively log economic actions (buy/sell/trade) to agent_action_log
  const ECONOMIC_ACTIONS = new Set(["buy", "sell", "purchase", "multi_sell", "create_sell_order", "create_buy_order"]);
  if (ECONOMIC_ACTIONS.has(v1ToolName) && !resp.error && result) {
    try {
      const data = typeof result === "object" ? result as Record<string, unknown> : {};
      const entry: import("../services/action-log-parser.js").ActionLogEntry = {
        agent: agentName,
        actionType: v1ToolName,
        item: (data.item_name ?? data.item ?? data.good ?? payload?.id ?? payload?.item_id) as string | undefined,
        quantity: (data.quantity ?? data.amount ?? payload?.count) as number | undefined,
        creditsDelta: (data.credits_delta ?? data.total_price ?? data.total_credits ?? data.total_cost ?? data.credits ?? data.total) as number | undefined,
        station: (data.station ?? data.location) as string | undefined,
        system: (data.system) as string | undefined,
        rawData: JSON.stringify(result).slice(0, 500),
      };
      // Make sell amounts negative
      if ((v1ToolName === "sell" || v1ToolName === "multi_sell" || v1ToolName === "create_sell_order") && entry.creditsDelta && entry.creditsDelta > 0) {
        // creditsDelta for sells is positive (earned), keep as-is
      } else if (v1ToolName.includes("buy") && entry.creditsDelta && entry.creditsDelta > 0) {
        entry.creditsDelta = -entry.creditsDelta;
      }
      persistActionLogEntries([entry]);
    } catch {
      // Non-fatal
    }
  }

  // Passively sync action log entries when agents call get_action_log
  if (v1ToolName === "get_action_log" && !resp.error) {
    try {
      const rawText =
        typeof result === "string"
          ? result
          : JSON.stringify(result);
      syncActionLog(agentName, rawText);
    } catch (err) {
      log.warn("Failed to sync action log", {
        agent: agentName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Summarize result to reduce token usage
  const summarized = summarizeToolResult(v1ToolName, result);

  // Enrich analyze_market with global market context and store timestamp in statusCache
  if (v1ToolName === "analyze_market") {
    try {
      const cached = statusCache.get(agentName);
      if (cached?.data) {
        // Store timestamp of last market analysis for prerequisite enforcement
        // (multi_sell needs this to allow selling across session resets)
        (cached.data as any)._last_market_analysis_at = Date.now();
        statusCache.set(agentName, { data: cached.data, fetchedAt: cached.fetchedAt });
      }

      const playerData = cached?.data?.player as Record<string, unknown> | undefined;
      const currentStation = playerData?.current_poi as string | undefined;
      const shipData = cached?.data?.ship as Record<string, unknown> | undefined;
      const cargoArray = shipData?.cargo as Array<{ item_id: string; quantity: number }> | undefined;

      if (currentStation && cargoArray && cargoArray.length > 0) {
        const mktResult = marketCache.get();
        if (mktResult.data && !mktResult.stale) {
          const localBids = extractLocalBids(result);
          const context = enrichWithGlobalContext(cargoArray, localBids, mktResult.data, currentStation);
          if (context && typeof summarized === "object" && summarized !== null) {
            (summarized as Record<string, unknown>).global_market_context = context;
          }
        }
      }
    } catch (err) {
      log.warn("analyze_market enrichment failed", {
        agent: agentName,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Capture STATION-level market opportunities. analyze_market "opportunity"
    // rows name a concrete station + buy/sell-order prices in their insight text
    // (e.g. "X has buy orders at <station>: ~N at ~Pcr"), which the faction-global
    // market cache cannot express. Persist them so getStationsForItem can answer
    // "where can I sell/buy X?". Non-fatal — never break the tool call.
    try {
      // Only the string TSV form carries the per-station "opportunity" insights.
      // An object-form result can never JSON.stringify into a parseable TSV (tabs
      // get escaped), so pass "" rather than stringifying — object-form market
      // data is handled by the other analyze_market consumers above.
      const mktText = typeof result === "string" ? result : "";
      const opportunities = parseMarketInsights(mktText);
      for (const op of opportunities) {
        recordStationObservation({
          item_id: op.item_id,
          station: op.station,
          price: op.best_price,
          type: op.type,
        });
      }
      if (opportunities.length > 0) {
        log.debug("recorded station market observations", { agent: agentName, count: opportunities.length });
      }
    } catch (err) {
      log.debug("station observation capture failed (non-fatal)", { error: String(err) });
    }
  }

  // --- market cache store (analyze_market only) ---
  // view_market is item_id-filtered and unsafe to cache by system:station alone.
  if (v1ToolName === "analyze_market" && deps.analyzeMarketCache) {
    try {
      const cacheStatus = statusCache.get(agentName);
      const cachePlayer = cacheStatus?.data?.player as Record<string, unknown> | undefined;
      const cacheSystem = cachePlayer?.current_system as string | undefined;
      const cacheStation = cachePlayer?.current_poi as string | undefined;
      if (cacheSystem && cacheStation) {
        deps.analyzeMarketCache.set(cacheSystem, cacheStation, JSON.stringify(summarized), agentName, "analyze_market");
      }
    } catch (err) {
      log.warn(`${v1ToolName} cache store failed (non-fatal)`, {
        agent: agentName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // --- Resource knowledge recording ---
  // After analyze_market or view_market, record resource sightings for cross-agent knowledge.
  if ((v1ToolName === "analyze_market" || v1ToolName === "view_market") && deps.resourceKnowledge) {
    try {
      const rkStatus = statusCache.get(agentName);
      const rkPlayer = rkStatus?.data?.player as Record<string, unknown> | undefined;
      const rkSystem = rkPlayer?.current_system as string | undefined;
      const rkStation = rkPlayer?.current_poi as string | undefined;
      if (rkSystem) {
        recordMarketResources(deps.resourceKnowledge, rkSystem, rkStation ?? null, result, agentName);
      }
    } catch {
      // non-fatal
    }
  }

  // --- Cache invalidation on trade actions ---
  // After buy/sell/create_*_order/multi_sell at this station, evict both market caches.
  if (CACHE_INVALIDATING_TOOLS.has(v1ToolName) && deps.analyzeMarketCache) {
    try {
      const cacheStatus = statusCache.get(agentName);
      const cachePlayer = cacheStatus?.data?.player as Record<string, unknown> | undefined;
      const cacheSystem = cachePlayer?.current_system as string | undefined;
      const cacheStation = cachePlayer?.current_poi as string | undefined;
      if (cacheSystem && cacheStation) {
        deps.analyzeMarketCache.invalidate(cacheSystem, cacheStation, v1ToolName);
      }
    } catch {
      // non-fatal
    }
  }

  // --- Market reservation annotations ---
  // Annotate analyze_market and view_market responses with reservation info so agents
  // see adjusted quantities and know what other agents have claimed.
  if ((v1ToolName === "analyze_market" || v1ToolName === "view_market") && deps.marketReservations && typeof summarized === "object" && summarized !== null) {
    try {
      const cached = statusCache.get(agentName);
      const playerData = cached?.data?.player as Record<string, unknown> | undefined;
      const currentStation = playerData?.current_poi as string | undefined;

      if (currentStation) {
        const reservations = deps.marketReservations;
        const annotateItems = (items: unknown[], getItemId: (item: Record<string, unknown>) => string | undefined) => {
          for (const item of items) {
            if (!item || typeof item !== "object") continue;
            const r = item as Record<string, unknown>;
            const itemId = getItemId(r);
            if (!itemId) continue;
            const hint = reservations.getReservationHint(currentStation, itemId, agentName);
            if (hint) {
              r._reservation = hint;
              const qty = typeof r.quantity === "number" ? r.quantity : undefined;
              if (qty !== undefined) {
                r._available = reservations.getAvailable(currentStation, itemId, qty, agentName);
              }
            }
          }
        };

        const sumObj = summarized as Record<string, unknown>;
        if (Array.isArray(sumObj.recommendations)) {
          annotateItems(sumObj.recommendations, (r) => r.item_id as string | undefined);
        }
        const listings = sumObj.listings ?? sumObj.orders ?? sumObj.items;
        if (Array.isArray(listings)) {
          annotateItems(listings, (l) => (l.item_id ?? l.id) as string | undefined);
        }
      }
    } catch (err) {
      log.warn("market reservation annotation failed", {
        agent: agentName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // --- Release station reservations on travel ---
  // When an agent starts moving, release reservations at their origin station.
  // Uses navBeforeStation captured BEFORE nav execution to avoid reading the already-updated cache.
  if (isNavTool && deps.marketReservations && navBeforeStation) {
    try {
      deps.marketReservations.releaseStation(agentName, navBeforeStation);
    } catch {
      // non-fatal
    }
  }

  // Buy with no recent market analysis — warn agent they may be buying at wrong price.
  // _last_market_analysis_at is set by the analyze_market success path.
  // Grace period: 5 minutes (market prices rarely change faster than that).
  if (v1ToolName === "buy" && typeof summarized === "object" && summarized !== null) {
    const MARKET_DATA_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes
    const cachedForBuy = statusCache.get(agentName);
    const lastAnalysisAt = (cachedForBuy?.data as any)?._last_market_analysis_at as number | undefined;
    const marketDataAge = lastAnalysisAt ? Date.now() - lastAnalysisAt : undefined;
    if (marketDataAge === undefined || marketDataAge > MARKET_DATA_MAX_AGE_MS) {
      const ageDesc = marketDataAge !== undefined
        ? `${Math.round(marketDataAge / 60000)} min old`
        : "unavailable";
      log.warn("buy without recent market analysis", {
        agent: agentName,
        last_analysis_at: lastAnalysisAt ?? "none",
        age_desc: ageDesc,
      });
      (summarized as Record<string, unknown>)._stale_market_warning =
        `Market data is ${ageDesc} — you may be buying at a stale price. ` +
        "Call analyze_market or view_market at this station before buying to get current prices.";
    }
  }

  // Buy with pending=true means no player sellers — tick silently drops the order.
  // Convert to explicit error to force agents to use create_buy_order() instead.
  if (v1ToolName === "buy" && typeof summarized === "object" && summarized !== null) {
    const buyResult = summarized as Record<string, unknown>;
    if (buyResult.pending === true) {
      completeLog(pendingId, agentName, action,
        { error: "no_sellers", message: "No player sellers available. Use create_buy_order() to place a waiting order." },
        elapsed);
      return await withInjections(agentName, textResult({
        status: "error",
        error: "no_sellers",
        message: "No player sellers available for this item. Use create_buy_order(item_id, price, quantity) to place a waiting order that fills when a player sells."
      }));
    }
    buyResult.hint =
      "Items purchased go to STATION STORAGE, not cargo. " +
      "Call withdraw_items(item_id) to move to cargo, then install_mod(id) to equip.";
  }

  // Buy returned "Bought 0 ... for 0cr." — upstream silently no-op'd the purchase.
  // Convert to an actionable error so agents don't spiral into bug-report mode.
  if (v1ToolName === "buy" && typeof summarized === "object" && summarized !== null) {
    const buyResult = summarized as Record<string, unknown>;
    const resultStr = typeof buyResult.result === "string" ? buyResult.result : "";
    if (/^Bought 0(\s|$).*for 0\s*cr/i.test(resultStr)) {
      const cached = statusCache.get(agentName);
      const cargo = (cached?.data as any)?.ship?.cargo as { used?: number; capacity?: number } | undefined;
      const credits = (cached?.data as any)?.player?.credits as number | undefined;
      const cargoFull = cargo?.used != null && cargo?.capacity != null && cargo.used >= cargo.capacity;
      const lowCredits = credits != null && credits < 100;

      const bullets: string[] = [];
      if (cargoFull) {
        bullets.push(`- Cargo full (${cargo!.used}/${cargo!.capacity}) → multi_sell, deposit_items, or jettison some items`);
      }
      bullets.push("- No sellers at this station for this item → travel_to a station with active listings (check analyze_market)");
      if (lowCredits) {
        bullets.push(`- Insufficient credits (${credits} cr) → earn more before retrying`);
      }
      bullets.push("- Quantity invalid (must be ≥ 1)");

      const recovery = cargoFull
        ? "1. Cargo full → multi_sell, deposit_items, or jettison some items\n2. Otherwise → call analyze_market to find a station with listings"
        : "1. Call analyze_market to find a station with active seller listings\n2. Call view_market(item_id) here to confirm sellers exist before retrying";

      const message =
        `buy() returned 0 — the upstream did not complete the purchase. Likely causes:\n` +
        bullets.join("\n") +
        `\n\nTo recover:\n${recovery}`;

      completeLog(pendingId, agentName, action,
        { error: "buy_no_op", message },
        elapsed);
      return await withInjections(agentName, textResult({
        status: "error",
        error: "buy_no_op",
        message,
      }));
    }
  }

  // --- Auto-reserve on buy/sell ---
  // When an agent buys or sells, create a reservation so other agents see reduced availability.
  // Placed AFTER the pending buy check so pending:true buys don't create false reservations.
  if ((v1ToolName === "buy" || v1ToolName === "sell" || v1ToolName === "create_sell_order" || v1ToolName === "create_buy_order") && deps.marketReservations && typeof summarized === "object" && summarized !== null) {
    try {
      const isError = "error" in (summarized as any) || (summarized as any).status === "error" || (summarized as any).status === "failed";
      if (!isError && payload) {
        const cached = statusCache.get(agentName);
        const playerData = cached?.data?.player as Record<string, unknown> | undefined;
        const currentStation = playerData?.current_poi as string | undefined;
        const itemId = payload.item_id as string | undefined;
        const quantity = typeof payload.quantity === "number" ? payload.quantity : 1;

        if (currentStation && itemId) {
          deps.marketReservations.reserve(agentName, currentStation, itemId, quantity);
        }
      }
    } catch (err) {
      log.warn("market auto-reservation failed", {
        agent: agentName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Craft: block until action_result arrives with the real outputs (up to 45s).
  // If eventBuffers is wired up, we wait for the async action_result event before
  // returning, so agents see the crafted items immediately in the response.
  // On timeout, fall back to the async hint so the agent knows to check cargo.
  // Note: craft may have already been handled in the pending path above; this block
  // handles the case where craft returned immediately (no pending flag) but outputs are empty.
  if (v1ToolName === "craft" && typeof summarized === "object" && summarized !== null) {
    const isError = "error" in summarized || (summarized as any).status === "error" || (summarized as any).status === "failed";
    const outputs = (summarized as Record<string, unknown>).outputs;

    if (!isError && (!outputs || (Array.isArray(outputs) && outputs.length === 0))) {
      const eventBuffer = deps.eventBuffers?.get(agentName);
      if (eventBuffer) {
        const craftOutputs = await waitForActionResult(eventBuffer, "craft", deps.craftResultTimeoutMs ?? 45_000);
        if (craftOutputs !== null) {
          (summarized as Record<string, unknown>).outputs = craftOutputs;
          (summarized as Record<string, unknown>).outputs_confirmed = true;
          (summarized as Record<string, unknown>).hint = "Crafted items are in your STATION STORAGE. Use withdraw_items(id) to move them to cargo.";
        } else {
          // timeout — fall back to async hint
          (summarized as Record<string, unknown>).hint =
            "Craft results arrive asynchronously. Check cargo with get_status to see crafted items.";
        }
      } else {
        (summarized as Record<string, unknown>).hint =
          "Craft results arrive asynchronously. Check cargo with get_status to see crafted items.";
      }
    }
  }

  if (v1ToolName === "deposit_items" && typeof summarized === "object" && summarized !== null) {
    // v0.367.0: deposit/withdraw accept an `items` array (up to 100 types) to move
    // many item types in one action. Both the scalar (item_id/quantity) and the
    // batched (items:[...]) forms pass through dispatch untouched; we only annotate
    // the count so the hint reads correctly for a bulk deposit.
    const depositedItems = payload?.items;
    const itemCount = Array.isArray(depositedItems) ? depositedItems.length : undefined;
    const countClause = itemCount && itemCount > 1 ? `${itemCount} item types ` : "Items ";
    (summarized as any).hint = `⚠️ ${countClause}deposited to STATION STORAGE — you earned 0 credits. Use multi_sell instead to earn credits. Deposits are almost never the right choice.`;
  }

  // install_mod: the game sometimes returns success immediately but fails asynchronously.
  // Add a hint so agents know to verify by calling get_ship to confirm the module is equipped.
  if (v1ToolName === "install_mod" && typeof summarized === "object" && summarized !== null) {
    const isInstallError = "error" in (summarized as any) || (summarized as any).status === "error" || (summarized as any).status === "failed";
    if (!isInstallError) {
      (summarized as any).hint =
        "Module install submitted. If you see an action_error shortly after, the item may not be in " +
        "station storage — use view_storage() to confirm it is there before installing. " +
        "Call get_ship to verify the module appears in your loadout.";
    }
  }

  // Merge module data from get_ship/install_mod/uninstall_mod into statusCache
  // state_update doesn't include modules, so the UI would always show empty loadout otherwise
  if (["get_ship", "install_mod", "uninstall_mod"].includes(v1ToolName)) {
    try {
      const shipResult = result as Record<string, unknown> | null;
      const modules = shipResult?.modules as Array<Record<string, unknown>> | undefined;
      if (modules && Array.isArray(modules)) {
        const cached = statusCache.get(agentName);
        if (cached?.data) {
          // Extract weapons from modules for combat readiness checks
          const weapons = modules.filter((m) => {
            const slot = String(m.slot_type ?? m.type ?? "").toLowerCase();
            return slot === "weapon" || slot.includes("weapon");
          });
          // Merge modules + weapons into ship sub-object and root
          const updatedData = {
            ...cached.data,
            modules,
            ship: {
              ...(cached.data.ship as Record<string, unknown> ?? {}),
              modules,
              weapons,
            },
          };
          statusCache.set(agentName, { data: updatedData, fetchedAt: cached.fetchedAt });
        }
      }
    } catch (err) {
      log.debug("module cache merge failed (non-fatal)", { error: String(err) });
    }
  }

  // Merge get_skills result into statusCache player.skills so the dashboard can display them.
  // get_skills is a static tool (no tick wait) but its result is never stored by the normal
  // get_status path — this intercepts the response and patches the cache.
  if (v1ToolName === "get_skills") {
    try {
      const skillsResult = result as Record<string, unknown> | null;
      const skills = skillsResult?.skills as Record<string, unknown> | undefined;
      if (skills && typeof skills === "object") {
        const cached = statusCache.get(agentName);
        if (cached?.data) {
          const updatedData = {
            ...cached.data,
            player: {
              ...(cached.data.player as Record<string, unknown> ?? {}),
              skills,
            },
          };
          statusCache.set(agentName, { data: updatedData, fetchedAt: cached.fetchedAt });
        }
      }
    } catch (err) {
      log.debug("skills cache merge failed (non-fatal)", { error: String(err) });
    }
  }

  // Update statusCache insurance field after buy_insurance / claim_insurance.
  // buy_insurance: set active=true so subsequent calls are short-circuited by pre-flight.
  // claim_insurance: clear active so the agent can buy again after a claim.
  if (v1ToolName === "buy_insurance" && !resp.error) {
    try {
      const cached = statusCache.get(agentName);
      if (cached?.data) {
        cached.data.insurance = { active: true, insured_at: Date.now() };
        statusCache.set(agentName, { data: cached.data, fetchedAt: cached.fetchedAt });
      }
    } catch (err) {
      log.debug("insurance cache update failed (non-fatal)", { error: String(err) });
    }
  }

  if (v1ToolName === "claim_insurance" && !resp.error) {
    try {
      const cached = statusCache.get(agentName);
      if (cached?.data) {
        cached.data.insurance = { active: false };
        statusCache.set(agentName, { data: cached.data, fetchedAt: cached.fetchedAt });
      }
    } catch (err) {
      log.debug("insurance cache clear failed (non-fatal)", { error: String(err) });
    }
  }

  // --- Storage cache wiring for PrayerLang STASHED/STASH predicates ---
  // view_storage / view_faction_storage results are merged into statusCache so
  // predicates.ts can evaluate STASHED(item) and STASH(poi, item) against real
  // game data. Without this, both predicates always returned 0.
  //
  // view_storage response shape: { station_id?: string, items: Array<{ item_id, quantity, ... }> }
  // view_faction_storage response shape: same shape but for faction storage.
  //   Assumption: view_faction_storage uses the same { items: [...] } envelope as
  //   view_storage (no summarizer exists; shape inferred from predicate test fixtures
  //   which expect { item_id, quantity, poi_id } records, and from schema-drift listing
  //   it alongside view_storage). Entries may include faction_id on the record.
  //
  // We replace records for the current POI only — records from other POIs
  // cached in earlier calls are preserved.
  if (v1ToolName === "view_storage" || v1ToolName === "view_faction_storage") {
    try {
      const cached = statusCache.get(agentName);
      if (cached?.data) {
        const playerData = cached.data.player as Record<string, unknown> | undefined;
        const currentPoi = playerData?.current_poi as string | undefined;

        const rawResult = result as Record<string, unknown> | null;
        // Items may be at top-level (array response) or under .items key
        const rawItems = Array.isArray(rawResult?.items)
          ? rawResult.items
          : Array.isArray(rawResult)
          ? rawResult
          : [];

        // Map API records to { item_id, quantity, poi_id } with poi_id from the
        // cache if not already present in the record.
        const newRecords = (rawItems as Array<Record<string, unknown>>)
          .filter((i) => !!i && typeof i === "object" && !Array.isArray(i))
          .map((i) => ({
            ...i,
            poi_id: (i.poi_id ?? i.poi ?? currentPoi ?? "") as string,
          }));

        const cacheKey = v1ToolName === "view_storage" ? "personal_storage" : "faction_storage";
        const existing = Array.isArray(cached.data[cacheKey])
          ? (cached.data[cacheKey] as Array<Record<string, unknown>>)
          : [];

        // Keep records for other POIs; replace records for currentPoi
        const retained = currentPoi
          ? existing.filter((r) => {
              const recPoi = String(r.poi_id ?? r.poi ?? r.station_id ?? r.location ?? "");
              return recPoi !== currentPoi;
            })
          : existing;

        cached.data[cacheKey] = [...retained, ...newRecords];
        statusCache.set(agentName, { data: cached.data, fetchedAt: cached.fetchedAt });
      }
    } catch (err) {
      log.warn(`${v1ToolName} storage cache merge failed`, {
        agent: agentName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Inject POI validation warning if the nav target was not recognised
  if (poiWarning && typeof summarized === "object" && summarized !== null) {
    (summarized as Record<string, unknown>)._poi_warning = poiWarning;
  }

  // --- Transit stuck detection ---
  // Track consecutive empty-location responses and inject escalating warnings.
  if (deps.transitStuckDetector && (v1ToolName === "get_location" || v1ToolName === "get_status")) {
    try {
      const { warning } = deps.transitStuckDetector.record(agentName, v1ToolName, result);
      if (warning && typeof summarized === "object" && summarized !== null) {
        (summarized as Record<string, unknown>)._transit_warning = warning;
      }
    } catch (err) {
      log.debug("transit stuck detector error (non-fatal)", { error: String(err) });
    }
  }

  completeLog(pendingId, agentName, action, summarized, elapsed);

  // For state-changing tools, wrap response to indicate completion
  // ONLY if the response doesn't already indicate an error or failure
  if (stateChangingTools.has(v1ToolName)) {
    const s = summarized as any;
    const isError = typeof s === "object" && s !== null && ("error" in s || s.status === "error" || s.status === "failed");
    if (!isError) {
      return await withInjections(agentName, textResult({ status: "completed", result: summarized }));
    }
  }

  return await withInjections(agentName, textResult(summarized));
}
