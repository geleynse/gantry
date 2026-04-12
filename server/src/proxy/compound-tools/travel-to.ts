/**
 * compound-tools/travel-to.ts
 *
 * Implementation of the travel_to compound tool.
 * Travels to a POI (and optionally docks), with cache settling and location validation.
 */

import { createLogger } from "../../lib/logger.js";
import type { CompoundToolDeps, CompoundResult } from "./types.js";
import { stripPendingFields, waitForNavCacheUpdate, normalizeSystemName } from "./utils.js";
import { systemPoiCache, cacheSystemPois } from "../poi-resolver.js";
import type { PoiEntry } from "../poi-resolver.js";

const log = createLogger("compound-tools");

/** Check whether a game error message indicates an invalid/unknown POI. */
function isInvalidPoiError(errMsg: string): boolean {
  const lower = errMsg.toLowerCase();
  return lower.includes("invalid_poi") || lower.includes("unknown destination") || lower.includes("invalid poi");
}

/**
 * Attempt fuzzy POI matching after a travel failure.
 *
 * On invalid_poi errors, checks the current system's POI cache for substring
 * matches against the agent's requested destination (case-insensitive).
 *
 * - Exactly one match → retries travel with the full POI ID and returns the response.
 * - Multiple matches → pushes a descriptive error step and returns null.
 * - No matches → returns null (caller uses original error).
 *
 * Fetches get_system first if the POI cache is empty for the current system.
 */
async function attemptFuzzyPoiRetry(
  client: CompoundToolDeps["client"],
  agentName: string,
  requestedDest: string,
  resolvedDest: string,
  playerBefore: Record<string, unknown> | undefined,
  statusCache: CompoundToolDeps["statusCache"],
  steps: Array<{ action: string; result: unknown }>,
  resolvePoiId: (agentName: string, name: string, statusCache: Map<string, { data: Record<string, unknown>; fetchedAt: number }>) => string,
): Promise<{ result?: unknown; error?: unknown } | null> {
  const currentSystem = playerBefore?.current_system as string | undefined;
  if (!currentSystem) return null;

  // Populate cache if needed
  if (!systemPoiCache.has(currentSystem)) {
    log.info("travel_to fuzzy: POI cache empty, fetching get_system", {
      agent: agentName,
      system: currentSystem,
      destination: requestedDest,
    });
    try {
      const sysResp = await client.execute("get_system", {});
      if (sysResp.result) {
        cacheSystemPois(sysResp.result);
      }
    } catch (e) {
      log.warn("travel_to fuzzy: failed to fetch get_system", { agent: agentName, error: String(e) });
    }
  }

  const pois = systemPoiCache.get(currentSystem);
  if (!pois || pois.length === 0) return null;

  // Substring match against POI IDs (case-insensitive)
  const needle = requestedDest.toLowerCase();
  const matches: PoiEntry[] = pois.filter(p => p.id.toLowerCase().includes(needle));

  if (matches.length === 1) {
    const fullId = matches[0].id;
    log.info(`travel_to fuzzy resolved: "${requestedDest}" → "${fullId}"`, {
      agent: agentName,
      requested: requestedDest,
      resolved: fullId,
      system: currentSystem,
    });
    const retryResp = await client.execute("travel", { target_poi: fullId });
    steps.push({ action: "travel_fuzzy_retry", result: retryResp.result ?? retryResp.error });
    return retryResp;
  }

  if (matches.length > 1) {
    const options = matches.map(p => p.id).join(", ");
    const msg = `Ambiguous destination "${requestedDest}" — multiple POIs match in ${currentSystem}: ${options}. Use a more specific ID.`;
    log.warn("travel_to fuzzy: ambiguous destination", {
      agent: agentName,
      requested: requestedDest,
      matches: matches.map(p => p.id),
      system: currentSystem,
    });
    steps.push({ action: "travel_fuzzy_error", result: msg });
    return null;
  }

  // No matches — fall through to original error
  log.warn("travel_to fuzzy: no POI match found", {
    agent: agentName,
    requested: requestedDest,
    system: currentSystem,
    poi_count: pois.length,
  });
  return null;
}

/**
 * Travel to a POI (and optionally dock). POI name is resolved to ID via resolvePoiId.
 * Waits two ticks after travel and two ticks after dock to let the cache settle.
 * Returns location_after from the cache.
 */
export async function travelTo(
  deps: CompoundToolDeps,
  destination: string,
  resolvePoiId: (agentName: string, name: string, statusCache: Map<string, { data: Record<string, unknown>; fetchedAt: number }>) => string,
  shouldDockOverride?: boolean,
): Promise<CompoundResult> {
  const { client, agentName, statusCache } = deps;
  const steps: Array<{ action: string; result: unknown }> = [];
  const t0 = Date.now();

  const cachedBefore = statusCache.get(agentName);
  const playerBefore = cachedBefore?.data?.player as Record<string, unknown> | undefined;

  // Handle "home" destination
  let finalDestination = destination;
  if (destination.toLowerCase() === 'home') {
    const homePoi = playerBefore?.home_poi as string | undefined;
    const homeSystem = playerBefore?.home_system as string | undefined;

    if (homePoi) {
      finalDestination = homePoi;
      log.info("travel_to: routing to home POI", { agent: agentName, homePoi, homeSystem });
    } else {
      return {
        status: "error",
        error: "home_not_set",
        message: "Agent has no home_poi set. Set a home base first.",
        steps,
      };
    }
  }

  log.info("travel_to START", {
    agent: agentName,
    destination: finalDestination,
    from_system: playerBefore?.current_system,
    from_poi: playerBefore?.current_poi,
    docked_at: playerBefore?.docked_at_base ?? "none",
  });

  // Resolve POI name to ID (e.g., "Sol Station" → "poi_0041_002")
  let resolvedDest = resolvePoiId(agentName, finalDestination, statusCache);

  // If the destination didn't resolve and doesn't look like a raw POI ID,
  // auto-fetch get_system to populate the POI cache, then retry resolution.
  // This handles the case where an agent calls travel_to without having called
  // get_system first — the cache would be empty and the name passes through
  // unresolved, causing the game to reject it.
  if (resolvedDest === finalDestination && !finalDestination.startsWith("poi_")) {
    const currentSystem = playerBefore?.current_system as string | undefined;
    if (currentSystem && !systemPoiCache.has(currentSystem)) {
      log.info("travel_to: POI cache empty, fetching get_system to populate", {
        agent: agentName,
        system: currentSystem,
        destination: finalDestination,
      });
      try {
        const sysResp = await client.execute("get_system", {});
        if (sysResp.result) {
          cacheSystemPois(sysResp.result);
          resolvedDest = resolvePoiId(agentName, finalDestination, statusCache);
        }
      } catch (e) {
        log.warn("travel_to: failed to auto-fetch get_system for POI resolution", {
          agent: agentName,
          error: String(e),
        });
      }
    }
  }

  if (resolvedDest !== finalDestination) {
    log.debug("POI name resolved", {
      agent: agentName,
      requested: finalDestination,
      resolved: resolvedDest,
    });
  }

  // Snapshot arrival tick before travel so waitForNavCacheUpdate can detect the signal
  const arrivalTickBeforeTravel = client.lastArrivalTick;
  const systemBefore = playerBefore?.current_system;

  // Travel to destination (server auto-undocks if needed)
  let travelResp = await client.execute("travel", { target_poi: resolvedDest });
  steps.push({ action: "travel", result: travelResp.result ?? travelResp.error });
  const tTravel = Date.now();
  if (travelResp.error) {
    const errMsg = typeof travelResp.error === "string"
      ? travelResp.error
      : ((travelResp.error as { message?: string })?.message ?? "unknown error");

    if (isInvalidPoiError(errMsg)) {
      // Attempt fuzzy POI resolution and retry once
      const fuzzyResp = await attemptFuzzyPoiRetry(
        client, agentName, finalDestination, resolvedDest, playerBefore, statusCache, steps, resolvePoiId,
      );
      if (fuzzyResp !== null) {
        // Got a retry response — check if it succeeded or failed on the new ID
        if (fuzzyResp.error) {
          log.warn("travel execute failed after fuzzy retry", { agent: agentName, elapsed_ms: Date.now() - t0 });
          const retryErrMsg = typeof fuzzyResp.error === "string"
            ? fuzzyResp.error
            : ((fuzzyResp.error as { message?: string })?.message ?? "unknown error");
          return {
            status: "error",
            error: "travel_failed",
            message: `Travel execution failed: ${retryErrMsg}`,
            steps,
          };
        }
        // Fuzzy retry succeeded — continue with the rest of travelTo using fuzzyResp
        travelResp = fuzzyResp;
      } else {
        // Ambiguous or no match — step already pushed with error detail
        log.warn("travel execute failed (invalid POI, fuzzy match failed)", { agent: agentName, elapsed_ms: Date.now() - t0 });
        const lastStep = steps[steps.length - 1];
        const detailMsg = typeof lastStep?.result === "string"
          ? lastStep.result
          : `Travel execution failed: ${errMsg}`;
        return {
          status: "error",
          error: "travel_failed",
          message: detailMsg,
          steps,
        };
      }
    } else {
      log.warn("travel execute failed", { agent: agentName, elapsed_ms: tTravel - t0 });
      return {
        status: "error",
        error: "travel_failed",
        message: `Travel execution failed: ${errMsg}`,
        steps,
      };
    }
  } else {
    log.debug("travel execute succeeded", { agent: agentName, elapsed_ms: tTravel - t0 });
  }

  // Check if the travel response indicates pending (hyperspace transit).
  // If pending, use waitForNavCacheUpdate to properly wait for arrival_tick.
  // If not pending (intra-system travel), two ticks is sufficient.
  const travelResult = travelResp.result as Record<string, unknown> | undefined;
  const isPending = travelResult?.pending === true || travelResult?.arrival_tick !== undefined;

  if (isPending && systemBefore) {
    // Inter-system or long travel — wait for arrival using arrival_tick signal
    const updated = await waitForNavCacheUpdate(
      client, agentName, systemBefore, statusCache, undefined, arrivalTickBeforeTravel,
    );
    log.debug("travel nav cache update", { agent: agentName, updated, elapsed_ms: Date.now() - tTravel });
  } else {
    // Intra-system travel — two ticks is enough
    await client.waitForTick();
    await client.waitForTick();
    log.debug("travel ticks waited", { agent: agentName, elapsed_ms: Date.now() - tTravel });
  }
  if (travelResp.result && typeof travelResp.result === "object") {
    const tResult = travelResp.result as Record<string, unknown>;
    stripPendingFields(travelResp.result);

    // location_after mismatch: compare game response system hint vs cache
    const gameSystem = (tResult.system ?? tResult.current_system) as string | undefined;
    if (gameSystem) {
      const cacheAfterTravel = statusCache.get(agentName);
      const cacheSystem = (cacheAfterTravel?.data?.player as Record<string, unknown> | undefined)?.current_system as string | undefined;
      if (cacheSystem && normalizeSystemName(cacheSystem) !== normalizeSystemName(gameSystem)) {
        log.warn("location_after_mismatch", {
          agent: agentName,
          tool: "travel",
          game_response_system: gameSystem,
          cache_system: cacheSystem,
          warning: "travel_to cache location_after may be stale — agent may navigate from wrong position",
        });
      }
    }
  }

  // Dock if should_dock is true, or if the destination looks like a station/core
  const doDock =
    shouldDockOverride ??
    (destination.includes("station") ||
      destination.includes("core") ||
      resolvedDest.includes("station") ||
      resolvedDest.includes("core"));

  if (doDock) {
    const tDockStart = Date.now();
    // dock uses a 30s timeout — game server can be slow under load.
    let dockResp: Awaited<ReturnType<typeof client.execute>>;
    try {
      dockResp = await client.execute("dock", undefined, { timeoutMs: 30_000, noRetry: true });
    } catch (err) {
      log.warn("dock timed out", { agent: agentName, destination, elapsed_ms: Date.now() - tDockStart });
      dockResp = { error: `dock timed out after 30s — game server may be slow. Try again.` };
    }
    steps.push({ action: "dock", result: dockResp.result ?? dockResp.error });
    const tDock = Date.now();
    if (dockResp.error) {
      log.warn("dock execute failed", { agent: agentName, elapsed_ms: tDock - tDockStart });
    } else {
      log.debug("dock execute succeeded", { agent: agentName, elapsed_ms: tDock - tDockStart });
    }

    if (!dockResp.error) {
      await client.waitForTick();
      const tDockTick1 = Date.now();
      await client.waitForTick();
      const tDockTick2 = Date.now();
      log.debug("dock ticks waited", {
        agent: agentName,
        tick1_ms: tDockTick1 - tDock,
        tick2_ms: tDockTick2 - tDockTick1,
        total_ms: tDockTick2 - t0,
      });
      if (dockResp.result && typeof dockResp.result === "object") {
        stripPendingFields(dockResp.result);
      }
    }
  }

  // Get final location from cache
  const cached = statusCache.get(agentName);
  const cPlayer = cached
    ? ((cached.data.player ?? cached.data) as Record<string, unknown>)
    : null;

  let dockedAtBase = cPlayer?.docked_at_base ?? null;
  // If dock appeared to succeed but docked_at_base is null, retry once
  let dockWarning: string | undefined;
  if (doDock && !dockedAtBase) {
    log.warn("travel_to dock completed but docked_at_base is null — retrying", {
      agent: agentName, destination, poi: cPlayer?.current_poi, system: cPlayer?.current_system,
    });
    let retryDock: Awaited<ReturnType<typeof client.execute>>;
    try {
      retryDock = await client.execute("dock", undefined, { timeoutMs: 30_000, noRetry: true });
    } catch {
      retryDock = { error: "dock retry timed out" };
    }
    if (!retryDock.error) {
      await client.waitForTick();
      await client.waitForTick();
    }
    const retryCache = statusCache.get(agentName);
    const retryPlayer = retryCache ? ((retryCache.data.player ?? retryCache.data) as Record<string, unknown>) : null;
    const retryDocked = retryPlayer?.docked_at_base ?? null;
    if (retryDocked) {
      log.info("travel_to dock retry succeeded", { agent: agentName, docked_at: retryDocked });
      dockedAtBase = retryDocked;
    } else {
      dockWarning = "ERROR: Dock returned 'completed' but you are NOT docked after retry. This POI may not support docking. Do NOT call get_missions() or analyze_market(). Travel to a different station.";
      log.error("travel_to dock failed after retry", {
        agent: agentName, destination, poi: retryPlayer?.current_poi, system: retryPlayer?.current_system,
      });
    }
  }

  const tTotal = Date.now() - t0;
  log.info("travel_to DONE", {
    agent: agentName,
    elapsed_ms: tTotal,
    destination,
    final_system: cPlayer?.current_system,
    final_poi: cPlayer?.current_poi,
    docked_at: dockedAtBase ?? "none",
    dock_warning: !!dockWarning,
  });

  return {
    status: "completed",
    steps,
    location_after: cPlayer
      ? {
          system: cPlayer.current_system,
          poi: cPlayer.current_poi,
          docked_at_base: dockedAtBase,
        }
      : null,
    ...(dockWarning ? { warning: dockWarning } : {}),
  };
}
