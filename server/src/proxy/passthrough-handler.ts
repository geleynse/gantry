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
import type { MarketReservationCache } from "./market-reservations.js";
import type { AnalyzeMarketCache } from "./analyze-market-cache.js";
import type { PoiValidator } from "./poi-validator.js";
import type { TransitStuckDetector } from "./transit-stuck-detector.js";
import { logToolCallStart, logToolCallComplete } from "./tool-call-logger.js";
import { createLogger } from "../lib/logger.js";
import { dispatchV1ToV2, V1_TO_V2_DISPATCH } from "./dispatch-v1-to-v2.js";
import { NAV_COMMAND_TIMEOUT_MS } from "./game-transport.js";
import {
  checkRefuelGuard,
  checkStructuralNavGuards,
  captureNavBefore,
  computePoiWarning,
  checkJumpNeighborGuard,
  autoUndockBeforeJump,
  checkAnalyzeMarketCache,
  autoFillReloadWeaponId,
  checkPreDockGuard,
  checkBuyInsuranceGuard,
  checkDockUndockIdempotent,
} from "./passthrough-guards.js";
import {
  detectUnknownNavFields,
  refreshNavCacheOnJumpError,
  handleStateChangingTickWait,
  handleReloadMissingAmmo,
  handleNavErrorMapping,
  handleErrorPath,
  handleSuccessPath,
} from "./passthrough-postprocess.js";

const log = createLogger("passthrough");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type McpTextResult = { content: Array<{ type: "text"; text: string }> };

export function textResult(data: unknown): McpTextResult {
  const payload = data ?? {};
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

/**
 * Guard: reject `refuel(target=...)` before it reaches the game client.
 *
 * Background: the game's refuel command is self-only — there is no proxy or
 * server handler for cross-player fuel transfer. Without this guard the game
 * silently accepts the call, ignores the bogus param, and returns a misleading
 * error (e.g. `unknown_item: 'fleet'`, `no_fuel_cells`) which agents read as
 * "different errors, must be a syntax variant" and keep retrying. Sable-thorn's
 * 2026-05-04 incident showed the agent thought it had rescued a stranded ally
 * when it had only refueled itself. Silently stripping the param would
 * reproduce the same footgun, so the rejection is loud and explicit.
 *
 * Returns the structured error envelope when the guard fires, or null when the
 * call is fine to pass through. Both v1 (`refuel`) and v2
 * (`spacemolt(action="refuel", ...)`) call paths funnel through
 * handlePassthrough with `v1ToolName === "refuel"`, so a single chokepoint is
 * sufficient.
 */
export function checkRefuelTargetGuard(
  v1ToolName: string,
  payload: Record<string, unknown> | undefined,
): { status: "error"; code: string; message: string } | null {
  if (v1ToolName !== "refuel") return null;
  if (!payload || payload.target === undefined || payload.target === null || payload.target === "") return null;
  return {
    status: "error",
    code: "refuel_target_unsupported",
    message:
      "target= parameter is not supported by this proxy/game build. " +
      "Use refuel() for self-refuel only. To rescue a stranded fleet member, " +
      "see common-rules §12.5 OR escalate to operator.",
  };
}

// ---------------------------------------------------------------------------
// Shared context for the pre-flight guards + post-processing handlers.
//
// handlePassthrough is a long linear pipeline with a lot of shared local state.
// Rather than thread a dozen params through every extracted phase, we pass a
// single typed context object. PassthroughContext holds the invariant inputs;
// PassthroughExecContext extends it with the values that only exist after the
// game call has been dispatched (log ids, elapsed time, captured nav state).
// ---------------------------------------------------------------------------

/** Nav BEFORE snapshot captured prior to executing a nav tool. */
export interface NavBeforeState {
  navBeforeSystem: unknown;
  navBeforeStation: string | undefined;
  navStartMs: number;
  arrivalTickBeforeNav: number | null;
}

/** Invariant inputs for a single passthrough call, shared by every phase. */
export interface PassthroughContext {
  deps: PassthroughDeps;
  client: PassthroughClient;
  agentName: string;
  action: string;
  v1ToolName: string;
  payload?: Record<string, unknown>;
  navDest?: unknown;
  traceId?: string;
  opts?: { skipLogging?: boolean; v2ToolHint?: string };
  isNavTool: boolean;
}

/** Context after the game call has been dispatched — adds execution-phase state. */
export interface PassthroughExecContext extends PassthroughContext {
  pendingId: number;
  completeLog: typeof logToolCallComplete;
  elapsed: number;
  navBefore: NavBeforeState;
  poiWarning: string | undefined;
}

/** Minimal client interface required by handlePassthrough */
export interface PassthroughClient {
  execute: (
    cmd: string,
    args?: Record<string, unknown>,
    opts?: { timeoutMs?: number; noRetry?: boolean },
  ) => Promise<{ result?: unknown; error?: { code?: unknown; message?: unknown } | null }>;
  waitForTick: (ms?: number) => Promise<void>;
  lastArrivalTick: number | null;
  /** Optional: present on v1/v2 HTTP clients, absent on test mocks. Test mocks
   *  default to v1 dispatch (the previous behavior). */
  isV2?: () => boolean;
}

export async function executeForClient(
  client: PassthroughClient,
  v1ToolName: string,
  args?: Record<string, unknown>,
  v2ToolHint?: string,
  opts?: { timeoutMs?: number; noRetry?: boolean },
): Promise<{ result?: unknown; error?: { code?: unknown; message?: unknown } | null }> {
  // Last-mile nav param normalization. jump/find_route name their destination
  // system inconsistently across call paths (system_id, destination_system_id,
  // text), but the game server expects `target_system` and (since the v0.335.0
  // strict-param patch) hard-rejects unknown params with invalid_payload.
  // tool-registry remaps on the generic dispatch path, but direct passthrough /
  // nav-retry paths reach here un-remapped (observed: jump system_id=muscida,
  // find_route text=...). Idempotent: only fills target_system when it's absent,
  // so it's a no-op on the already-remapped path. `bearing` (jump's alt param)
  // is left untouched — no alias present means no rewrite.
  if ((v1ToolName === "jump" || v1ToolName === "find_route") && args && !("target_system" in args)) {
    const dest = args.system_id ?? args.destination_system_id ?? args.text;
    if (dest !== undefined) {
      args = { ...args, target_system: dest };
      delete args.system_id;
      delete args.destination_system_id;
      delete args.text;
    }
  }

  // Only forward opts when present, so the no-opts call shape is byte-for-byte
  // identical to the pre-opts signature (avoids a trailing `undefined` arg that
  // would break strict toHaveBeenCalledWith assertions and is a no-op anyway).
  const fwd = (
    cmd: string,
    a?: Record<string, unknown>,
  ): Promise<{ result?: unknown; error?: { code?: unknown; message?: unknown } | null }> =>
    opts ? client.execute(cmd, a, opts) : client.execute(cmd, a);

  const isV2 = typeof client.isV2 === "function" && client.isV2();
  if (!isV2) {
    return fwd(v1ToolName, args);
  }

  // Use shared dispatch table. Fall back to v2ToolHint for v2-native action
  // names not in the legacy map (e.g. spacemolt_storage(action="deposit")).
  const dispatched = dispatchV1ToV2(v1ToolName, args);
  if (dispatched) {
    return fwd(dispatched.tool, dispatched.args);
  }

  if (v2ToolHint && !V1_TO_V2_DISPATCH[v1ToolName]) {
    return fwd(v2ToolHint, { action: v1ToolName, ...(args ?? {}) });
  }

  return fwd(v1ToolName, args);
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
  opts?: { skipLogging?: boolean; v2ToolHint?: string },
): Promise<McpTextResult> {

  const { recordActivity } = deps;

  // Record agent activity to prevent stale-session detection during active tool execution
  recordActivity?.(agentName);

  const isNavTool = v1ToolName === "jump" || v1ToolName === "travel" || v1ToolName === "jump_route";
  const ctx: PassthroughContext = {
    deps,
    client,
    agentName,
    action,
    v1ToolName,
    payload,
    navDest,
    traceId,
    opts,
    isNavTool,
  };

  // --- Phase 1: pre-flight guards (ORDER IS LOAD-BEARING — do not reorder) ---
  // Each guard returns a short-circuit result or null to continue. Cargo-full is
  // checked before fuel-floor (inside checkStructuralNavGuards); nav-before state
  // is captured before the neighbor guard, which consumes navBeforeSystem.

  const refuelGuard = await checkRefuelGuard(ctx);
  if (refuelGuard) return refuelGuard;

  const structuralGuard = await checkStructuralNavGuards(ctx);
  if (structuralGuard) return structuralGuard;

  const navBefore = captureNavBefore(ctx);
  const poiWarning = computePoiWarning(ctx);

  const neighborGuard = await checkJumpNeighborGuard(ctx, navBefore.navBeforeSystem);
  if (neighborGuard) return neighborGuard;

  await autoUndockBeforeJump(ctx);

  const marketCacheGuard = await checkAnalyzeMarketCache(ctx);
  if (marketCacheGuard) return marketCacheGuard;

  autoFillReloadWeaponId(ctx);

  const preDockGuard = await checkPreDockGuard(ctx);
  if (preDockGuard) return preDockGuard;

  const buyInsuranceGuard = await checkBuyInsuranceGuard(ctx);
  if (buyInsuranceGuard) return buyInsuranceGuard;

  const dockUndockGuard = await checkDockUndockIdempotent(ctx);
  if (dockUndockGuard) return dockUndockGuard;

  // --- 2. Execute ---

  const skipLog = opts?.skipLogging === true;
  const pendingId = skipLog ? 0 : logToolCallStart(agentName, action, payload, { traceId });
  const completeLog = skipLog
    ? (() => {}) as typeof logToolCallComplete
    : logToolCallComplete;
  const toolStartMs = Date.now();
  try {
  // Extended client timeout for travel/jump (v0.341.1): the game holds these
  // requests OPEN until arrival — up to several minutes for slow ships. The
  // default 90s would abort a legitimate long haul and surface a spurious
  // `timeout` error. Applied ONLY to travel/jump so real hangs on other tools
  // still surface promptly. jump_route is excluded — it loops per-hop internally.
  const execOpts =
    v1ToolName === "travel" || v1ToolName === "jump"
      ? { timeoutMs: NAV_COMMAND_TIMEOUT_MS }
      : undefined;
  const resp = await executeForClient(client, v1ToolName, payload, opts?.v2ToolHint, execOpts);

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

  // --- 3. Post-processing (ORDER IS LOAD-BEARING — do not reorder) ---
  // Every phase below mutates `resp` / its result in place and either returns a
  // short-circuit McpTextResult or null to continue. handleSuccessPath is terminal.
  const execCtx: PassthroughExecContext = {
    ...ctx,
    pendingId,
    completeLog,
    elapsed,
    navBefore,
    poiWarning,
  };

  detectUnknownNavFields(execCtx, resp);
  await refreshNavCacheOnJumpError(execCtx, resp);

  const tickWaitResult = await handleStateChangingTickWait(execCtx, resp);
  if (tickWaitResult) return tickWaitResult;

  const reloadResult = await handleReloadMissingAmmo(execCtx, resp);
  if (reloadResult) return reloadResult;

  const navErrorResult = await handleNavErrorMapping(execCtx, resp);
  if (navErrorResult) return navErrorResult;

  const errorPathResult = await handleErrorPath(execCtx, resp);
  if (errorPathResult) return errorPathResult;

  return await handleSuccessPath(execCtx, resp);
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
