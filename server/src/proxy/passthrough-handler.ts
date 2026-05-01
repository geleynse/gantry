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
import { markDockable, isDockable, getPoi, recordDockFailure } from "../services/galaxy-poi-registry.js";
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
  /** Optional: present on v1/v2 HTTP clients, absent on test mocks. Test mocks
   *  default to v1 dispatch (the previous behavior). */
  isV2?: () => boolean;
}

import { V2_TO_V1_PARAM_MAP } from "./schema.js";

// ---------------------------------------------------------------------------
// v1 → v2 dispatch mapping
// ---------------------------------------------------------------------------

/**
 * Inverse of `V2_TO_V1_PARAM_MAP` (schema.ts). For each v2 action, maps the
 * v1-specific param name BACK to the v2-generic name so that compound-tool
 * code that passes v1-style args (`target_system`, `target_poi`, `target_id`,
 * `wreck_id`, `module_id`, etc.) gets translated to the generic shape the
 * v2 game server actually accepts (`id`, `text`, `count`, `quantity`).
 *
 * Identity entries (where v1 and v2 use the same name) are skipped so the
 * resulting per-action map stays small and unambiguous.
 *
 * Computed once at module load time. Reads as: "for v2 action `jump`, rename
 * v1 param `target_system` to v2 param `id`."
 */
const V1_TO_V2_PARAM_MAP: Record<string, Record<string, string>> = (() => {
  const inverted: Record<string, Record<string, string>> = {};
  for (const [action, paramMap] of Object.entries(V2_TO_V1_PARAM_MAP)) {
    const inverse: Record<string, string> = {};
    // First-write wins: when multiple v2 params remap to the same v1 name
    // (e.g. jump's `id` and `system_id` both map to `target_system`), the
    // FIRST one declared in V2_TO_V1_PARAM_MAP is the canonical v2 generic
    // name. The later entries are defensive aliases for prompt-misread
    // recovery (see sable-thorn `system_id` fix). For outbound v1→v2, we
    // always pick the canonical name.
    for (const [v2Param, v1Param] of Object.entries(paramMap)) {
      if (v2Param === v1Param) continue;
      if (inverse[v1Param] !== undefined) continue;
      inverse[v1Param] = v2Param;
    }
    inverted[action] = inverse;
  }
  return inverted;
})();

/**
 * Translate v1-style args into v2-style args for the given v2 action.
 * Returns a new object; does not mutate the input.
 */
function translateV1ArgsToV2(action: string, args: Record<string, unknown> | undefined): Record<string, unknown> {
  const paramMap = V1_TO_V2_PARAM_MAP[action];
  if (!paramMap || !args) return { ...(args ?? {}) };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const renamed = paramMap[key] ?? key;
    out[renamed] = value;
  }
  return out;
}

/**
 * v1 tool name → { v2Tool, v2Action }. Used by `executeForClient` to dispatch
 * a v1 flat call ("undock", "mine", "attack", ...) against a v2 game server,
 * which needs the consolidated tool namespace plus an `action` arg.
 *
 * Reads as the inverse of `V2_ACTION_TO_V1_NAME` in `gantry-v2.ts`. Anything
 * not in this map is presumed to be a static v2-namespaced action under
 * `spacemolt` (the default namespace for almost everything).
 */
const V1_TO_V2_DISPATCH: Record<string, { tool: string; action: string }> = {
  // spacemolt (default namespace) — explicit entries for clarity.
  mine: { tool: "spacemolt", action: "mine" },
  travel: { tool: "spacemolt", action: "travel" },
  jump: { tool: "spacemolt", action: "jump" },
  jump_route: { tool: "spacemolt", action: "jump_route" },
  dock: { tool: "spacemolt", action: "dock" },
  undock: { tool: "spacemolt", action: "undock" },
  refuel: { tool: "spacemolt", action: "refuel" },
  repair: { tool: "spacemolt", action: "repair" },
  sell: { tool: "spacemolt", action: "sell" },
  buy: { tool: "spacemolt", action: "buy" },
  craft: { tool: "spacemolt", action: "craft" },
  jettison: { tool: "spacemolt", action: "jettison" },
  install_mod: { tool: "spacemolt", action: "install_mod" },
  uninstall_mod: { tool: "spacemolt", action: "uninstall_mod" },
  repair_module: { tool: "spacemolt", action: "repair_module" },
  use_item: { tool: "spacemolt", action: "use_item" },
  cloak: { tool: "spacemolt", action: "cloak" },
  self_destruct: { tool: "spacemolt", action: "self_destruct" },
  survey_system: { tool: "spacemolt", action: "survey_system" },
  distress_signal: { tool: "spacemolt", action: "distress_signal" },
  // spacemolt query actions
  get_status: { tool: "spacemolt", action: "get_status" },
  get_state: { tool: "spacemolt", action: "get_state" },
  get_player: { tool: "spacemolt", action: "get_player" },
  get_location: { tool: "spacemolt", action: "get_location" },
  get_queue: { tool: "spacemolt", action: "get_queue" },
  get_ship: { tool: "spacemolt", action: "get_ship" },
  get_cargo: { tool: "spacemolt", action: "get_cargo" },
  get_nearby: { tool: "spacemolt", action: "get_nearby" },
  get_system: { tool: "spacemolt", action: "get_system" },
  get_skills: { tool: "spacemolt", action: "get_skills" },
  get_poi: { tool: "spacemolt", action: "get_poi" },
  get_base: { tool: "spacemolt", action: "get_base" },
  get_map: { tool: "spacemolt", action: "get_map" },
  get_version: { tool: "spacemolt", action: "get_version" },
  get_notifications: { tool: "spacemolt", action: "get_notifications" },
  get_commands: { tool: "spacemolt", action: "get_commands" },
  search_systems: { tool: "spacemolt", action: "search_systems" },
  find_route: { tool: "spacemolt", action: "find_route" },
  scan: { tool: "spacemolt", action: "scan" },
  // mission actions live on spacemolt
  get_missions: { tool: "spacemolt", action: "get_missions" },
  get_active_missions: { tool: "spacemolt", action: "get_active_missions" },
  accept_mission: { tool: "spacemolt", action: "accept_mission" },
  complete_mission: { tool: "spacemolt", action: "complete_mission" },
  decline_mission: { tool: "spacemolt", action: "decline_mission" },
  abandon_mission: { tool: "spacemolt", action: "abandon_mission" },
  completed_missions: { tool: "spacemolt", action: "completed_missions" },
  view_completed_mission: { tool: "spacemolt", action: "view_completed_mission" },
  // legacy alias agents still send
  missions: { tool: "spacemolt", action: "get_missions" },
  // market actions live on spacemolt_market (not spacemolt)
  view_market: { tool: "spacemolt_market", action: "view_market" },
  view_orders: { tool: "spacemolt_market", action: "view_orders" },
  estimate_purchase: { tool: "spacemolt_market", action: "estimate_purchase" },
  analyze_market: { tool: "spacemolt_market", action: "analyze_market" },
  create_sell_order: { tool: "spacemolt_market", action: "create_sell_order" },
  create_buy_order: { tool: "spacemolt_market", action: "create_buy_order" },
  cancel_order: { tool: "spacemolt_market", action: "cancel_order" },
  modify_order: { tool: "spacemolt_market", action: "modify_order" },
  // catalog: v2 tool is `spacemolt_catalog` and uses `type` not `action`.
  catalog: { tool: "spacemolt_catalog", action: "" },
  // storage namespace
  view_storage: { tool: "spacemolt_storage", action: "view" },
  view_faction_storage: { tool: "spacemolt_storage", action: "view_faction" },
  deposit_items: { tool: "spacemolt_storage", action: "deposit" },
  withdraw_items: { tool: "spacemolt_storage", action: "withdraw" },
  // battle namespace
  attack: { tool: "spacemolt_battle", action: "engage" },
  reload: { tool: "spacemolt_battle", action: "reload" },
  battle: { tool: "spacemolt_battle", action: "" }, // requires action in args
  get_battle_status: { tool: "spacemolt_battle", action: "status" },
  // salvage namespace
  get_wrecks: { tool: "spacemolt_salvage", action: "wrecks" },
  loot_wreck: { tool: "spacemolt_salvage", action: "loot" },
  salvage_wreck: { tool: "spacemolt_salvage", action: "salvage" },
  scrap_wreck: { tool: "spacemolt_salvage", action: "scrap" },
  tow_wreck: { tool: "spacemolt_salvage", action: "tow" },
  release_tow: { tool: "spacemolt_salvage", action: "release" },
  sell_wreck: { tool: "spacemolt_salvage", action: "sell" },
  buy_insurance: { tool: "spacemolt_salvage", action: "insure" },
  get_insurance_quote: { tool: "spacemolt_salvage", action: "quote" },
  // ship namespace
  commission_status: { tool: "spacemolt_ship", action: "commission_status" },
  commission_ship: { tool: "spacemolt_ship", action: "commission" },
  // social: captains_log_list/get/add are on spacemolt_social
  captains_log_list: { tool: "spacemolt_social", action: "captains_log_list" },
  captains_log_get: { tool: "spacemolt_social", action: "captains_log_get" },
  captains_log_add: { tool: "spacemolt_social", action: "captains_log_add" },
};

/**
 * Dispatch a v1-style tool call (flat name + flat args) against either a v1 or
 * v2 client. For v2 the call is rewritten to `client.execute(v2Tool, { action,
 * ...args })`; session_id is auto-injected by the v2 client itself.
 *
 * Tools not present in `V1_TO_V2_DISPATCH` fall back to passing the v1 name
 * through unchanged — matches v2 behavior for static tools that share names
 * (e.g. `spacemolt_pray`).
 */
export async function executeForClient(
  client: PassthroughClient,
  v1ToolName: string,
  args?: Record<string, unknown>,
  v2ToolHint?: string,
): Promise<{ result?: unknown; error?: { code?: unknown; message?: unknown } | null }> {
  const isV2 = typeof client.isV2 === "function" && client.isV2();
  if (!isV2) {
    return client.execute(v1ToolName, args);
  }

  // Prefer V1_TO_V2_DISPATCH when it has an entry — this catches agents that
  // called an action on the wrong consolidated tool (e.g. spacemolt(action=
  // "analyze_market") when analyze_market actually lives on spacemolt_market).
  // Fall back to v2ToolHint for v2-native action names that aren't in the
  // legacy dispatch map (e.g. spacemolt_storage(action="deposit")).
  const dispatch =
    V1_TO_V2_DISPATCH[v1ToolName] ??
    (v2ToolHint ? { tool: v2ToolHint, action: v1ToolName } : undefined);
  if (!dispatch) {
    // Unknown — pass through; the v2 client will surface a clear error from
    // the game server if the name really is unsupported.
    return client.execute(v1ToolName, args);
  }

  // Special case: catalog uses `type` not `action`.
  if (dispatch.tool === "spacemolt_catalog") {
    const { action: _drop, ...rest } = (args ?? {}) as Record<string, unknown>;
    return client.execute("spacemolt_catalog", rest);
  }

  // For "battle" (sub-actions like advance/retreat/stance/target), the caller
  // passes action via args.action — preserve it and translate args.
  if (dispatch.tool === "spacemolt_battle" && dispatch.action === "" && args?.action) {
    const subAction = String(args.action);
    const translated = translateV1ArgsToV2(subAction, args);
    return client.execute("spacemolt_battle", translated);
  }

  // Translate v1-style param names (e.g. target_system, wreck_id, module_id)
  // to v2-generic names (id, text) before dispatching. Only the `spacemolt`,
  // `spacemolt_battle`, `spacemolt_salvage`, and `spacemolt_ship` tools use
  // generic param names in v2; the rest (spacemolt_market, spacemolt_storage,
  // spacemolt_social) use v1-style explicit names (item_id, order_id, etc.)
  // and should NOT be translated — translation would rename `item_id` → `id`,
  // which v2 spacemolt_market/storage don't accept.
  //
  // Drop the agent-supplied `action` from the translated args before merging
  // with `dispatch.action`. Otherwise an agent-side typo (e.g. action="missions"
  // for an action that's actually `get_missions`) overrides the dispatch's
  // canonical action via spread semantics, sending the wrong action name to
  // the v2 game server.
  const TRANSLATE_TOOLS = new Set([
    "spacemolt",
    "spacemolt_battle",
    "spacemolt_salvage",
    "spacemolt_ship",
  ]);
  const shouldTranslate = TRANSLATE_TOOLS.has(dispatch.tool);
  const finalArgs = shouldTranslate
    ? translateV1ArgsToV2(dispatch.action, args)
    : { ...(args ?? {}) };
  const { action: _agentAction, ...argsNoAction } = finalArgs;
  // Per-action arg-name forgiveness: agents sometimes send v2-generic names
  // (id) on tools that expect v1-style explicit names (item_id). Rename
  // commonly-confused params before forwarding to the v2 game server.
  const renamed = applyV2ArgAliases(dispatch.action, argsNoAction);
  return client.execute(dispatch.tool, { action: dispatch.action, ...renamed });
}

/**
 * Agent-input → v2-game-server arg-name aliases. Only declared for actions
 * where agents commonly use the wrong param name despite explicit prompt
 * guidance. Applied AFTER translateV1ArgsToV2.
 */
const V2_AGENT_ARG_ALIASES: Record<string, Record<string, string>> = {
  // spacemolt_storage uses `item_id`; agents sometimes send `id`.
  deposit: { id: "item_id" },
  withdraw: { id: "item_id" },
};

function applyV2ArgAliases(
  action: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const aliases = V2_AGENT_ARG_ALIASES[action];
  if (!aliases) return args;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    const target = aliases[k] ?? k;
    // Don't clobber an explicit v2 name with an alias-renamed value.
    if (out[target] === undefined) out[target] = v;
  }
  return out;
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
      await executeForClient(client, "undock");
      await client.waitForTick();
    }
  }

  // --- 1c. market cache check (analyze_market only) ---
  // view_market is item_id-filtered — cache keyed by system:station would serve
  // stale data for the wrong item on back-to-back calls with different item_ids.
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

  // --- 1d. Auto-fill weapon id for reload ---
  // v1: ship.weapons[].instance_id → payload.weapon_instance_id
  // v2: ship.modules[] (from HttpGameClientV2 status parser) where slot
  //     contains "weapon" → payload.id (the v2 generic param name)
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

  // --- 1g. Idempotent state pre-flight checks for dock/undock ---
  // After a session restart, agents frequently fire dock/undock without
  // verifying state first, producing a flood of `already_docked` /
  // `already_undocked` errors. These are semantically no-ops — the agent's
  // desired state already holds. Return status=ok with a hint so the agent
  // moves on instead of treating it as a failure.
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

  // --- 2. Execute ---

  const skipLog = opts?.skipLogging === true;
  const pendingId = skipLog ? 0 : logToolCallStart(agentName, action, payload, { traceId });
  const completeLog = skipLog
    ? (() => {}) as typeof logToolCallComplete
    : logToolCallComplete;
  const toolStartMs = Date.now();
  try {
  const resp = await executeForClient(client, v1ToolName, payload, opts?.v2ToolHint);

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
    // Surface nav-cache staleness to the agent. The flag is set on resp.error
    // by the post-timeout refresh path above when the cache could not be
    // refreshed successfully — agents should call get_status before retrying.
    const navCacheStale = (resp.error as Record<string, unknown> | null | undefined)?._nav_cache_stale === true;
    const errorPayload: Record<string, unknown> = { error: errorMsg };
    if (navCacheStale) errorPayload._nav_cache_stale = true;
    return await withInjections(agentName, textResult(errorPayload));
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
