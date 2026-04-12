import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import packageJson from "../../package.json" with { type: "json" };
import type { GantryConfig } from "../config.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore } from "./session-store.js";
import { EventBuffer } from "./event-buffer.js";
import { generateInstabilityHint, checkToolBlocked } from "./instability-hints.js";
import { summarizeToolResult } from "./summarizers.js";
import { addErrorHint } from "./error-hints.js";
import { MarketCache } from "./market-cache.js";
import { ArbitrageAnalyzer } from "./arbitrage-analyzer.js";
import { MarketReservationCache } from "./market-reservations.js";
import { AnalyzeMarketCache } from "./analyze-market-cache.js";
import { SellLog } from "./sell-log.js";
import { GalaxyGraph } from "./pathfinder.js";
import {
  DENIED_ACTIONS_V2, V2_TO_V1_PARAM_MAP,
  serverSchemaToZod,
  type ServerTool,
} from "./schema.js";
import { persistBattleState } from "./cache-persistence.js";
import type { BattleState, AgentCallTracker } from "../shared/types.js";
export type { BattleState, AgentCallTracker } from "../shared/types.js";
import type { FleetCoordinator } from "../services/coordinator.js";
import type { OverseerEventLog } from "../services/overseer-event-log.js";
import { enrichWithGlobalContext } from "./market-enrichment.js";
import { BreakerRegistry } from "./circuit-breaker.js";
import { MetricsWindow } from "./instability-metrics.js";
import {
  STATE_CHANGING_TOOLS,
  CONTAMINATION_WORDS,
  stripPendingFields,
  throttledPersistGameState,
  reformatResponse,
} from "./proxy-constants.js";
import { resolvePoiId, cacheSystemPois } from "./poi-resolver.js";
import { logToolCall, logWsEvent } from "./tool-call-logger.js";
import { getPendingOrders as dbGetPendingOrders, markDelivered as dbMarkDelivered, createOrder, createReport } from "../services/comms-db.js";
import { getActiveDirectives as dbGetActiveDirectives } from "../services/directives.js";
import { getUnconsumedHandoff, consumeHandoff as dbConsumeHandoff, createHandoff } from "../services/handoff.js";
import { addDiaryEntry, getRecentDiary, getNote, upsertNote, appendNote, searchAgentMemory, searchFleetMemory } from "../services/notes-db.js";
import { parseReport } from "../services/report-parser.js";
import * as pipelineModule from "./pipeline.js";
import type { PipelineContext } from "./pipeline.js";
import { InjectionRegistry, createDefaultInjections } from "./injection-registry.js";
import {
  batchMine, travelTo, jumpRoute, multiSell, scanAndAttack, battleReadiness, lootWrecks,
  waitForNavCacheUpdate as waitForNavCacheUpdateImpl,
  waitForDockCacheUpdate as waitForDockCacheUpdateImpl,
} from "./compound-tools-impl.js";
import { handleLogin, handleLogout } from "./auth-handlers.js";
import { registerDocTools } from "./doc-tools.js";
import { registerCachedQueries } from "./cached-queries.js";
import { registerPublicTools } from "./public-tools.js";
import { registerPassthroughTools, registerCompoundTools } from "./tool-registry.js";
import { textResult } from "./passthrough-handler.js";
import { TransitThrottle } from "./transit-throttle.js";
import { TransitStuckDetector } from "./transit-stuck-detector.js";

interface FleetOrder {
  id: number;
  message: string;
  priority: string;
}

function getFleetPendingOrders(agentName: string): FleetOrder[] {
  try {
    return dbGetPendingOrders(agentName) as FleetOrder[];
  } catch {
    return []; // db error — non-fatal
  }
}

function markOrderDelivered(orderId: number, agentName: string): void {
  try {
    dbMarkDelivered(orderId, agentName);
  } catch { /* non-fatal */ }
}

// Static fallback list — used when game server is unreachable at startup
export const STATIC_GAME_TOOLS = [
  "login", "logout",
  "captains_log_list", "captains_log_add",
  "get_cargo", "get_system",
  "mine", "travel", "jump", "dock", "undock", "refuel", "repair",
  "sell", "buy", "deposit_items", "withdraw_items",
  "create_sell_order", "create_buy_order", "cancel_order", "modify_order", "view_orders",
  "craft",
  "get_missions", "accept_mission", "complete_mission", "get_active_missions", "decline_mission", "abandon_mission",
  "view_market", "view_storage", "estimate_purchase",
  "scan", "survey_system", "search_systems", "get_nearby", "get_map", "get_poi", "find_route",
  "attack", "battle", "get_battle_status", "get_wrecks", "loot_wreck", "salvage_wreck", "sell_wreck", "scrap_wreck", "tow_wreck", "release_tow",
  "cloak",
  "buy_ship", "sell_ship", "list_ships", "switch_ship", "get_ship",
  "shipyard_showroom", "commission_ship", "commission_quote", "claim_commission", "commission_status", "cancel_commission", "supply_commission", "browse_ships", "buy_listed_ship", "list_ship_for_sale", "cancel_ship_listing",
  "install_mod", "uninstall_mod",
  "analyze_market", "get_base", "use_item", "send_gift", "claim",
  "get_insurance_quote", "buy_insurance", "claim_insurance", "reload", "set_home_base",
  "chat", "get_chat_history",
  "forum_list", "forum_get_thread", "forum_create_thread", "forum_reply", "forum_upvote",
  "trade_offer", "trade_accept", "trade_decline", "trade_cancel", "get_trades",
  "get_skills", "help", "catalog", "get_guide",
];

interface GameHealth {
  tick: number;
  version: string;
  fetchedAt: number;
  estimatedNextTick: string | null; // RFC3339 UTC timestamp
}

/** Mutable container so polled health data is visible across closures. */
export interface GameHealthRef {
  current: GameHealth | null;
}

export interface SharedState {
  sessions: {
    active: SessionManager;
    store: SessionStore;
    agentMap: Map<string, string>;
  };
  cache: {
    status: Map<string, { data: Record<string, unknown>; fetchedAt: number }>;
    battle: Map<string, BattleState | null>;
    market: MarketCache;
    events: Map<string, EventBuffer>;
  };
  proxy: {
    gameTools: string[];
    serverDescriptions: Map<string, string>;
    gameHealthRef: GameHealthRef;
    callTrackers: Map<string, AgentCallTracker>;
    breakerRegistry: BreakerRegistry;
    serverMetrics: MetricsWindow;
    /** Shared transit throttle — persists across agent turns/sessions. */
    transitThrottle: import("./transit-throttle.js").TransitThrottle;
    /** Shared transit stuck detector — counter persists across sessions. */
    transitStuckDetector: import("./transit-stuck-detector.js").TransitStuckDetector;
    /** Shared nav loop detector — tracks repeated travel_to destinations per agent. */
    navLoopDetector: import("./nav-loop-detector.js").NavLoopDetector;
    /** Shared override registry — condition-triggered directives, persists cooldowns across sessions. */
    overrideRegistry: import("./override-system.js").OverrideRegistry;
  };
  fleet: {
    galaxyGraphRef: { current: GalaxyGraph };
    sellLog: SellLog;
    arbitrageAnalyzer: ArbitrageAnalyzer;
    coordinator: FleetCoordinator | null;
    marketReservations: MarketReservationCache;
    analyzeMarketCache: AnalyzeMarketCache;
    overseerEventLog: OverseerEventLog | null;
  };
}

export function createGantryServer(config: GantryConfig, shared?: SharedState) {
  const breakerRegistry = shared?.proxy.breakerRegistry ?? new BreakerRegistry();
  const serverMetrics = shared?.proxy.serverMetrics ?? new MetricsWindow();
  const sessions = shared?.sessions.active ?? new SessionManager(config, breakerRegistry, serverMetrics);
  const sessionStore = shared?.sessions.store ?? new SessionStore();
  const registeredTools: string[] = [];

  const sessionAgentMap = shared?.sessions.agentMap ?? new Map<string, string>();
  const statusCache = shared?.cache.status ?? new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
  const eventBuffers = shared?.cache.events ?? new Map<string, EventBuffer>();
  const callTrackers = shared?.proxy.callTrackers ?? new Map<string, AgentCallTracker>();
  const battleCache = shared?.cache.battle ?? new Map<string, BattleState | null>();
  const marketCache = shared?.cache.market ?? new MarketCache();
  const arbitrageAnalyzer = shared?.fleet.arbitrageAnalyzer ?? new ArbitrageAnalyzer();
  const galaxyGraph = shared?.fleet.galaxyGraphRef?.current ?? new GalaxyGraph();
  const gameTools = shared?.proxy.gameTools ?? STATIC_GAME_TOOLS;
  const serverDescriptions = shared?.proxy.serverDescriptions ?? new Map<string, string>();
  const gameHealthRef = shared?.proxy.gameHealthRef ?? { current: null };
  const sellLog = shared?.fleet.sellLog ?? new SellLog();
  const marketReservations = shared?.fleet.marketReservations ?? new MarketReservationCache();
  const analyzeMarketCache = shared?.fleet.analyzeMarketCache ?? new AnalyzeMarketCache();

  // Build PipelineContext for shared pipeline functions
  const directivesCallCounters = new Map<string, number>();
  const injectionRegistry = new InjectionRegistry();
  for (const injection of createDefaultInjections()) {
    injectionRegistry.register(injection);
  }
  const pipelineCtx: PipelineContext = {
    config,
    sessionAgentMap,
    callTrackers,
    eventBuffers,
    battleCache,
    statusCache,
    callLimits: config.callLimits ?? {},
    serverMetrics,
    getFleetPendingOrders: (agentName: string) => getFleetPendingOrders(agentName) as pipelineModule.FleetOrder[],
    markOrderDelivered,
    reformatResponse,
    getActiveDirectives: (agentName: string) => {
      try { return dbGetActiveDirectives(agentName); } catch { return []; }
    },
    directivesCallCounters,
    injectionRegistry,
    // Use shared transit throttle from SharedState so it persists across agent turns/sessions.
    // Fall back to a new instance only in standalone mode (no shared state, e.g. tests).
    transitThrottle: shared?.proxy.transitThrottle ?? new TransitThrottle(),
    shutdownWarningFired: new Set<string>(),
  };

  const transitStuckDetector = new TransitStuckDetector();

  // Thin wrappers so inner code can call with the same signatures as before
  function getAgentForSession(sessionId?: string): string | undefined {
    return pipelineModule.getAgentForSession(pipelineCtx, sessionId);
  }

  function getTracker(agentName: string): AgentCallTracker {
    return pipelineModule.getTracker(pipelineCtx, agentName);
  }

  function resetTrackerLocal(agentName: string): void {
    pipelineModule.resetTracker(pipelineCtx, agentName);
  }

  function checkGuardrails(agentName: string, toolName: string, args?: Record<string, unknown>): string | null {
    return pipelineModule.checkGuardrailsV1(pipelineCtx, agentName, toolName, args);
  }

  async function withInjections(
    agentName: string,
    response: ReturnType<typeof textResult>,
  ): Promise<ReturnType<typeof textResult>> {
    return pipelineModule.withInjections(pipelineCtx, agentName, response);
  }

  /** Strip contaminated entries from captains_log_list responses. */
  function decontaminateLog(result: unknown): unknown {
    return pipelineModule.decontaminateLog(result, CONTAMINATION_WORDS);
  }

  /**
   * Wait for the status cache to reflect a system change after a jump.
   * Delegates to the shared implementation in compound-tools-impl.ts.
   */
  async function waitForNavCacheUpdate(
    client: { waitForTick: (ms?: number) => Promise<void>; lastArrivalTick: number | null; waitForNextArrival?: (beforeTick: number | null, timeoutMs?: number) => Promise<boolean> },
    agentName: string,
    beforeSystem: unknown,
    maxTicks?: number,
    arrivalTickBeforeAction?: number | null,
  ): Promise<boolean> {
    return waitForNavCacheUpdateImpl(client, agentName, beforeSystem, statusCache, maxTicks, arrivalTickBeforeAction);
  }

  /**
   * Wait for the status cache to reflect a docking change.
   * Delegates to the shared implementation in compound-tools-impl.ts.
   */
  async function waitForDockCacheUpdate(
    client: { waitForTick: (ms?: number) => Promise<void> },
    agentName: string,
    maxTicks = 3,
  ): Promise<boolean> {
    return waitForDockCacheUpdateImpl(client, agentName, statusCache, maxTicks);
  }

  const mcpServer = new McpServer(
    { name: "gantry", version: packageJson.version },
    { capabilities: { logging: {} } },
  );

  // --- Login (special: binds MCP session to agent, reuses game session) ---

  // Build LoginDeps once — shared by login and logout
  const loginDeps = {
    sessions,
    sessionStore,
    sessionAgentMap,
    statusCache,
    battleCache,
    eventBuffers,
    callTrackers,
    config,
    throttledPersistGameState,
    persistBattleState,
    resetTracker: resetTrackerLocal,
    logToolCall,
    logWsEvent,
    getUnconsumedHandoff,
    consumeHandoff: dbConsumeHandoff,
    createHandoff,
    marketReservations,
    overseerEventLog: shared?.fleet.overseerEventLog ?? null,
  };

  mcpServer.registerTool("login", {
    description: "Log in to SpaceMolt. Binds your session to an agent and reuses existing game sessions. Password is not required — the proxy account pool supplies credentials.",
    inputSchema: {
      username: z.string().describe("Agent username"),
      password: z.string().optional().describe("Agent password (optional — proxy account pool supplies this)"),
    },
  }, async ({ username, password }, extra) => {
    return handleLogin(loginDeps, extra.sessionId, username, password ?? "", "v1");
  });
  registeredTools.push("login");

  // --- Logout ---

  mcpServer.registerTool("logout", {
    description: "Log out of SpaceMolt.",
  }, async (extra) => {
    return handleLogout(loginDeps, extra.sessionId, "v1");
  });
  registeredTools.push("logout");

  // --- v1 tool registrations (passthrough + compound + events + utility) ---
  const toolRegistryDeps = {
    mcpServer, registeredTools, config, sessions,
    statusCache, battleCache, callTrackers, marketCache, galaxyGraph,
    sellLog, gameTools, serverDescriptions, gameHealthRef, eventBuffers,
    stateChangingTools: STATE_CHANGING_TOOLS,
    getAgentForSession, getTracker, checkGuardrails, withInjections,
    waitForNavCacheUpdate, waitForDockCacheUpdate, decontaminateLog, stripPendingFields,
    marketReservations,
    analyzeMarketCache,
    navLoopDetector: shared?.proxy.navLoopDetector,
  };
  registerPassthroughTools(toolRegistryDeps);

  // --- Cached status queries ---
  registerCachedQueries({
    mcpServer, registeredTools, statusCache,
    getAgentForSession, withInjections,
    transitStuckDetector,
  });

  registerCompoundTools(toolRegistryDeps);

  // --- Doc tools (stored in fleet-web SQLite) ---
  registerDocTools({
    mcpServer, registeredTools, config,
    getAgentForSession, withInjections,
    contaminationWords: CONTAMINATION_WORDS,
  });

  // --- Public API tools (no game server call, served from cached public data) ---
  registerPublicTools({
    mcpServer, registeredTools, marketCache, arbitrageAnalyzer, galaxyGraph, getAgentForSession,
  });


  return { mcpServer, sessions, registeredTools, sessionAgentMap, eventBuffers, callTrackers };
}

// --- v2 MCP server factory (extracted to gantry-v2.ts) ---

export { createMcpServer } from "./mcp-factory.js";

// Re-export v2 factory and types from extracted module
export { createGantryServerV2, type V2SharedState } from "./gantry-v2.js";

// Re-export proxy constants for backward compatibility (consumers that import from server.ts)
export { STATE_CHANGING_TOOLS, CONTAMINATION_WORDS, stripPendingFields, throttledPersistGameState, reformatResponse } from "./proxy-constants.js";
