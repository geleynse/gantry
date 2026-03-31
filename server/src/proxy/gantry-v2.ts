/**
 * V2 MCP server factory — registers 6-15 consolidated tools using action-dispatch.
 *
 * Extracted from server.ts (createGantryServerV2). Uses shared handler modules
 * from Tasks 1-6 instead of inline implementations:
 *   - cached-queries.ts: STATUS_SLICE_EXTRACTORS
 *   - doc-tools.ts: handleWriteDiary, handleReadDiary, handleWriteDoc, handleReadDoc,
 *                   handleWriteReport, handleSearchMemory, handleRateMemory
 *   - public-tools.ts: handleGetGlobalMarket, handleFindLocalRoute
 *   - tool-registry.ts: handleGetEvents, handleGetSessionInfo, buildCompoundActions
 *   - passthrough-handler.ts: handlePassthrough
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createLogger } from "../lib/logger.js";
import packageJson from "../../package.json" with { type: "json" };

const log = createLogger("gantry-v2");
import * as z from "zod";
import { getConfig, type GantryConfig } from "../config.js";
import {
  V2_TO_V1_PARAM_MAP,
  serverSchemaToZod,
  type ServerTool,
} from "./schema.js";
import { persistBattleState } from "./cache-persistence.js";
import { resolvePoiId } from "./poi-resolver.js";
import { logToolCall, logToolCallStart, logToolCallComplete, logWsEvent, generateTraceId } from "./tool-call-logger.js";
import { getPendingOrders as dbGetPendingOrders, markDelivered as dbMarkDelivered } from "../services/comms-db.js";
import { getActiveDirectives as dbGetActiveDirectives } from "../services/directives.js";
import { getUnconsumedHandoff, consumeHandoff as dbConsumeHandoff, createHandoff } from "../services/handoff.js";
import * as pipelineModule from "./pipeline.js";
import type { PipelineContext } from "./pipeline.js";
import { InjectionRegistry, createDefaultInjections } from "./injection-registry.js";
import { waitForNavCacheUpdate as waitForNavCacheUpdateImpl, waitForDockCacheUpdate as waitForDockCacheUpdateImpl, type GameClientLike } from "./compound-tools-impl.js";
import { handleLogin, handleLogout } from "./auth-handlers.js";
import { STATUS_SLICE_EXTRACTORS } from "./cached-queries.js";
import {
  handleWriteDiary, handleReadDiary, handleWriteDoc, handleReadDoc,
  handleWriteReport, handleSearchMemory, handleRateMemory,
} from "./doc-tools.js";
import { handleGetGlobalMarket, handleFindLocalRoute } from "./public-tools.js";
import { handleGetEvents, handleGetSessionInfo, buildCompoundActions } from "./tool-registry.js";
import { handlePassthrough, type PassthroughDeps, textResult } from "./passthrough-handler.js";
import { getTracker as getRateLimitTracker } from "../services/rate-limit-tracker.js";
import { dispatchRoutine, isRoutineModeEnabled } from "../routines/routine-dispatch.js";
import { queueMessage as queueOutboundMessage, type ReviewPolicy } from "../services/outbound-review.js";
import { hasRoutine, getRoutineTools } from "../routines/routine-runner.js";
import type { SharedState } from "./server.js";
import type { AgentCallTracker } from "../shared/types.js";
import { STATE_CHANGING_TOOLS, CONTAMINATION_WORDS, stripPendingFields, throttledPersistGameState, reformatResponse } from "./proxy-constants.js";
import { TransitThrottle } from "./transit-throttle.js";
import { TransitStuckDetector } from "./transit-stuck-detector.js";
import { NavLoopDetector } from "./nav-loop-detector.js";
import { OverrideRegistry, BUILT_IN_RULES, createOverrideInjection } from "./override-system.js";
import { StateHintEngine, createStateHintInjection } from "./state-hints.js";
import { ResourceKnowledge, recordMarketResources } from "../services/resource-knowledge.js";
import { searchCatalog } from "../services/game-catalog.js";

// ---------------------------------------------------------------------------
// Rate limit tracking helper
// ---------------------------------------------------------------------------

/**
 * Wrap a GameClientLike so every execute() call is recorded in the rate limit
 * tracker. Used for compound tools, which call client.execute() directly and
 * would otherwise bypass the passthrough-handler tracking path.
 */
function makeTrackedClient(
  client: GameClientLike,
  agentName: string,
  tracker: { recordRequest(agent: string, tool: string, isRateLimit: boolean): void } | null | undefined,
): GameClientLike {
  if (!tracker) return client;
  return {
    execute: async (tool, args, opts) => {
      const resp = await client.execute(tool, args, opts);
      const code = resp.error ? String((resp.error as Record<string, unknown>).code ?? "") : "";
      tracker.recordRequest(agentName, tool, code === "429" || code === "rate_limited");
      return resp;
    },
    waitForTick: (ms) => client.waitForTick(ms),
    get lastArrivalTick() { return client.lastArrivalTick; },
    waitForNextArrival: client.waitForNextArrival?.bind(client),
  };
}

// ---------------------------------------------------------------------------
// V2SharedState
// ---------------------------------------------------------------------------

export interface V2SharedState extends SharedState {
  /** v2 tool names from the game server */
  v2Tools: string[];
  /** v2 tool descriptions from the game server */
  v2Descriptions: Map<string, string>;
  /** v2 full tool schemas from the game server (for building Zod schemas) */
  v2ToolSchemas: Map<string, ServerTool>;
}

// ---------------------------------------------------------------------------
// V2 action → v1 tool name mappings
// ---------------------------------------------------------------------------

export const V2_ACTION_TO_V1_NAME: Record<string, Record<string, string>> = {
  spacemolt_storage: {
    view: "view_storage",
    deposit: "deposit_items",
    withdraw: "withdraw_items",
  },
  spacemolt: {
    // get_status is intercepted by cached queries before reaching the guardrail
    get_player: "get_status", // common hallucination alias
    sell: "sell",
    buy: "buy",
    mine: "mine",
    refuel: "refuel",
    repair: "repair",
    dock: "dock",
    undock: "undock",
  },
  spacemolt_salvage: {
    wrecks: "get_wrecks",
    loot: "loot_wreck",
    salvage: "salvage_wreck",
    scrap: "scrap_wreck",
    tow: "tow_wreck",
    release: "release_tow",
    sell: "sell_wreck",
    quote: "get_insurance_quote",
    insure: "buy_insurance",
    policies: "claim_insurance",
    set_home: "set_home_base",
    status: "commission_status",
  },
  spacemolt_battle: {
    engage: "attack",
    status: "get_battle_status",
    reload: "reload",
    // advance, retreat, stance, target → v1 "battle" tool (handled below)
  },
  spacemolt_insurance: {
    quote: "get_insurance_quote",
    buy: "buy_insurance",
    claim: "claim_insurance",
  },
  spacemolt_facility: {
    faction_list: "faction_list",
    faction_build: "faction_build",
    faction_upgrade: "faction_upgrade",
    personal_build: "personal_build",
    types: "types",
    upgrades: "upgrades",
  },
};

// Actions that map to v1 "battle" tool with action kept as a param
const BATTLE_SUB_ACTIONS = new Set(["advance", "retreat", "stance", "target", "help"]);

// Generic v2 param names that may need remapping to v1 equivalents
const GENERIC_PARAMS = ["id", "text", "target", "content", "index"] as const;

// ---------------------------------------------------------------------------
// mapV2ToV1 — translate v2 tool+action to v1 tool name and args
// ---------------------------------------------------------------------------

export function mapV2ToV1(
  toolName: string,
  action: string,
  args: Record<string, unknown>,
  serverTool?: ServerTool,
): { v1ToolName: string; v1Args: Record<string, unknown> } {
  // Determine v1 tool name
  let v1ToolName: string;
  if (toolName === "spacemolt_catalog") {
    v1ToolName = "catalog";
  } else if (toolName === "spacemolt_battle" && BATTLE_SUB_ACTIONS.has(action)) {
    v1ToolName = "battle";
  } else if (V2_ACTION_TO_V1_NAME[toolName]?.[action]) {
    v1ToolName = V2_ACTION_TO_V1_NAME[toolName][action];
  } else {
    v1ToolName = action;
  }

  // Build v1 args — copy all except the dispatch key
  const v1Args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === "action") continue;
    // For catalog, keep "type" as a v1 param (don't strip it)
    if (toolName === "spacemolt_catalog" && key === "type") {
      v1Args.type = value;
      continue;
    }
    v1Args[key] = value;
  }

  // For battle sub-actions, pass the v2 action as the v1 "action" param
  if (toolName === "spacemolt_battle" && BATTLE_SUB_ACTIONS.has(action)) {
    v1Args.action = action;
  }

  // Storage tools are individual game commands (view_storage, deposit_items, withdraw_items)
  // — no action param needed since the tool name itself encodes the action

  // Apply v2→v1 parameter remapping
  // 1. Check for manual remap overrides first
  const manualRemap = V2_TO_V1_PARAM_MAP[action];
  if (manualRemap) {
    for (const [v2Param, v1Param] of Object.entries(manualRemap)) {
      if (v2Param in v1Args) {
        v1Args[v1Param] = v1Args[v2Param];
        if (v1Param !== v2Param) delete v1Args[v2Param];
      }
    }
  }

  // 2. Automated discovery mapping:
  // If the serverTool schema for this tool identifies which generic v2 param (id, text)
  // maps to which v1 param, use it. This uses the metadata provided by the server
  // when it generates the v2 consolidated tools.
  if (serverTool?.inputSchema?.properties) {
    const props = serverTool.inputSchema.properties;
    
    for (const generic of GENERIC_PARAMS) {
      if (!(generic in v1Args)) continue;

      // In the server's inputSchema for a v2 action, it often marks the original
      // v1 parameter name in the description or as an extension field.
      // The gameserver includes `x-spacemolt-v1-param` in the schema.
      const propDef = props[generic] as Record<string, unknown>;
      const v1ParamName = propDef?.["x-spacemolt-v1-param"] as string | undefined;
      
      if (v1ParamName && v1ParamName !== generic) {
        log.info(`[discovery] Auto-mapped v2 param "${generic}" to v1 "${v1ParamName}" for action "${action}"`);
        v1Args[v1ParamName] = v1Args[generic];
        delete v1Args[generic];
      }
    }
  }

  return { v1ToolName, v1Args };
}

// ---------------------------------------------------------------------------
// createGantryServerV2
// ---------------------------------------------------------------------------

/**
 * Create an MCP server instance for v2 consolidated tools.
 * Registers 6-15 v2 tools (depending on preset) instead of 60+ v1 tools.
 * Each v2 tool uses action-dispatch: the `action` param selects the behavior.
 *
 * The handler extracts the action, remaps v2 generic params to v1 specific params,
 * and calls the WebSocket game client with v1 tool names (WS only speaks v1).
 *
 * Proxy-defined tools (compound, cached, doc, events) are consolidated into
 * v2 actions in Step 5 — this step handles passthrough only.
 *
 * @param allowedTools - If provided, only register these tool names (advisory preset filtering, #214).
 *                       login/logout are always registered regardless of this list.
 *                       Unregistered tools are still handled by the proxy — they just
 *                       won't be advertised to the LLM.
 */
export function createGantryServerV2(config: GantryConfig, shared: V2SharedState, allowedTools?: Set<string>) {
  const sessions = shared.sessions.active;
  const registeredTools: string[] = [];

  // Per-agent routine lock: prevents normal tool calls from interleaving
  // with routine execution on the same GameClient WebSocket.
  // Maps agent name → { resolve } so waiting callers can be notified when routine completes.
  const agentRoutineLocks = new Map<string, { promise: Promise<void>; resolve: () => void }>();

  const sessionAgentMap = shared.sessions.agentMap;
  const statusCache = shared.cache.status;
  const battleCache = shared.cache.battle;
  const eventBuffers = shared.cache.events;
  const callTrackers = shared.proxy.callTrackers;
  const gameHealthRef = shared.proxy.gameHealthRef;
  const sellLog = shared.fleet.sellLog;
  const marketCache = shared.cache.market;

  // Build PipelineContext for shared pipeline functions
  const directivesCallCounters = new Map<string, number>();
  const injectionRegistry = new InjectionRegistry();
  for (const injection of createDefaultInjections()) {
    injectionRegistry.register(injection);
  }

  // Override system — high-priority condition-triggered interrupts (priority 5).
  // Use shared registry from SharedState so cooldowns persist across sessions.
  // Fall back to a new instance only in standalone mode (no shared state, e.g. tests).
  const overrideRegistry = shared?.proxy.overrideRegistry ?? new OverrideRegistry(BUILT_IN_RULES);
  injectionRegistry.register(createOverrideInjection(overrideRegistry));

  // State hints — proactive suggestions at low priority (priority 65)
  const stateHintEngine = new StateHintEngine();
  injectionRegistry.register(createStateHintInjection(stateHintEngine));

  // Resource knowledge — persisted cross-session resource location tracking
  const resourceKnowledge = new ResourceKnowledge();
  const pipelineCtx: PipelineContext = {
    config,
    sessionAgentMap,
    callTrackers,
    eventBuffers,
    battleCache,
    statusCache: shared.cache.status,
    callLimits: config.callLimits ?? {},
    sessionStore: shared.sessions.store,
    serverMetrics: shared.proxy.serverMetrics,
    getFleetPendingOrders: (agentName: string) => {
      try { return dbGetPendingOrders(agentName) as pipelineModule.FleetOrder[]; } catch { return []; }
    },
    markOrderDelivered: (orderId: number, agentName: string) => {
      try { dbMarkDelivered(orderId, agentName); } catch { /* non-fatal */ }
    },
    reformatResponse,
    getActiveDirectives: (agentName: string) => {
      try { return dbGetActiveDirectives(agentName); } catch { return []; }
    },
    directivesCallCounters,
    injectionRegistry,
    // Use shared transit throttle from SharedState so it persists across agent turns/sessions.
    // Fall back to a new instance only in standalone mode (no shared state, e.g. tests).
    transitThrottle: shared?.proxy.transitThrottle ?? new TransitThrottle(),
  };

  // Use shared transit stuck detector from SharedState so counter persists across sessions.
  // Fall back to a new instance only in standalone mode (no shared state, e.g. tests).
  const transitStuckDetector = shared?.proxy.transitStuckDetector ?? new TransitStuckDetector();

  // Use shared nav loop detector from SharedState so repeated travel_to calls are
  // detected across turns/sessions. Fall back to a new instance in tests.
  const navLoopDetector = shared?.proxy.navLoopDetector ?? new NavLoopDetector();

  // Thin wrappers so inner code can call with the same signatures as before
  function getAgentForSession(sessionId?: string): string | undefined {
    return pipelineModule.getAgentForSession(pipelineCtx, sessionId);
  }

  function getTracker(agentName: string): AgentCallTracker {
    return pipelineModule.getTracker(pipelineCtx, agentName);
  }

  function resetTrackerV2(agentName: string): void {
    pipelineModule.resetTracker(pipelineCtx, agentName);
  }

  /** Strip contaminated entries from captains_log_list responses. */
  function decontaminateLog(result: unknown): unknown {
    return pipelineModule.decontaminateLog(result, CONTAMINATION_WORDS);
  }

  /**
   * Check guardrails for a v2 tool:action call.
   * Delegates to pipeline.ts checkGuardrailsV2.
   */
  function checkGuardrails(agentName: string, toolName: string, action: string | undefined, args?: Record<string, unknown>, sessionId?: string): string | null {
    return pipelineModule.checkGuardrailsV2(pipelineCtx, agentName, toolName, action, args, sessionId);
  }

  async function withInjections(
    agentName: string,
    response: ReturnType<typeof textResult>,
  ): Promise<ReturnType<typeof textResult>> {
    return pipelineModule.withInjections(pipelineCtx, agentName, response, "v2");
  }

  /**
   * Wait for the status cache to show a different current_system than `beforeSystem`.
   * Delegates to the shared implementation in compound-tools-impl.ts.
   */
  async function waitForNavCacheUpdate(
    client: { waitForTick: (ms?: number) => Promise<void>; lastArrivalTick: number | null; waitForNextArrival?: (beforeTick: number | null, timeoutMs?: number) => Promise<boolean>; waitForTickToReach?: (targetTick: number, timeoutMs?: number) => Promise<boolean> },
    agentName: string,
    beforeSystem: unknown,
    maxTicks?: number,
    arrivalTickBeforeAction?: number | null,
  ): Promise<boolean> {
    return waitForNavCacheUpdateImpl(client, agentName, beforeSystem, statusCache, maxTicks, arrivalTickBeforeAction);
  }

  async function waitForDockCacheUpdate(
    client: { waitForTick: (ms?: number) => Promise<void> },
    agentName: string,
    maxTicks = 3,
  ): Promise<boolean> {
    return waitForDockCacheUpdateImpl(client, agentName, statusCache, maxTicks);
  }

  const mcpServer = new McpServer(
    { name: "gantry-v2", version: packageJson.version },
    { capabilities: { logging: {} } },
  );

  // --- Login / Logout (proxy-intercepted, delegates to auth-handlers.ts) ---

  // Build LoginDeps once — shared by login and logout
  const loginDepsV2 = {
    sessions,
    sessionStore: shared.sessions.store,
    sessionAgentMap,
    statusCache,
    battleCache,
    eventBuffers,
    callTrackers,
    config,
    throttledPersistGameState,
    persistBattleState,
    resetTracker: resetTrackerV2,
    logToolCall,
    logWsEvent,
    getUnconsumedHandoff,
    consumeHandoff: dbConsumeHandoff,
    createHandoff,
    marketReservations: shared.fleet.marketReservations,
    overseerEventLog: shared.fleet.overseerEventLog ?? null,
  };

  mcpServer.registerTool("login", {
    description: "Log in to SpaceMolt. Binds your session to an agent and reuses existing game sessions. Password is not required — the proxy account pool supplies credentials.",
    inputSchema: {
      username: z.string().describe("Agent username"),
      password: z.string().optional().describe("Agent password (optional — proxy account pool supplies this)"),
    },
  }, async ({ username, password }, extra) => {
    return handleLogin(loginDepsV2, extra.sessionId, username, password ?? "", "v2");
  });
  registeredTools.push("login");

  // --- Logout tool ---

  mcpServer.registerTool("logout", {
    description: "Log out of SpaceMolt.",
  }, async (extra) => {
    return handleLogout(loginDepsV2, extra.sessionId, "v2");
  });
  registeredTools.push("logout");

  // --- Build shared handler instances ---

  // Agent names for target filtering (shared with compound tools)
  const OUR_AGENT_NAMES_V2 = new Set(config.agents.map(a => a.name.replace(/-/g, " ").toLowerCase()));

  // Compound action dispatch table
  const compoundActions = buildCompoundActions(
    { statusCache, battleCache, sellLog, galaxyGraph: shared.fleet.galaxyGraphRef.current, eventBuffers: eventBuffers as Map<string, { events?: Array<{ type: string }> }> },
    OUR_AGENT_NAMES_V2,
  );

  // Passthrough deps
  const passthroughDeps: PassthroughDeps = {
    statusCache,
    marketCache,
    gameHealthRef,
    stateChangingTools: STATE_CHANGING_TOOLS,
    waitForNavCacheUpdate,
    waitForDockCacheUpdate,
    decontaminateLog,
    stripPendingFields,
    withInjections,
    galaxyGraph: shared.fleet.galaxyGraphRef.current,
    eventBuffers,
    marketReservations: shared.fleet.marketReservations,
    analyzeMarketCache: shared.fleet.analyzeMarketCache,
    recordActivity: (agentName: string) => sessions.recordActivity(agentName),
    rateLimitTracker: getRateLimitTracker() ?? undefined,
    resourceKnowledge,
  };

  // --- v2 consolidated tool registration ---

  for (const toolName of shared.v2Tools) {
    // login/logout are registered separately above (proxy-intercepted)
    if (toolName === "spacemolt_auth") {
      // Skip — login/logout already registered as standalone tools.
      // The game's spacemolt_auth tool has register/login/logout/claim actions,
      // but we handle login/logout as proxy tools and block register.
      continue;
    }

    // Advisory preset filtering: if allowedTools is set, only register tools in the list.
    // login/logout are always registered (handled above). This only filters game-server tools.
    if (allowedTools && !allowedTools.has(toolName)) {
      log.debug(`[preset-filter] skipping tool "${toolName}" — not in allowed preset`);
      continue;
    }

    const serverTool = shared.v2ToolSchemas.get(toolName);
    const description = shared.v2Descriptions.get(toolName) ?? `SpaceMolt v2 ${toolName}`;
    const zodSchema = serverTool ? serverSchemaToZod(serverTool) : z.object({}).passthrough();

    mcpServer.registerTool(toolName, {
      description,
      inputSchema: zodSchema,
    }, async (rawArgs: unknown, extra) => {
      const agentName = getAgentForSession(extra.sessionId);
      if (!agentName) return textResult({ error: "not logged in — call login first" });

      // Generate trace ID for request correlation
      const traceId = generateTraceId(agentName);

      const client = sessions.getClient(agentName);
      if (!client) return textResult({ error: "no session" });

      const args = (rawArgs ?? {}) as Record<string, unknown>;
      // Strip hallucinated parameters
      delete args.session_id;

      // For spacemolt_catalog, the dispatch key is `type`, not `action`
      let action = toolName === "spacemolt_catalog"
        ? (typeof args.type === "string" ? args.type : undefined)
        : (typeof args.action === "string" ? args.action : undefined);

      // Sanitize XML-contaminated action strings — models sometimes generate
      // XML parameter syntax inside the action value (e.g. 'find_route">\n<parameter...')
      if (action && (action.includes("<") || action.includes(">") || action.includes("\n"))) {
        const cleaned = action.split(/[<>\n"]/)[0].trim();
        if (cleaned && cleaned !== action) {
          log.warn(`[${agentName}] sanitized XML-contaminated action: "${action.slice(0, 60)}" → "${cleaned}" | trace: ${traceId}`);
          action = cleaned;
          if (toolName === "spacemolt_catalog") {
            args.type = cleaned;
          } else {
            args.action = cleaned;
          }
        }
      }

      const actionKey = action ? `${toolName}:${action}` : toolName;
      const argsSnippet = args ? Object.entries(args).filter(([k]) => k !== "action" && k !== "type").map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ").slice(0, 80) : "";
      log.info(`[${agentName}] ${actionKey}(${argsSnippet}) | trace: ${traceId}`);

      // Guardrails (v2-aware: includes action in dedup, limits, denials)
      const blocked = checkGuardrails(agentName, toolName, action, args, extra.sessionId);
      if (blocked) {
        // Transit throttle returns JSON (cached transit status) — return as normal data, not error.
        // This prevents agents from interpreting "THROTTLED" as an error and retrying.
        if (blocked.startsWith("{")) {
          try {
            const transitData = JSON.parse(blocked);
            return textResult(transitData);
          } catch { /* fall through to error */ }
        }
        log.info(`[${agentName}] BLOCKED ${actionKey} | trace: ${traceId} | reason: ${blocked.slice(0, 80)}`);
        return textResult({ error: blocked });
      }

      // --- Routine lock: wait silently while a routine is running ---
      const routineLock = agentRoutineLocks.get(agentName);
      if (routineLock && action !== "execute_routine") {
        log.debug(`[${agentName}] WAITING for routine to finish before ${actionKey} | trace: ${traceId}`);
        // Wait up to 5 minutes for the routine to complete instead of returning an error
        const ROUTINE_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
        const timeout = new Promise<void>((resolve) => setTimeout(resolve, ROUTINE_WAIT_TIMEOUT_MS));
        await Promise.race([routineLock.promise, timeout]);
        // If still locked after timeout, return error
        if (agentRoutineLocks.has(agentName)) {
          return textResult({ error: "A routine is still running after 5 minutes. Try again shortly." });
        }
        // Routine finished — tell agent to proceed with their intended action
        return textResult({ text: "A routine just completed. Your results are ready — call your intended action again." });
      }

      // --- Check for proxy-intercepted actions ---

      // Compound tools (spacemolt actions handled by proxy)
      if (toolName === "spacemolt" && action && action in compoundActions) {
        // Check for auto-trigger combat response (pirate_combat event for combat-role agents)
        const effectiveAction = pipelineModule.getAutoTriggerActionFromContext(pipelineCtx, agentName, action);

        // For multi_sell, inject _calledTools from tracker
        if (effectiveAction === "multi_sell") {
          args._calledTools = getTracker(agentName).calledTools;
        }

        // Execute the (possibly auto-triggered) compound tool
        const pendingId = logToolCallStart(
          agentName,
          effectiveAction,
          effectiveAction !== action ? { ...args, _original_action: action } : args,
          { isCompound: true, traceId },
        );
        const compoundStartMs = Date.now();
        log.info(`[${agentName}] compound ${effectiveAction} START | trace: ${traceId}`);
        let result: unknown;
        try {
          result = await compoundActions[effectiveAction](
            makeTrackedClient(client, agentName, passthroughDeps.rateLimitTracker),
            agentName,
            args,
          );
        } catch (err) {
          const elapsed = Date.now() - compoundStartMs;
          log.error(`[${agentName}] compound ${effectiveAction} THREW after ${elapsed}ms | trace: ${traceId}`, { error: String(err) });
          result = { error: `${effectiveAction} failed: ${err instanceof Error ? err.message : String(err)}. Try again or use a different approach.` };
        }
        log.info(`[${agentName}] compound ${effectiveAction} ${Date.now() - compoundStartMs}ms | trace: ${traceId}`);
        logToolCallComplete(
          pendingId,
          agentName,
          effectiveAction,
          result,
          Date.now() - compoundStartMs,
          { isCompound: true },
        );

        // Nav loop detection for travel_to — warn if agent is looping to same destination
        if (effectiveAction === "travel_to" && typeof result === "object" && result !== null) {
          const destination = args.destination as string | undefined;
          if (destination) {
            try {
              const { warning } = navLoopDetector.record(agentName, destination);
              if (warning) {
                (result as Record<string, unknown>)._nav_loop_warning = warning;
              }
            } catch { /* non-fatal */ }
          }
        }

        return await withInjections(agentName, textResult(result));
      }

      // Execute routine (spacemolt action="execute_routine")
      if (toolName === "spacemolt" && action === "execute_routine") {
        log.info(`[${agentName}] routine handler ENTERED | trace: ${traceId}`);
        const routineId = typeof args.id === "string" ? args.id : "";
        if (!routineId) { log.warn(`[${agentName}] routine REJECTED: no id | trace: ${traceId}`); return textResult({ error: "id (routine name) is required for execute_routine" }); }

        // Validate routine exists
        if (!hasRoutine(routineId)) {
          log.warn(`[${agentName}] routine REJECTED: unknown routine ${routineId} | trace: ${traceId}`);
          return textResult({ error: `Unknown routine: ${routineId}. Use one of: mining_loop, sell_cycle, refuel_repair, patrol_and_attack, mission_run, mission_check, navigate_and_mine, craft_and_sell, explore_system, salvage_loop, full_trade_run, supply_run, upgrade_ship` });
        }

        // Snapshot live config once for all pre-flight checks (hot-reload support)
        const liveConfig = getConfig();

        // Check routineMode is enabled for this agent
        if (!isRoutineModeEnabled(agentName, liveConfig)) {
          log.warn(`[${agentName}] routine REJECTED: routineMode disabled | trace: ${traceId}`);
          return textResult({ error: `Routine mode is not enabled for ${agentName}. Set routineMode: true in fleet-config.json.` });
        }

        // Block during active combat
        if (battleCache.get(agentName)) {
          log.warn(`[${agentName}] routine REJECTED: active combat | trace: ${traceId}`);
          return textResult({ error: "Cannot execute routine during active combat. Handle the battle first." });
        }

        // Block if dangerous events detected — agent should handle them first
        const agentEventBuf = eventBuffers.get(agentName);
        if (agentEventBuf?.hasEventOfType(["pirate_warning", "pirate_combat", "combat_update", "player_died", "respawn_state", "police_warning", "scan_detected"])) {
          log.warn(`[${agentName}] routine REJECTED: dangerous events | trace: ${traceId}`);
          return textResult({ error: "Dangerous event detected (combat/pirate/police/scan) — cannot start routine. Handle the situation first." });
        }

        // Pre-flight check: reject if the routine uses any denied tools for this agent
        const routineTools = getRoutineTools(routineId);
        if (routineTools) {
          const globalDenied = liveConfig.agentDeniedTools["*"] ?? {};
          const agentDenied = liveConfig.agentDeniedTools[agentName] ?? {};
          const blockedTools: string[] = [];
          for (const tool of routineTools) {
            if (tool in globalDenied || tool in agentDenied) {
              blockedTools.push(tool);
            }
          }
          if (blockedTools.length > 0) {
            log.warn(`[${agentName}] routine REJECTED: uses denied tools ${blockedTools.join(", ")} | trace: ${traceId}`);
            return textResult({ error: `Routine ${routineId} uses tools that are denied for you: ${blockedTools.join(", ")}. Choose a different routine or ask for the restriction to be lifted.` });
          }
        }

        // Parse params from text field (JSON string)
        let routineParams: Record<string, unknown> = {};
        if (typeof args.text === "string" && args.text.trim()) {
          try {
            routineParams = JSON.parse(args.text);
          } catch {
            return textResult({ error: `Invalid JSON in text param for routine ${routineId}: ${args.text}` });
          }
        }

        // Log start
        const pendingId = logToolCallStart(
          agentName,
          "execute_routine",
          { routine: routineId, params: routineParams },
          { isCompound: true, traceId },
        );
        const routineStartMs = Date.now();
        log.info(`[${agentName}] execute_routine:${routineId} START | trace: ${traceId}`);

        // Outer timeout: routine runner has its own 15min timeout, but if that
        // fails we don't want the agent's turn to hang forever.
        const ROUTINE_OUTER_TIMEOUT_MS = 20 * 60 * 1000; // 20 min (generous margin over runner's 15 min)

        // Set routine lock with a promise that resolves when routine completes
        let routineLockResolve: () => void;
        const routineLockPromise = new Promise<void>((resolve) => { routineLockResolve = resolve; });
        agentRoutineLocks.set(agentName, { promise: routineLockPromise, resolve: routineLockResolve! });

        // Keep session alive during long-running routines.
        // Without this, the idle timeout (5 min) kills the session mid-routine.
        const sessionKeepalive = setInterval(() => {
          if (shared.sessions.store) {
            shared.sessions.store.getSession(extra.sessionId ?? "");
          }
        }, 60_000);

        try {
          // Wrap the game client so routine sub-calls to compound tools
          // (travel_to, batch_mine, etc.) are routed through the proxy's
          // compound action handlers instead of the raw game server.
          const routineClient = {
            execute: async (tool: string, args?: Record<string, unknown>, opts?: { timeoutMs?: number; noRetry?: boolean }) => {
              if (tool in compoundActions) {
                const result = await compoundActions[tool](
                  makeTrackedClient(client, agentName, passthroughDeps.rateLimitTracker),
                  agentName,
                  args ?? {},
                );
                return { result };
              }
              // Route state-changing game tools through handlePassthrough so they get
              // tick-waits, dock verification, and other post-execution logic.
              // skipLogging: routine sub-calls are logged by logSubTool below
              // with the routine-namespaced name (routine:name:tool), avoiding duplicates.
              if (STATE_CHANGING_TOOLS.has(tool)) {
                const mcpResult = await handlePassthrough(
                  passthroughDeps, client, agentName, tool, tool,
                  args && Object.keys(args).length > 0 ? args : undefined,
                  undefined, traceId, { skipLogging: true },
                );
                // Extract the result from the MCP text response
                try {
                  const parsed = JSON.parse(mcpResult.content[0].text);
                  if (parsed.error) return { error: parsed.error };
                  return { result: parsed.result ?? parsed };
                } catch {
                  return { result: mcpResult.content[0].text };
                }
              }
              const resp = await client.execute(tool, args, opts);
              const code = resp.error ? String((resp.error as Record<string, unknown>).code ?? "") : "";
              passthroughDeps.rateLimitTracker?.recordRequest(agentName, tool, code === "429" || code === "rate_limited");
              return resp;
            },
            waitForTick: client.waitForTick.bind(client),
            lastArrivalTick: client.lastArrivalTick,
          };

          const routinePromise = dispatchRoutine(
            { name: routineId, params: routineParams },
            {
              client: routineClient,
              agentName,
              statusCache,
              battleCache,
              eventBuffers,
              logSubTool: (subToolName, subArgs, subResult, durationMs) => {
                logToolCall(agentName, subToolName, subArgs, subResult, durationMs, {
                  isCompound: false,
                  traceId,
                  parentId: pendingId,
                });
              },
            },
          );

          // Race against outer timeout
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Routine ${routineId} exceeded outer timeout (${ROUTINE_OUTER_TIMEOUT_MS / 1000}s)`)), ROUTINE_OUTER_TIMEOUT_MS),
          );

          const { result, formatted } = await Promise.race([routinePromise, timeoutPromise]);

          const durationMs = Date.now() - routineStartMs;
          log.info(`[${agentName}] execute_routine:${routineId} ${result.status} ${durationMs}ms | trace: ${traceId}`);
          logToolCallComplete(
            pendingId,
            agentName,
            "execute_routine",
            { routine: routineId, status: result.status, summary: result.summary },
            durationMs,
            { isCompound: true, success: result.status !== "error" },
          );

          return await withInjections(agentName, textResult({ text: formatted }));
        } catch (err) {
          const durationMs = Date.now() - routineStartMs;
          const errMsg = err instanceof Error ? err.message : String(err);
          log.error(`[${agentName}] execute_routine:${routineId} CRASH ${durationMs}ms | trace: ${traceId} | ${errMsg}`);
          logToolCallComplete(
            pendingId,
            agentName,
            "execute_routine",
            { error: errMsg },
            durationMs,
            { isCompound: true, success: false, errorCode: "routine_crash" },
          );
          return textResult({ error: `Routine ${routineId} crashed: ${errMsg}` });
        } finally {
          clearInterval(sessionKeepalive);
          // Release routine lock — notify waiting callers
          const lock = agentRoutineLocks.get(agentName);
          if (lock) {
            lock.resolve();
            agentRoutineLocks.delete(agentName);
          }
        }
      }

      // Cached queries (spacemolt actions from WebSocket state cache)
      if (toolName === "spacemolt" && action && action in STATUS_SLICE_EXTRACTORS) {
        const cacheStart = Date.now();
        const cached = statusCache.get(agentName);
        if (!cached) return textResult({ error: "no status data yet — login first" });
        const extracted = STATUS_SLICE_EXTRACTORS[action](cached.data);
        const staleness_seconds = Math.round((Date.now() - cached.fetchedAt) / 1000);
        const tick = cached.data.tick;
        let withRecency = typeof extracted === "object" && extracted !== null
          ? { ...extracted as Record<string, unknown>, _cache: { tick, staleness_seconds } }
          : extracted;

        // Transit stuck detection for get_location and get_status
        if (action === "get_location" || action === "get_status") {
          try {
            const { warning } = transitStuckDetector.record(agentName, action, extracted);
            if (warning && typeof withRecency === "object" && withRecency !== null) {
              withRecency = { ...withRecency as Record<string, unknown>, _transit_warning: warning };
            }
          } catch {
            // non-fatal
          }
        }

        logToolCall(agentName, action, args, withRecency, Date.now() - cacheStart, { traceId });
        log.info(`[${agentName}] ${action}() ${Date.now() - cacheStart}ms | trace: ${traceId}`);
        return await withInjections(agentName, textResult(withRecency));
      }

      // Event/session/public actions (spacemolt actions from proxy internals)
      if (toolName === "spacemolt" && action) {
        if (action === "get_events") {
          const eventStart = Date.now();
          const types = Array.isArray(args.text) ? args.text as string[] : undefined;
          const limit = typeof args.count === "number" ? args.count : undefined;
          const result = handleGetEvents(eventBuffers, agentName, types, limit);
          logToolCall(agentName, action, args, result, Date.now() - eventStart, { traceId });
          log.info(`[${agentName}] ${action}() | trace: ${traceId}`);
          return textResult(result);
        }
        if (action === "get_session_info") {
          const result = handleGetSessionInfo(config, sessions, agentName);
          return textResult(result);
        }
        if (action === "get_global_market") {
          const itemName = typeof args.id === "string" ? args.id : undefined;
          const result = handleGetGlobalMarket(marketCache, itemName);
          return textResult(result);
        }
        if (action === "find_local_route") {
          const fromStr = String(args.id ?? "");
          const toStr = String(args.text ?? "");
          if (!fromStr || !toStr) return textResult({ error: "id (from_system) and text (to_system) are required for find_local_route" });
          const result = handleFindLocalRoute(shared.fleet.galaxyGraphRef.current, fromStr, toStr);
          return textResult(result);
        }
      }

      // Doc tools (spacemolt_social actions from proxy SQLite)
      if (toolName === "spacemolt_social" && action) {
        const docStart = Date.now();
        let result: unknown;
        const otherAgents = config.agents.map(a => a.name).filter(n => n !== agentName);

        switch (action) {
          case "write_diary": {
            const importance = typeof args.importance === "number" ? args.importance : undefined;
            result = handleWriteDiary(agentName, String(args.content ?? ""), CONTAMINATION_WORDS, undefined, importance);
            break;
          }
          case "read_diary":
            result = handleReadDiary(agentName, typeof args.count === "number" ? args.count : 5);
            break;
          case "write_doc": {
            const docImportance = typeof args.importance === "number" ? args.importance : undefined;
            result = handleWriteDoc(
              agentName,
              String(args.title ?? ""),
              String(args.content ?? ""),
              String(args.mode ?? "overwrite"),
              CONTAMINATION_WORDS,
              undefined,
              docImportance,
            );
            break;
          }
          case "read_doc":
            result = handleReadDoc(agentName, String(args.title ?? ""));
            break;
          case "write_report":
            result = handleWriteReport(agentName, String(args.content ?? ""));
            break;
          case "search_memory": {
            const query = String(args.content ?? args.text ?? "");
            const limit = typeof args.count === "number" ? args.count : 20;
            const targetAgentArg = args.id ? String(args.id) : undefined;
            if (!query) { result = { error: "search_memory requires content (search query)" }; break; }
            result = handleSearchMemory(agentName, query, limit, targetAgentArg, otherAgents);
            break;
          }
          case "rate_memory": {
            const memId = typeof args.id === "number" ? args.id : Number(args.id);
            const memImportance = typeof args.importance === "number" ? args.importance : Number(args.importance ?? 0);
            const memTable = args.table === "docs" ? "docs" as const : "diary" as const;
            result = handleRateMemory(memId, memImportance, memTable);
            break;
          }
          // Forum and chat outbound review interception
          case "forum_create_thread":
          case "forum_reply":
          case "forum_post": {
            const forumPolicy: ReviewPolicy = (getConfig().outbound?.forum ?? "require_approval");
            if (forumPolicy === "disabled") {
              result = { error: "Forum posting is disabled for this fleet." };
              break;
            }
            // Rate limit: max 1 new thread per session
            if (action === "forum_create_thread" || action === "forum_post") {
              const tracker = shared.proxy.callTrackers.get(agentName);
              const postCount = (tracker?.counts?.["forum_create_thread"] ?? 0) + (tracker?.counts?.["forum_post"] ?? 0);
              if (postCount > 1) {
                result = { error: "Rate limit: 1 new forum thread per session. Write in your diary instead." };
                break;
              }
            }
            const forumContent = String(args.content ?? args.body ?? args.text ?? "");
            const forumMeta: Record<string, unknown> = {
              v1_action: action === "forum_post" ? "forum_create_thread" : action,
              v1_params: { ...args },
            };
            if (forumPolicy === "require_approval") {
              queueOutboundMessage({ agentName, channel: "forum", content: forumContent, metadata: forumMeta });
              result = { status: "ok", message: "Post submitted successfully." };
              break;
            }
            // auto_approve_with_log: log it, don't set result → falls through to passthrough
            queueOutboundMessage({ agentName, channel: "forum", content: forumContent, metadata: forumMeta, status: "auto_approved" });
            break; // result stays undefined → falls through to passthrough
          }
          case "chat": {
            const chatPolicy: ReviewPolicy = (getConfig().outbound?.chat ?? "require_approval");
            if (chatPolicy === "disabled") {
              result = { error: "Chat is disabled for this fleet." };
              break;
            }
            const chatContent = String(args.content ?? args.message ?? args.text ?? "");
            const chatMeta: Record<string, unknown> = {
              v1_action: "chat",
              v1_params: { ...args },
            };
            if (chatPolicy === "require_approval") {
              queueOutboundMessage({ agentName, channel: "chat", content: chatContent, metadata: chatMeta });
              result = { status: "ok", message: "Chat message submitted." };
              break;
            }
            // auto_approve_with_log: log it, don't set result → falls through to passthrough
            queueOutboundMessage({ agentName, channel: "chat", content: chatContent, metadata: chatMeta, status: "auto_approved" });
            break; // result stays undefined → falls through to passthrough
          }
          default:
            // Unknown social action — fall through to passthrough below
            break;
        }

        if (result !== undefined) {
          logToolCall(agentName, action, args, result, Date.now() - docStart, { traceId });
          const docArgsStr = args.content
            ? `content="${String(args.content).slice(0, 60)}..."`
            : (args.title ? `title="${args.title}"` : "");
          log.info(`[${agentName}] ${action}(${docArgsStr}) ${Date.now() - docStart}ms | trace: ${traceId}`);
          return await withInjections(agentName, textResult(result));
        }
      }

      // --- Passthrough to game server via WebSocket (v2→v1 translation) ---

      if (!action) {
        return textResult({ error: `Missing required parameter: ${toolName === "spacemolt_catalog" ? "type" : "action"}` });
      }

      const { v1ToolName, v1Args } = mapV2ToV1(toolName, action, args, serverTool);

      // Guard against unknown/hallucinated actions
      // By this point all proxy-handled actions (compound, cached, doc, event, routine)
      // have been checked. If v1ToolName isn't a known game tool, it's likely hallucinated.
      const gameTools = shared.proxy.gameTools;
      if (gameTools.length > 0 && !gameTools.includes(v1ToolName)) {
        // Build a list of valid actions for this v2 tool from the schema enum
        const actionProp = serverTool?.inputSchema?.properties?.action as { enum?: string[] } | undefined;
        const validActions = actionProp?.enum ?? Object.keys(V2_ACTION_TO_V1_NAME[toolName] ?? {});
        const suggestion = validActions.length > 0
          ? ` Valid actions for ${toolName}: ${validActions.slice(0, 15).join(", ")}${validActions.length > 15 ? ` (+${validActions.length - 15} more)` : ""}.`
          : "";
        log.warn(`[${agentName}] BLOCKED unknown action "${action}" → v1 "${v1ToolName}" not in gameTools | trace: ${traceId}`);
        // Include usage examples for common tools to help agents self-correct
        let usageHint = "";
        if (toolName === "spacemolt_storage") {
          usageHint = ' Example: spacemolt_storage(action="deposit", item_id="iron_ore", quantity=10). Required params: item_id and quantity for deposit/withdraw.';
        }
        return textResult({ error: `Unknown action "${action}" for ${toolName} — no matching game command.${suggestion}${usageHint} Use spacemolt(action="help") for full list.` });
      }

      // Resolve POI name to ID for passthrough v2 travel calls
      if (action === "travel" && v1Args.target_poi && typeof v1Args.target_poi === "string") {
        const resolved = resolvePoiId(agentName, v1Args.target_poi, statusCache);
        if (resolved !== v1Args.target_poi) {
          log.info(`[${agentName}] v2 passthrough travel resolved POI: "${v1Args.target_poi}" → "${resolved}"`);
          v1Args.target_poi = resolved;
        }
      }

      const payload = Object.keys(v1Args).length > 0 ? v1Args : undefined;
      const navDest = payload?.target_system ?? payload?.target_poi;

      return handlePassthrough(passthroughDeps, client, agentName, action, v1ToolName, payload, navDest, traceId);
    });
    registeredTools.push(toolName);
  }

  // --- Proxy-defined tool: query_known_resources ---
  // Agents can ask "where have we seen iron?" — queries the persisted resource knowledge DB.
  mcpServer.registerTool("query_known_resources", {
    description: "Query fleet knowledge of resource locations. Search by resource name or system. Returns known prices and quantities from previous market scans.",
    inputSchema: {
      resource: z.string().optional().describe("Resource/item ID to search for (e.g. 'iron_ore')"),
      system: z.string().optional().describe("System to list all known resources in"),
    },
  }, async ({ resource, system }: { resource?: string; system?: string }, extra) => {
    const agentName = getAgentForSession(extra.sessionId);
    if (!agentName) return textResult({ error: "not logged in" });

    if (resource) {
      const locations = resourceKnowledge.query(resource);
      const bestBuy = resourceKnowledge.getBestPrice(resource);
      const bestSell = resourceKnowledge.getBestSellPrice(resource);
      return textResult({
        resource,
        locations: locations.slice(0, 20),
        best_buy_price: bestBuy,
        best_sell_price: bestSell,
        total_locations: locations.length,
      });
    }

    if (system) {
      const resources = resourceKnowledge.querySystem(system);
      return textResult({
        system,
        resources: resources.slice(0, 50),
        total_resources: resources.length,
      });
    }

    // No filter — list all known resources
    const allResources = resourceKnowledge.listResources();
    return textResult({
      known_resources: allResources.slice(0, 100),
      total: allResources.length,
    });
  });
  registeredTools.push("query_known_resources");

  // --- Proxy-defined tool: query_catalog ---
  // Agents can look up item stats, recipe inputs, and ship specs without hitting the game API.
  mcpServer.registerTool("query_catalog", {
    description: "Search the game item/recipe/ship catalog. Look up item stats, crafting recipes, or ship specs by name, ID, or type.",
    inputSchema: {
      type: z.enum(["item", "recipe", "ship", "all"]).describe("Type of catalog entry to search"),
      search: z.string().optional().describe("Name or partial name to search for"),
      id: z.string().optional().describe("Exact item/recipe/ship ID to look up"),
    },
  }, ({ type, search, id }: { type: "item" | "recipe" | "ship" | "all"; search?: string; id?: string }) => {
    const results = searchCatalog(type, search, id, 50);
    const total = results.items.length + results.recipes.length + results.ships.length;
    return textResult({ ...results, total });
  });
  registeredTools.push("query_catalog");

  return { mcpServer, sessions, registeredTools, sessionAgentMap, eventBuffers, callTrackers, overrideRegistry };
}
