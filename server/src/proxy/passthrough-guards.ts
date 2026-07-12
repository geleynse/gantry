/**
 * Pre-flight guards for handlePassthrough.
 *
 * Extracted from passthrough-handler.ts. These run BEFORE the game call is
 * dispatched. Each guard returns an `McpTextResult` to short-circuit the
 * pipeline (the call never reaches the game server) or `null` to continue.
 *
 * ORDER IS LOAD-BEARING. The orchestrator invokes these in exactly the same
 * order the inline code used — cargo-full is checked before fuel-floor, nav
 * capture happens before the neighbor guard, etc. Do NOT reorder.
 *
 * captureNavBefore / computePoiWarning / autoUndockBeforeJump /
 * autoFillReloadWeaponId are not short-circuit guards — they capture shared
 * state or apply side effects — but they live here because they belong to the
 * same pre-flight phase.
 */

import {
  textResult,
  checkRefuelTargetGuard,
  executeForClient,
  type McpTextResult,
  type PassthroughContext,
  type NavBeforeState,
} from "./passthrough-handler.js";
import { logToolCallStart, logToolCallComplete } from "./tool-call-logger.js";
import { createLogger } from "../lib/logger.js";
import { checkFuelFloorGuard, checkCargoFullDockGuard } from "./fuel-floor-guard.js";
import { AnalyzeMarketCache } from "./analyze-market-cache.js";
import { isDockable, getPoi } from "../services/galaxy-poi-registry.js";

const log = createLogger("passthrough");

// --- 0. refuel(target=) guard ---
// Loud, structured rejection. Silently stripping `target` is what burned us:
// the game treats unknown params loosely and returned cryptic errors that agents
// misread as syntax variants and kept retrying (see proxy-todos.md 2026-05-04).
export async function checkRefuelGuard(ctx: PassthroughContext): Promise<McpTextResult | null> {
  const { agentName, action, v1ToolName, payload, traceId, opts, deps } = ctx;
  const { withInjections } = deps;
  const refuelGuard = checkRefuelTargetGuard(v1ToolName, payload);
  if (refuelGuard) {
    if (!opts?.skipLogging) {
      const guardId = logToolCallStart(agentName, action, payload, { traceId });
      logToolCallComplete(guardId, agentName, action, refuelGuard, 0, { success: false, errorCode: "refuel_target_unsupported" });
    }
    log.warn("refuel target= rejected by proxy guard", { agent: agentName, target: String(payload?.target) });
    return await withInjections(agentName, textResult(refuelGuard));
  }
  return null;
}

// --- 0a. Fuel-floor + cargo-full dock guards (anti-stranding) ---
// Structural block: an undocked, near-empty ship that jumps lands at the
// destination with no fuel to continue to a station — unrecoverable (see
// cinder-wake @ delta_major_star, 0/160, 2026-06-01). Likewise a full-cargo
// ship that keeps jumping burns fuel it cannot replace without selling.
// Both guards read the cached status, never block a docked / Pathfinder-Drive
// ship, and allow when the numbers are unknown (a false block strands too).
// Cargo-full is checked first: if the agent is BOTH full AND low on fuel,
// "dock and sell" is the more complete instruction (it also lets them refuel).
export async function checkStructuralNavGuards(ctx: PassthroughContext): Promise<McpTextResult | null> {
  const { agentName, action, v1ToolName, payload, traceId, opts, deps } = ctx;
  const { statusCache, withInjections } = deps;
  const guardCached = statusCache.get(agentName);
  const navGuard =
    checkCargoFullDockGuard(v1ToolName, guardCached) ??
    checkFuelFloorGuard(v1ToolName, guardCached);
  if (navGuard) {
    if (!opts?.skipLogging) {
      const guardId = logToolCallStart(agentName, action, payload, { traceId });
      logToolCallComplete(guardId, agentName, action, navGuard, 0, {
        success: false,
        errorCode: navGuard.error,
      });
    }
    return await withInjections(agentName, textResult(navGuard));
  }
  return null;
}

// --- 1. Nav BEFORE capture + auto-undock before jump ---
export function captureNavBefore(ctx: PassthroughContext): NavBeforeState {
  const { agentName, v1ToolName, navDest, client, deps } = ctx;
  const { statusCache, gameHealthRef } = deps;

  let navBeforeSystem: unknown;
  let navBeforeStation: string | undefined;
  let navStartMs = 0;
  let arrivalTickBeforeNav: number | null = null;

  if (ctx.isNavTool) {
    // Snapshot the arrival tick BEFORE nav so waitForNavCacheUpdate can detect the change.
    // Do NOT clear lastArrivalTick — that causes a race where the arrival signal
    // arrives during execute() and is missed by waitForNextArrival.
    arrivalTickBeforeNav = client.lastArrivalTick;
    navStartMs = Date.now();

    const cachedBefore = statusCache.get(agentName);
    const playerBefore = cachedBefore?.data?.player as Record<string, unknown> | undefined;
    navBeforeSystem = playerBefore?.current_system;
    // Capture station BEFORE nav for market reservation release (bug fix: cache updates by the time we check later)
    navBeforeStation = playerBefore?.current_poi as string | undefined;

    const agentTick = cachedBefore?.data?.tick;
    const serverTick = gameHealthRef.current?.tick;
    const drift = typeof agentTick === "number" && serverTick ? serverTick - agentTick : "?";
    const shipBefore = cachedBefore?.data?.ship as Record<string, unknown> | undefined;
    const fuel = shipBefore?.fuel ?? "?";

    log.debug(`${v1ToolName} BEFORE`, {
      agent: agentName,
      system: String(playerBefore?.current_system),
      poi: String(playerBefore?.current_poi),
      docked: playerBefore?.docked_at_base ?? "none",
      dest: String(navDest ?? "?"),
      fuel: String(fuel),
      tick: String(agentTick),
      server_tick: String(serverTick ?? "?"),
      drift: String(drift),
    });
  }

  return { navBeforeSystem, navBeforeStation, navStartMs, arrivalTickBeforeNav };
}

// --- 1b. Validate nav target name against galaxy graph (warn on hallucinations) ---
export function computePoiWarning(ctx: PassthroughContext): string | undefined {
  const { agentName, v1ToolName, payload, navDest, deps } = ctx;
  const { statusCache } = deps;

  let poiWarning: string | undefined;
  if (deps.poiValidator) {
    const validator = deps.poiValidator;
    const cachedStatus = statusCache.get(agentName);
    const playerData = cachedStatus?.data?.player as Record<string, unknown> | undefined;
    const currentSystem = playerData?.current_system as string | undefined;

    const getWarning = (targetName: string, forSystem: boolean) => {
      const suggestions = validator.getSuggestions(targetName);
      const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
      const targetType = forSystem ? "system" : "POI";
      const fix = forSystem
        ? " Use find_route or get_system to find valid system IDs — do NOT guess names."
        : " Use get_system to list valid POI IDs in your current system — do NOT guess names.";
      log.warn("poi_validation_failed", { agent: agentName, tool: v1ToolName, target: targetName, suggestions });
      return `WARNING: '${targetName}' is not a known ${targetType}.${hint}${fix}`;
    };

    if (v1ToolName === "jump" || v1ToolName === "jump_route") {
      const targetName = (payload?.system ?? payload?.destination ?? navDest) as string | undefined;
      if (targetName && !validator.isValidSystem(targetName)) {
        poiWarning = getWarning(targetName, true);
      }
    } else if (v1ToolName === "travel") {
      const targetName = (payload?.poi ?? navDest) as string | undefined;
      if (targetName && currentSystem && !validator.isValidPoi(currentSystem, targetName)) {
        poiWarning = getWarning(targetName, false);
      }
    } else if (v1ToolName === "dock") {
      const targetName = (payload?.station ?? payload?.poi) as string | undefined;
      if (targetName && currentSystem && !validator.isValidPoi(currentSystem, targetName)) {
        poiWarning = getWarning(targetName, false);
      }
    } else if (v1ToolName === "travel_to") {
      const targetName = payload?.destination as string | undefined;
      // travel_to can be a system or POI. If it's not a valid system, check if it's a POI.
      if (targetName && currentSystem && !validator.isValidSystem(targetName) && !validator.isValidPoi(currentSystem, targetName)) {
        poiWarning = getWarning(targetName, false);
      }
    }
  }

  return poiWarning;
}

// Validate jump target is a direct neighbor — the game silently returns
// "completed" for non-neighbor jumps without actually moving the player.
export async function checkJumpNeighborGuard(
  ctx: PassthroughContext,
  navBeforeSystem: unknown,
): Promise<McpTextResult | null> {
  const { agentName, action, v1ToolName, payload, navDest, traceId, opts, deps } = ctx;
  const { withInjections } = deps;

  if (v1ToolName === "jump" && navBeforeSystem && navDest && deps.galaxyGraph && deps.galaxyGraph.systemCount > 0) {
    const fromId = deps.galaxyGraph.resolveSystemId(String(navBeforeSystem)) ?? String(navBeforeSystem);
    const toId = deps.galaxyGraph.resolveSystemId(String(navDest)) ?? String(navDest);
    if (fromId !== toId && !deps.galaxyGraph.isNeighbor(fromId, toId)) {
      const route = deps.galaxyGraph.findRoute(fromId, toId);
      const hint = route
        ? `Use jump_route(id="${navDest}") for multi-hop routes (${route.jumps} jumps via ${route.names.slice(1, -1).join(" → ") || "direct"}).`
        : `System "${navDest}" is unreachable from "${navBeforeSystem}".`;
      log.warn("jump target is not a neighbor", {
        agent: agentName,
        from: fromId,
        to: toId,
      });
      const errorMsg = `Cannot jump directly to "${navDest}" — it is not connected to your current system "${navBeforeSystem}". ${hint}`;
      if (!opts?.skipLogging) {
        const earlyId = logToolCallStart(agentName, action, payload, { traceId });
        logToolCallComplete(earlyId, agentName, action, errorMsg, 0, { success: false, errorCode: "not_neighbor" });
      }
      return await withInjections(agentName, textResult({ error: errorMsg }));
    }
  }
  return null;
}

// Auto-undock before jump — the game silently ignores jumps while docked,
// returning "completed" without actually moving the player.
export async function autoUndockBeforeJump(ctx: PassthroughContext): Promise<void> {
  const { agentName, v1ToolName, client, deps } = ctx;
  const { statusCache } = deps;

  if (v1ToolName === "jump") {
    const cached = statusCache.get(agentName);
    const player = cached?.data?.player as Record<string, unknown> | undefined;
    if (player?.docked_at_base) {
      log.debug("auto-undocking before jump", {
        agent: agentName,
        docked_at_base: String(player.docked_at_base),
      });
      await executeForClient(client, "undock");
      await client.waitForTick();
    }
  }
}

// --- 1c. market cache check (analyze_market only) ---
// view_market is item_id-filtered — cache keyed by system:station would serve
// stale data for the wrong item on back-to-back calls with different item_ids.
export async function checkAnalyzeMarketCache(ctx: PassthroughContext): Promise<McpTextResult | null> {
  const { agentName, action, v1ToolName, payload, traceId, opts, deps } = ctx;
  const { statusCache, withInjections } = deps;

  if (v1ToolName === "analyze_market" && deps.analyzeMarketCache) {
    const cached = statusCache.get(agentName);
    const playerData = cached?.data?.player as Record<string, unknown> | undefined;
    const currentSystem = playerData?.current_system as string | undefined;
    const currentStation = playerData?.current_poi as string | undefined;

    if (currentSystem && currentStation) {
      const toolType = "analyze_market" as const;
      const hit = deps.analyzeMarketCache.get(currentSystem, currentStation, toolType);
      if (hit) {
        const annotation = AnalyzeMarketCache.freshnessAnnotation(hit.ageMs, hit.agent);
        log.info(`${toolType} cache hit`, {
          agent: agentName,
          system: currentSystem,
          station: currentStation,
          age_ms: hit.ageMs,
          cached_by: hit.agent,
        });

        // Parse cached result, append freshness annotation, and return directly
        let cachedResult: unknown;
        try {
          cachedResult = JSON.parse(hit.result);
        } catch {
          cachedResult = { _raw: hit.result };
        }
        if (typeof cachedResult === "object" && cachedResult !== null) {
          (cachedResult as Record<string, unknown>)._cache = annotation;
        }

        // Store the market analysis timestamp (same as live path)
        if (cached?.data) {
          (cached.data as any)._last_market_analysis_at = Date.now();
          statusCache.set(agentName, { data: cached.data, fetchedAt: cached.fetchedAt });
        }

        if (!opts?.skipLogging) {
          const cacheId = logToolCallStart(agentName, action, payload, { traceId });
          logToolCallComplete(cacheId, agentName, action, cachedResult, 0);
        }
        return await withInjections(agentName, textResult(cachedResult));
      }
    }
  }
  return null;
}

// --- 1d. Auto-fill weapon id for reload ---
// v1: ship.weapons[].instance_id → payload.weapon_instance_id
// v2: ship.modules[] (from HttpGameClientV2 status parser) where slot
//     contains "weapon" → payload.id (the v2 generic param name)
export function autoFillReloadWeaponId(ctx: PassthroughContext): void {
  const { agentName, v1ToolName, payload, client, deps } = ctx;
  const { statusCache } = deps;

  if (v1ToolName === "reload" && payload) {
    const isV2Client = typeof client.isV2 === "function" && client.isV2();
    const cached = statusCache.get(agentName);
    const ship = cached?.data?.ship as Record<string, unknown> | undefined;

    if (isV2Client && !payload.id) {
      const modules = ship?.modules as Array<Record<string, unknown>> | undefined;
      if (modules && modules.length > 0) {
        const weaponMod = modules.find((m) => {
          const slot = String(m.slot ?? "").toLowerCase();
          return slot.includes("weapon");
        });
        const weaponId = weaponMod?.id;
        if (weaponId) {
          payload.id = weaponId;
          log.debug("auto-filled weapon id for reload (v2)", { agent: agentName, weaponId: String(weaponId) });
        }
      }
    } else if (!isV2Client && !payload.weapon_instance_id) {
      const weapons = ship?.weapons as Array<Record<string, unknown>> | undefined;
      if (weapons && weapons.length > 0) {
        const firstWeapon = weapons[0];
        const weaponId = firstWeapon.instance_id ?? firstWeapon.id;
        if (weaponId) {
          payload.weapon_instance_id = weaponId;
          log.debug("auto-filled weapon_instance_id for reload", { agent: agentName, weaponId: String(weaponId) });
        }
      }
    }
  }
}

// --- 1e. Pre-dock check: block dock at known non-dockable POIs ---
// Fail-OPEN on a stale cache: if statusCache froze (e.g. the session-renewal
// breaker tripped and refreshStatus stopped firing), current_poi can point at a
// location the ship left hours ago. Blocking dock against that frozen POI is the
// persistent dock-state wedge. Only trust the cached position to fail-closed when
// it is reasonably fresh; otherwise let the game authoritatively decide.
export async function checkPreDockGuard(ctx: PassthroughContext): Promise<McpTextResult | null> {
  const { agentName, action, v1ToolName, payload, traceId, opts, deps } = ctx;
  const { statusCache, withInjections } = deps;

  const PRE_DOCK_STALE_CEILING_MS = 300_000; // 5 min
  if (v1ToolName === "dock") {
    const cachedPreDock = statusCache.get(agentName);
    const playerPreDock = cachedPreDock?.data?.player as Record<string, unknown> | undefined;
    const preDockPoi = String(playerPreDock?.current_poi ?? "");
    const preDockStale = !cachedPreDock
      || (Date.now() - cachedPreDock.fetchedAt) > PRE_DOCK_STALE_CEILING_MS;
    if (preDockPoi && !preDockStale) {
      const dockable = isDockable(preDockPoi);
      if (dockable === false) {
        const poi = getPoi(preDockPoi);
        const poiLabel = poi?.name ?? preDockPoi;
        const systemName = String(playerPreDock?.current_system ?? "");
        const systemClause = systemName
          ? `Use get_system for "${systemName}" to find dockable stations, then travel_to that station.`
          : "Use get_system to find stations with bases, then travel_to that station.";
        if (!opts?.skipLogging) {
          const earlyId = logToolCallStart(agentName, action, payload, { traceId });
          logToolCallComplete(earlyId, agentName, action,
            { error: "known_non_dockable", message: `"${poiLabel}" is a known non-dockable POI.` },
            0, { success: false, errorCode: "known_non_dockable" });
        }
        return await withInjections(agentName, textResult({
          status: "error",
          error: "known_non_dockable",
          message: `"${poiLabel}" is a known non-dockable POI. Do NOT attempt to dock here. ${systemClause}`,
          system: playerPreDock?.current_system,
          poi: preDockPoi,
        }));
      }
    }
  }
  return null;
}

// --- 1f. Pre-flight check: skip buy_insurance if already insured ---
// Prevents a wasted round-trip when the agent's insurance is already active.
export async function checkBuyInsuranceGuard(ctx: PassthroughContext): Promise<McpTextResult | null> {
  const { agentName, action, v1ToolName, payload, traceId, opts, deps } = ctx;
  const { statusCache, withInjections } = deps;

  if (v1ToolName === "buy_insurance") {
    const cachedInsurance = statusCache.get(agentName);
    const insurance = cachedInsurance?.data?.insurance as Record<string, unknown> | undefined;
    if (insurance?.active === true) {
      if (!opts?.skipLogging) {
        const earlyId = logToolCallStart(agentName, action, payload, { traceId });
        logToolCallComplete(earlyId, agentName, action,
          { error: { code: "already_insured", message: "Ship already has active insurance. No action needed — skip and continue." } },
          0, { success: false, errorCode: "already_insured" });
      }
      return await withInjections(agentName, textResult({
        error: { code: "already_insured", message: "Ship already has active insurance. No action needed — skip and continue." },
      }));
    }
  }
  return null;
}

// --- 1g. Idempotent state pre-flight checks for dock/undock ---
// After a session restart, agents frequently fire dock/undock without
// verifying state first, producing a flood of `already_docked` /
// `already_undocked` errors. These are semantically no-ops — the agent's
// desired state already holds. Return status=ok with a hint so the agent
// moves on instead of treating it as a failure.
export async function checkDockUndockIdempotent(ctx: PassthroughContext): Promise<McpTextResult | null> {
  const { agentName, action, v1ToolName, payload, traceId, opts, deps } = ctx;
  const { statusCache, withInjections } = deps;

  if (v1ToolName === "dock" || v1ToolName === "undock") {
    const cached = statusCache.get(agentName);
    const player = cached?.data?.player as Record<string, unknown> | undefined;
    const docked = player?.docked_at_base;
    // Only short-circuit when we have definite cached state. `undefined` means
    // "we don't know" — let the real call run and surface any genuine error.
    if (typeof docked === "boolean") {
      if (v1ToolName === "dock" && docked === true) {
        if (!opts?.skipLogging) {
          const earlyId = logToolCallStart(agentName, action, payload, { traceId });
          logToolCallComplete(earlyId, agentName, action,
            { status: "ok", already_docked: true, message: "Already docked — no action needed." },
            0, { success: true });
        }
        return await withInjections(agentName, textResult({
          status: "ok",
          already_docked: true,
          message: "Already docked at this station — no action needed. Proceed with your next step.",
          current_system: player?.current_system,
          current_poi: player?.current_poi,
        }));
      }
      if (v1ToolName === "undock" && docked === false) {
        if (!opts?.skipLogging) {
          const earlyId = logToolCallStart(agentName, action, payload, { traceId });
          logToolCallComplete(earlyId, agentName, action,
            { status: "ok", already_undocked: true, message: "Already in space — no action needed." },
            0, { success: true });
        }
        return await withInjections(agentName, textResult({
          status: "ok",
          already_undocked: true,
          message: "Already undocked — you're in space. Proceed with your next step.",
          current_system: player?.current_system,
          current_poi: player?.current_poi,
        }));
      }
    }
  }
  return null;
}
