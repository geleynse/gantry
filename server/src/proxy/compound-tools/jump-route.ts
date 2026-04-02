/**
 * compound-tools/jump-route.ts
 *
 * Implementation of the jump_route compound tool.
 * Jumps sequentially through a list of system IDs, with auto-undock, refueling,
 * nav cache validation, and pirate combat detection.
 */

import { createLogger } from "../../lib/logger.js";
import type { CompoundToolDeps, CompoundResult } from "./types.js";
import { stripPendingFields, waitForNavCacheUpdate, normalizeSystemName } from "./utils.js";
import { getSessionShutdownManager } from "../session-shutdown.js";

const log = createLogger("compound-tools");

/**
 * Jump sequentially through a list of system IDs.
 * Auto-undocks and refuels if docked at start; refuels mid-route when fuel drops below threshold.
 * Waits for nav cache to update after each jump.
 */
export async function jumpRoute(
  deps: CompoundToolDeps,
  systemIds: string[],
  fuelThreshold = 20,
): Promise<CompoundResult> {
  const { client, agentName, statusCache } = deps;

  const clamped = systemIds.slice(0, 30);
  const jumps: Array<{ system: string; result: unknown }> = [];
  let stoppedReason: string | undefined;
  let stoppedDetail: Record<string, unknown> | undefined;
  const t0 = Date.now();

  // Step 1: Check status from cache — refuel and undock if docked at a station
  const cachedStatus = statusCache.get(agentName);
  const jumpPlayer = cachedStatus
    ? ((cachedStatus.data.player ?? cachedStatus.data) as Record<string, unknown>)
    : null;

  // Handle "home" destination
  let finalSystemIds = clamped;
  if (finalSystemIds.length === 1 && clamped[0].toLowerCase() === 'home') {
    const homeSystem = jumpPlayer?.home_system as string | undefined;
    if (homeSystem) {
      finalSystemIds = [homeSystem];
      log.info("jump_route: routing to home system", { agent: agentName, homeSystem });
    } else {
      return {
        status: "error",
        error: "home_not_set",
        message: "Agent has no home_system set. Set a home base first.",
        jumps_completed: 0,
      };
    }
  }

  log.info("jump_route START", {
    agent: agentName,
    systems_total: finalSystemIds.length,
    first_systems: finalSystemIds.slice(0, 5).join(","),
  });

  if (
    jumpPlayer?.current_poi &&
    typeof jumpPlayer.current_poi === "string" &&
    jumpPlayer.current_poi.includes("station")
  ) {
    // Likely docked — try to refuel and undock
    try {
      await client.execute("refuel", undefined, { timeoutMs: 30_000, noRetry: true });
    } catch {
      log.warn("jump_route: pre-jump refuel timed out, continuing", { agent: agentName });
    }
    const undockResp = await client.execute("undock", undefined, { noRetry: true });
    if (
      undockResp.error &&
      !String(undockResp.error).includes("already undocked")
    ) {
      return {
        status: "error",
        error: "failed_to_undock",
        detail: undockResp.error,
        jumps_completed: 0,
      };
    }
  }

  // Step 2: Jump sequentially
  let anyUnconfirmed = false;
  const shutdownManager = getSessionShutdownManager();

  for (let i = 0; i < finalSystemIds.length; i++) {
    // Check for shutdown signal before each hop
    if (shutdownManager.isShuttingDown(agentName)) {
      const completed = jumps.filter((j) => j.result === "ok").length;
      log.info("jump_route aborted due to shutdown signal", {
        agent: agentName,
        jump_num: i,
        total_jumps: finalSystemIds.length,
      });
      return {
        status: "error",
        error: "jump_route_aborted",
        reason: "shutdown_signal",
        jumps_completed: completed,
        total_jumps: finalSystemIds.length,
      };
    }

    const systemId = finalSystemIds[i];
    const tJumpStart = Date.now();

    // Check for pirate_combat event before each hop — abort if under attack
    if (deps.eventBuffers) {
      const buf = deps.eventBuffers.get(agentName);
      const hasPirateCombat = buf?.events?.some((e) => e.type === "pirate_combat") ?? false;
      if (hasPirateCombat) {
        const completed = jumps.filter((j) => j.result === "ok").length;
        log.warn("jump_route interrupted: pirate_combat detected", {
          agent: agentName,
          jump_num: i,
          total_jumps: finalSystemIds.length,
        });
        return {
          status: "error",
          error: "jump_route_interrupted",
          reason: "pirate_combat detected",
          jumps_completed: completed,
          total_jumps: finalSystemIds.length,
        };
      }
    }

    // Check fuel every 10 jumps (from cache, updated by state_update)
    if (i > 0 && i % 10 === 0) {
      const fuelCache = statusCache.get(agentName);
      const fuelShip = fuelCache
        ? ((fuelCache.data.ship ?? fuelCache.data) as Record<string, unknown>)
        : null;
      const fuel =
        typeof fuelShip?.fuel === "number" ? fuelShip.fuel : 999;
      if (fuel < fuelThreshold) {
        let dockResp: Awaited<ReturnType<typeof client.execute>>;
        try {
          dockResp = await client.execute("dock", undefined, { timeoutMs: 30_000, noRetry: true });
        } catch {
          log.warn("jump_route: mid-route dock timed out, skipping refuel", { agent: agentName, jump_num: i });
          dockResp = { error: "dock timed out" };
        }
        if (!dockResp.error) {
          try {
            await client.execute("refuel", undefined, { timeoutMs: 30_000, noRetry: true });
          } catch {
            log.warn("jump_route: mid-route refuel timed out", { agent: agentName, jump_num: i });
          }
          await client.execute("undock");
        }
      }
    }

    // Capture system BEFORE jump so we can detect cache change after
    const jumpBeforeCache = statusCache.get(agentName);
    const jumpBeforePlayer = jumpBeforeCache?.data?.player as
      | Record<string, unknown>
      | undefined;
    const jumpBeforeSystem = jumpBeforePlayer?.current_system;

    // Snapshot the current arrival tick BEFORE the jump. After execute() returns,
    // we pass this to waitForNavCacheUpdate so it can detect a NEW arrival_tick.
    // Important: do NOT clear lastArrivalTick — that causes a race where the
    // arrival signal arrives during execute() and is then missed by
    // waitForNextArrival because beforeTick=null matches the fast-return check.
    const arrivalTickBeforeJump = client.lastArrivalTick;

    let jumpResp = await client.execute("jump", {
      target_system: systemId,
    });

    // Retry on connection_lost — wait for reconnect instead of aborting the route
    if (jumpResp.error) {
      const errorCode =
        typeof jumpResp.error === "object" && jumpResp.error !== null
          ? (jumpResp.error as Record<string, unknown>).code
          : jumpResp.error;
      if (errorCode === "connection_lost" || errorCode === "connection_timeout") {
        log.info("jump_route: connection error, waiting for reconnect before retry", {
          agent: agentName,
          system: systemId,
          error: errorCode,
          jump_num: `${i + 1}/${finalSystemIds.length}`,
        });
        await new Promise((r) => setTimeout(r, 5_000));
        jumpResp = await client.execute("jump", { target_system: systemId });
      }
    }

    if (jumpResp.error) {
      jumps.push({ system: systemId, result: jumpResp.error });
      stoppedReason = `jump_failed at ${systemId}`;

      // Capture fuel and ship info from cache for richer error context
      const failCache = statusCache.get(agentName);
      const failShip = failCache
        ? ((failCache.data.ship ?? failCache.data) as Record<string, unknown>)
        : null;
      const failPlayer = failCache
        ? ((failCache.data.player ?? failCache.data) as Record<string, unknown>)
        : null;
      const fuelRemaining = typeof failShip?.fuel === "number" ? failShip.fuel : undefined;
      const fuelMax = typeof failShip?.fuel_capacity === "number" ? failShip.fuel_capacity : undefined;
      const completedSoFar = jumps.filter((j) => j.result === "ok").length;

      // Build a helpful hint based on fuel level
      let hint: string;
      if (fuelRemaining !== undefined && fuelMax !== undefined && fuelRemaining < fuelMax * 0.25) {
        hint = "Low fuel may have caused the failure. Refuel before retrying the remaining hops.";
      } else if (fuelRemaining !== undefined && fuelRemaining < 5) {
        hint = "Fuel is critically low. Dock and refuel before continuing.";
      } else {
        hint = "Try a shorter route or jump manually to the next system.";
      }

      // Extract game error detail if available
      const gameError = typeof jumpResp.error === "object" && jumpResp.error !== null
        ? jumpResp.error
        : { detail: String(jumpResp.error) };

      stoppedDetail = {
        game_error: gameError,
        current_system: failPlayer?.current_system ?? null,
        fuel_remaining: fuelRemaining ?? null,
        fuel_capacity: fuelMax ?? null,
        jumps_remaining: finalSystemIds.length - completedSoFar,
        hint,
      };

      log.warn("jump_route jump failed", {
        agent: agentName,
        jump_num: `${i + 1}/${finalSystemIds.length}`,
        system: systemId,
        fuel: fuelRemaining,
        elapsed_ms: Date.now() - tJumpStart,
      });
      break;
    }
    jumps.push({ system: systemId, result: "ok" });

    // Wait for state_update to confirm actual destination — do NOT guess/patch with systemId.
    // The server is authoritative; if the cache doesn't update, we stop and report.
    // Pass arrivalTickBeforeJump so waitForNavCacheUpdate can detect arrival signals
    // that arrived during execute() (race condition on multi-hop routes).
    const updated = await waitForNavCacheUpdate(
      client,
      agentName,
      jumpBeforeSystem,
      statusCache,
      undefined, // maxTicks — use default
      arrivalTickBeforeJump,
    );
    const tJumpEnd = Date.now();

    if (!updated) {
      // Cache didn't update — server hasn't confirmed arrival yet.
      // Do NOT patch with expected destination — that's where the scatter comes from.
      anyUnconfirmed = true;
      log.info("jump_route nav cache did not update after jump — server confirmation pending", {
        agent: agentName,
        jump_num: `${i + 1}/${finalSystemIds.length}`,
        target_system: systemId,
        elapsed_ms: tJumpEnd - tJumpStart,
      });
    }

    log.debug("jump_route jump completed", {
      agent: agentName,
      jump_num: `${i + 1}/${finalSystemIds.length}`,
      system: systemId,
      elapsed_ms: tJumpEnd - tJumpStart,
      cache_updated: updated,
    });

    // location_after mismatch check + strip pending fields
    if (jumpResp.result && typeof jumpResp.result === "object") {
      const jResult = jumpResp.result as Record<string, unknown>;
      const gameSystem = (jResult.system ?? jResult.current_system) as string | undefined;
      if (gameSystem) {
        const cacheAfterJump = statusCache.get(agentName);
        const cacheSystem = (cacheAfterJump?.data?.player as Record<string, unknown> | undefined)?.current_system as string | undefined;
        if (cacheSystem && normalizeSystemName(cacheSystem) !== normalizeSystemName(gameSystem)) {
          log.warn("location_after_mismatch", {
            agent: agentName,
            tool: "jump",
            jump_num: `${i + 1}/${finalSystemIds.length}`,
            target_system: systemId,
            game_response_system: gameSystem,
            cache_system: cacheSystem,
            warning: "jump_route cache may be stale — using patched system value",
          });
        }
      }
      stripPendingFields(jumpResp.result);
    }
  }

  // Step 3: Get final location from cache
  const finalCache = statusCache.get(agentName);
  const finalPlayer = finalCache
    ? ((finalCache.data.player ?? finalCache.data) as Record<string, unknown>)
    : null;
  const completed = jumps.filter((j) => j.result === "ok").length;

  log.info("jump_route DONE", {
    agent: agentName,
    elapsed_ms: Date.now() - t0,
    completed_jumps: `${completed}/${finalSystemIds.length}`,
    final_system: finalPlayer?.current_system,
    final_poi: finalPlayer?.current_poi,
    stopped_reason: stoppedReason,
  });

  return {
    status: stoppedReason ? "error" : "completed",
    jumps_completed: completed,
    jumps_total: finalSystemIds.length,
    ...(stoppedReason && {
      error: "jump_failed",
      message: stoppedReason,
      ...(stoppedDetail ?? {}),
    }),
    location_after: finalPlayer
      ? {
          system: finalPlayer.current_system,
          poi: finalPlayer.current_poi,
        }
      : null,
    ...(anyUnconfirmed ? { location_confirmed: false, location_warning: "One or more jump cache updates timed out. Call get_location to verify actual position." } : {}),
  };
}
