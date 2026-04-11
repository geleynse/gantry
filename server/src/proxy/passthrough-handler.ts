/**
 * Shared passthrough handler for game tool execution.
 *
 * Extracted from tool-registry.ts so that both the v1 MCP server (createGantryServer)
 * and the v2 MCP server (createGantryServerV2) can call the same logic without
 * duplicating ~150 lines of nav logging, tick waits, summarization, and enrichment.
 *
 * Entry point: handlePassthrough()
 */

import type { MarketCache } from "./market-cache.js";
import type { GameHealthRef } from "./server.js";
import type { GalaxyGraph } from "./pathfinder.js";
import type { EventBuffer } from "./event-buffer.js";
import { summarizeToolResult } from "./summarizers.js";
import { addErrorHint, type HintContext } from "./error-hints.js";
import { enrichWithGlobalContext } from "./market-enrichment.js";
import type { MarketReservationCache } from "./market-reservations.js";
import { AnalyzeMarketCache, CACHE_INVALIDATING_TOOLS } from "./analyze-market-cache.js";
import { cacheSystemPois } from "./poi-resolver.js";
import type { PoiValidator } from "./poi-validator.js";
import type { TransitStuckDetector } from "./transit-stuck-detector.js";
import { logToolCallStart, logToolCallComplete } from "./tool-call-logger.js";
import { createLogger } from "../lib/logger.js";
import { addDiaryEntry } from "../services/notes-db.js";
import { validateCaptainsLogFormat } from "./pipeline.js";
import { syncCaptainsLogsFromServer, persistCaptainsLogEntry } from "../services/captains-logs-db.js";
import { syncActionLog, persistActionLogEntries } from "../services/action-log-parser.js";
import { markDockable, isDockable, getPoi } from "../services/galaxy-poi-registry.js";
import { enrichWithThreatAssessment } from "./threat-assessment.js";
import { normalizeSystemName } from "./compound-tools/utils.js";
import { autoRecordLoreFromResult, buildLoreHint } from "../services/poi-lore.js";
import { recordMarketResources } from "../services/resource-knowledge.js";

const log = createLogger("passthrough");

// Known response fields for nav tools — used for schema drift detection.
const KNOWN_NAV_FIELDS: Record<string, Set<string>> = {
  jump: new Set(["status", "completed", "location_after", "system", "message", "pending", "error", "tick", "command", "arrival_tick", "fuel_cost", "transit_destination", "destination", "ticks_remaining"]),
  travel: new Set(["status", "completed", "location_after", "poi", "message", "pending", "error", "tick", "command", "arrival_tick", "fuel_cost", "transit_destination", "destination", "ticks_remaining"]),
  jump_route: new Set(["status", "completed", "location_after", "jumps_completed", "jumps_total", "stopped_reason", "error", "fuel_used"]),
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type McpTextResult = { content: Array<{ type: "text"; text: string }> };

export function textResult(data: unknown): McpTextResult {
  const payload = data ?? {};
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

/** Minimal client interface required by handlePassthrough */
export interface PassthroughClient {
  execute: (cmd: string, args?: Record<string, unknown>) => Promise<{ result?: unknown; error?: { code?: unknown; message?: unknown } | null }>;
  waitForTick: (ms?: number) => Promise<void>;
  lastArrivalTick: number | null;
}

export interface PassthroughDeps {
  statusCache: Map<string, { data: Record<string, unknown>; fetchedAt: number }>;
  marketCache: MarketCache;
  gameHealthRef: GameHealthRef;
  stateChangingTools: Set<string>;
  waitForNavCacheUpdate: (
    client: PassthroughClient,
    agentName: string,
    beforeSystem: unknown,
    maxTicks?: number,
    arrivalTickBeforeAction?: number | null,
  ) => Promise<boolean>;
  waitForDockCacheUpdate: (
    client: PassthroughClient,
    agentName: string,
    maxTicks?: number,
  ) => Promise<boolean>;
  decontaminateLog: (result: unknown) => unknown;
  stripPendingFields: (result: unknown) => void;
  withInjections: (agentName: string, response: McpTextResult) => Promise<McpTextResult>;
  galaxyGraph?: GalaxyGraph;
  /** Event buffers per agent — used to block pending commands until action_result arrives. */
  eventBuffers?: Map<string, EventBuffer>;
  /** How long to wait for craft action_result before falling back to hint (default 45s). */
  craftResultTimeoutMs?: number;
  /** How long to wait for a generic pending action_result before falling back to waitForTick (default 15s). */
  actionResultTimeoutMs?: number;
  /** Market reservation cache for cross-agent inventory coordination. */
  marketReservations?: MarketReservationCache;
  /** Cross-agent analyze_market result cache (60s TTL, station-keyed). */
  analyzeMarketCache?: AnalyzeMarketCache;
  /** POI/system name validator for detecting agent hallucinations. */
  poiValidator?: PoiValidator;
  /** Transit stuck detector — tracks consecutive empty-location responses per agent. */
  transitStuckDetector?: TransitStuckDetector;
  /** Optional callback to record agent activity (updates last-seen timestamp for stale session detection). */
  recordActivity?: (agentName: string) => void;
  /** Optional game-API rate limit tracker — records every tool call to compute RPM per agent/IP. */
  rateLimitTracker?: import("../services/rate-limit-tracker.js").RateLimitTracker;
  /** Optional resource knowledge tracker — records resources from market responses. */
  resourceKnowledge?: import("../services/resource-knowledge.js").ResourceKnowledge;
}

// ---------------------------------------------------------------------------
// waitForActionResult
// ---------------------------------------------------------------------------

/**
 * Poll the agent's event buffer for an `action_result` event matching the given command.
 * Returns the outputs array from the result if found within timeoutMs, or null on timeout.
 * The matching event is removed from the buffer (consumed by the response).
 *
 * @param eventBuffer   - Per-agent event buffer to poll
 * @param command       - The command name to match (e.g. "craft", "mine", "refuel")
 * @param timeoutMs     - How long to wait before giving up (default 15s; use 45s for craft)
 * @param pollIntervalMs - How often to poll the buffer (default 500ms)
 */
export async function waitForActionResult(
  eventBuffer: EventBuffer,
  command: string,
  timeoutMs = 15_000,
  pollIntervalMs = 500,
): Promise<Array<Record<string, unknown>> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = eventBuffer.findAndRemove(
      (e) =>
        e.type === "action_result" &&
        typeof e.payload === "object" &&
        e.payload !== null &&
        (e.payload as Record<string, unknown>).command === command,
    );
    if (found) {
      const payload = found.payload as Record<string, unknown>;
      const result = payload.result as Record<string, unknown> | undefined;
      const outputs = result?.outputs;
      return Array.isArray(outputs) ? (outputs as Array<Record<string, unknown>>) : [];
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return null; // timeout
}

/**
 * @deprecated Use waitForActionResult(eventBuffer, "craft", timeoutMs) instead.
 * Kept for backwards compatibility — delegates to the generic version.
 */
export async function waitForCraftActionResult(
  eventBuffer: EventBuffer,
  timeoutMs = 45_000,
  pollIntervalMs = 500,
): Promise<Array<Record<string, unknown>> | null> {
  return waitForActionResult(eventBuffer, "craft", timeoutMs, pollIntervalMs);
}

// ---------------------------------------------------------------------------
// handlePassthrough
// ---------------------------------------------------------------------------

/**
 * Execute a single game tool call via WebSocket.
 *
 * Handles: nav before/after logging, auto-undock before jump, execute,
 * tick waits for state-changing tools, error hints, POI caching,
 * log decontamination, summarization, market enrichment, buy hint, and logToolCall.
 *
 * @param deps      - Shared state and utility functions
 * @param client    - Active game client for this agent
 * @param agentName - Agent performing the action (for caches and logging)
 * @param action    - Display name for logging (v1: toolName, v2: action key)
 * @param v1ToolName - Actual WebSocket command to send to the game server
 * @param payload   - Arguments to pass to the game server (undefined = no-param tool)
 * @param navDest   - Pre-remap destination for nav logging (jump: system_id, travel: poi_id)
 */
export async function handlePassthrough(
  deps: PassthroughDeps,
  client: PassthroughClient,
  agentName: string,
  action: string,
  v1ToolName: string,
  payload?: Record<string, unknown>,
  navDest?: unknown,
  traceId?: string,
  opts?: { skipLogging?: boolean },
): Promise<McpTextResult> {

  const {
    statusCache,
    marketCache,
    gameHealthRef,
    stateChangingTools,
    waitForNavCacheUpdate,
    waitForDockCacheUpdate,
    decontaminateLog,
    stripPendingFields,
    withInjections,
    recordActivity,
  } = deps;

  // Record agent activity to prevent stale-session detection during active tool execution
  recordActivity?.(agentName);

  // --- 1. Nav BEFORE capture + auto-undock before jump ---

  let navBeforeSystem: unknown;
  let navBeforeStation: string | undefined;
  let navStartMs = 0;
  const isNavTool = v1ToolName === "jump" || v1ToolName === "travel" || v1ToolName === "jump_route";

  let arrivalTickBeforeNav: number | null = null;
  if (isNavTool) {
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

  // --- 1b. Validate nav target name against galaxy graph (warn on hallucinations) ---

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

  // Validate jump target is a direct neighbor — the game silently returns
  // "completed" for non-neighbor jumps without actually moving the player.
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

  // Auto-undock before jump — the game silently ignores jumps while docked,
  // returning "completed" without actually moving the player.
  if (v1ToolName === "jump") {
    const cached = statusCache.get(agentName);
    const player = cached?.data?.player as Record<string, unknown> | undefined;
    if (player?.docked_at_base) {
      log.debug("auto-undocking before jump", {
        agent: agentName,
        docked_at_base: String(player.docked_at_base),
      });
      await client.execute("undock");
      await client.waitForTick();
    }
  }

  // --- 1c. market cache check (analyze_market + view_market) ---
  // Return cached result immediately if another agent already fetched this station's data
  // within the TTL. Cache key: {toolType}:{system}:{station}. Invalidated by buy/sell/order actions.
  if ((v1ToolName === "analyze_market" || v1ToolName === "view_market") && deps.analyzeMarketCache) {
    const cached = statusCache.get(agentName);
    const playerData = cached?.data?.player as Record<string, unknown> | undefined;
    const currentSystem = playerData?.current_system as string | undefined;
    const currentStation = playerData?.current_poi as string | undefined;

    if (currentSystem && currentStation) {
      const toolType = v1ToolName as "analyze_market" | "view_market";
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

        // Store the market analysis timestamp (same as live path) — only for analyze_market
        if (v1ToolName === "analyze_market" && cached?.data) {
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

  // --- 1d. Auto-fill weapon_instance_id for reload ---
  if (v1ToolName === "reload" && payload && !payload.weapon_instance_id) {
    const cached = statusCache.get(agentName);
    const ship = cached?.data?.ship as Record<string, unknown> | undefined;
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

  // --- 1e. Pre-dock check: block dock at known non-dockable POIs ---
  if (v1ToolName === "dock") {
    const cachedPreDock = statusCache.get(agentName);
    const playerPreDock = cachedPreDock?.data?.player as Record<string, unknown> | undefined;
    const preDockPoi = String(playerPreDock?.current_poi ?? "");
    if (preDockPoi) {
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

  // --- 1f. Pre-flight check: skip buy_insurance if already insured ---
  // Prevents a wasted round-trip when the agent's insurance is already active.
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

  // --- 2. Execute ---

  const skipLog = opts?.skipLogging === true;
  const pendingId = skipLog ? 0 : logToolCallStart(agentName, action, payload, { traceId });
  const completeLog = skipLog
    ? (() => {}) as typeof logToolCallComplete
    : logToolCallComplete;
  const toolStartMs = Date.now();
  try {
  const resp = await client.execute(v1ToolName, payload);

  // --- Record game API call in rate limit tracker ---
  if (deps.rateLimitTracker) {
    const errorCode = resp.error
      ? String((resp.error as Record<string, unknown>).code ?? "")
      : "";
    const isRateLimit = errorCode === "429" || errorCode === "rate_limited";
    deps.rateLimitTracker.recordRequest(agentName, v1ToolName, isRateLimit);
  }

  // Log every passthrough call with elapsed + result snippet
  const elapsed = Date.now() - toolStartMs;
  const argsStr = payload ? Object.entries(payload).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ") : "";
  const resultSnippet = resp.error
    ? `ERROR: ${(resp.error as Record<string, unknown>).code ?? (resp.error as Record<string, unknown>).message ?? "unknown"}`
    : JSON.stringify(resp.result ?? null).slice(0, 150);
  log.info(`${v1ToolName} executed`, {
    agent: agentName,
    args: argsStr || "none",
    elapsed_ms: elapsed,
    result: resultSnippet,
    trace: traceId,
  });

  // --- 2a. Unknown field detection for nav tools ---
  // Log any top-level response fields we don't recognize so we can spot schema drift.
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

  // --- 3. State-changing tick wait ---

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
          try {
            const shipResp = await client.execute("get_ship", {});
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
          const retryResp = await client.execute("dock", undefined);
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
              markDockable(poiIdFail, false, {
                name: poiIdFail,
                system: String(playerRetry?.current_system ?? ""),
              });
            }
            const poiName = String(playerRetry?.current_poi ?? "unknown");
            const isLikelyNonDockable = isDockable(poiName) === false ||
              /belt|sun|cloud|field|asteroid|vents|nebula|secundus|tollkeeper|shelf|reef|cluster|ring|deposit|harvesters|mineral|gas_pocket|_star$|^saturn$|_drift|comet|remnant|red_maw|_i+$|_world$|sentinel|citadel|cryobelt/.test(poiName);
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
        const commissionResp = await client.execute("commission_status", {});
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

  // --- 4. Error path ---

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
    return await withInjections(agentName, textResult({ error: errorMsg }));
  }

  // --- 5. Success path ---

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

  // Validate and mirror captains_log_add to local Gantry diary DB
  if (v1ToolName === "captains_log_add") {
    const entry = (payload as Record<string, unknown>)?.entry;
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

      // Also persist to captain's logs table if this was a successful add
      if (typeof result === "object" && result !== null) {
        const resultObj = result as Record<string, unknown>;
        if (resultObj.status === "ok" && resultObj.log_id) {
          try {
            persistCaptainsLogEntry(agentName, entry, String(resultObj.log_id));
            log.debug("persisted captain's log entry to captains_logs table", {
              agent: agentName,
              log_id: resultObj.log_id,
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
  }

  // --- market cache store (analyze_market + view_market) ---
  // After a successful live game API call, store the result for other agents at the same station.
  // (We are past the resp.error early-return, so this is always a success.)
  if ((v1ToolName === "analyze_market" || v1ToolName === "view_market") && deps.analyzeMarketCache) {
    try {
      const cacheStatus = statusCache.get(agentName);
      const cachePlayer = cacheStatus?.data?.player as Record<string, unknown> | undefined;
      const cacheSystem = cachePlayer?.current_system as string | undefined;
      const cacheStation = cachePlayer?.current_poi as string | undefined;
      if (cacheSystem && cacheStation) {
        const toolType = v1ToolName as "analyze_market" | "view_market";
        deps.analyzeMarketCache.set(cacheSystem, cacheStation, JSON.stringify(summarized), agentName, toolType);
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
      "Call withdraw_items(item_id) to move to cargo, then install_mod(item_id) to equip.";
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
    (summarized as any).hint = "⚠️ Items deposited to STATION STORAGE — you earned 0 credits. Use multi_sell instead to earn credits. Deposits are almost never the right choice.";
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
    const isError = 
      (typeof summarized === "object" && summarized !== null && 
       ("error" in (summarized as any) || (summarized as any).status === "error" || (summarized as any).status === "failed"));
    
    if (!isError) {
      return await withInjections(agentName, textResult({ status: "completed", result: summarized }));
    }
  }

  return await withInjections(agentName, textResult(summarized));
  } catch (err) {
    const elapsed = Date.now() - toolStartMs;
    log.error(`${v1ToolName} handler threw unexpectedly`, {
      agent: agentName,
      error: err instanceof Error ? err.message : String(err),
    });
    completeLog(pendingId, agentName, action, { error: "internal_error" }, elapsed, {
      success: false,
      errorCode: "internal_error",
    });
    return textResult({ error: "internal_error", message: err instanceof Error ? err.message : String(err) });
  }
}

// ---------------------------------------------------------------------------
// extractLocalBids
// ---------------------------------------------------------------------------

/**
 * Extract local bid prices from an analyze_market response.
 *
 * The analyze_market response contains `recommendations` — an array of per-item
 * demand data. Each recommendation has an `estimated_value` field that represents
 * the local station's bid/demand price for that item.
 *
 * Returns a Map<item_id, estimated_value> for use with enrichWithGlobalContext.
 */
export function extractLocalBids(analyzeMarketResult: unknown): Map<string, number> {
  const bids = new Map<string, number>();

  if (!analyzeMarketResult || typeof analyzeMarketResult !== "object") return bids;

  const result = analyzeMarketResult as Record<string, unknown>;
  const recommendations = result.recommendations;

  if (!Array.isArray(recommendations)) return bids;

  for (const rec of recommendations) {
    if (!rec || typeof rec !== "object") continue;
    const r = rec as Record<string, unknown>;
    const itemId = r.item_id;
    const estimatedValue = r.estimated_value;
    if (typeof itemId === "string" && typeof estimatedValue === "number" && estimatedValue > 0) {
      bids.set(itemId, estimatedValue);
    }
  }

  return bids;
}
