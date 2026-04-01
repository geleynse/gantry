/**
 * MCP server factory — creates the Express router with MCP transport handling.
 * Wires schema fetching, shared state, health polling, session management,
 * and v1/v2 MCP endpoints.
 */

// ---------------------------------------------------------------------------
// Tool name sanitization
// ---------------------------------------------------------------------------

/**
 * Sanitize a tool name by stripping XML/HTML artifact suffixes that AI clients
 * occasionally append (e.g. `logout" />` → `logout`).
 *
 * Returns `{ name, sanitized }` where `sanitized` is true when the name changed.
 */
export function sanitizeToolName(raw: string): { name: string; sanitized: boolean } {
  // Strip trailing XML/HTML self-closing tag artifacts: `" />`, `/>`, `">`, trailing `"` or `'`
  // Pattern covers: `mcp__gantry__logout" />` → `mcp__gantry__logout`
  const cleaned = raw
    .replace(/\s*"\s*\/>\s*$/, "")   // trailing " />
    .replace(/\s*\/>\s*$/, "")       // trailing />
    .replace(/\s*">\s*$/, "")        // trailing ">
    .replace(/['"]\s*$/, "")         // trailing " or '
    .trim();
  return { name: cleaned, sanitized: cleaned !== raw };
}

/**
 * Mutate a JSON-RPC request body in-place to sanitize tool names.
 * Only acts on tools/call requests.
 * Returns the original (raw) name if sanitization occurred, or null otherwise.
 */
function sanitizeToolCallBody(body: unknown): string | null {
  if (
    body &&
    typeof body === "object" &&
    (body as Record<string, unknown>).method === "tools/call"
  ) {
    const params = (body as Record<string, unknown>).params as Record<string, unknown> | undefined;
    if (params && typeof params.name === "string") {
      const { name, sanitized } = sanitizeToolName(params.name);
      if (sanitized) {
        const rawName = params.name;
        params.name = name;
        return rawName;
      }
    }
  }
  return null;
}

import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { type Router } from "express";
import type { GantryConfig } from "../config.js";
import { getToolsForRolePreset } from "../config.js";
import { createLogger } from "../lib/logger.js";
import { SessionStore } from "./session-store.js";
import { SessionManager } from "./session-manager.js";
import { EventBuffer } from "./event-buffer.js";
import { BreakerRegistry } from "./circuit-breaker.js";
import { MetricsWindow } from "./instability-metrics.js";
import { MarketCache } from "./market-cache.js";
import { ArbitrageAnalyzer } from "./arbitrage-analyzer.js";
import { SellLog } from "./sell-log.js";
import { MarketReservationCache } from "./market-reservations.js";
import { AnalyzeMarketCache } from "./analyze-market-cache.js";
import { GalaxyGraph, fetchAndBuildGraph } from "./pathfinder.js";
import type { FleetCoordinator } from "../services/coordinator.js";
import { LifecycleManager } from "../lib/lifecycle-manager.js";
import { BUILD_VERSION, BUILD_COMMIT, getUptimeSeconds, SERVER_START_TIME } from "../lib/build-info.js";

import {
  resolveGameTools,
  resolveGameToolsV2,
  invalidateSchemaCache,
  type ServerTool,
} from "./schema.js";
import { TransitThrottle } from "./transit-throttle.js";
import { TransitStuckDetector } from "./transit-stuck-detector.js";
import { NavLoopDetector } from "./nav-loop-detector.js";
import { OverrideRegistry, BUILT_IN_RULES } from "./override-system.js";
import { restoreAllCaches, restorePublicCaches } from "./cache-persistence.js";
import {
  STATIC_GAME_TOOLS,
  createGantryServer,
  createGantryServerV2,
  type AgentCallTracker,
  type BattleState,
  type GameHealthRef,
} from "./server.js";
import { OverseerEventLog } from "../services/overseer-event-log.js";
import { OverseerAgent } from "../services/overseer-agent.js";
import { createOverseerMcpServer } from "./overseer-mcp.js";
import { gatherFleetSnapshot, buildAgentConfigs } from "../services/coordinator-state.js";
import { createActionExecutor } from "../services/overseer-actions.js";
import { startAgent, stopAgent, stopAll as stopAllAgents } from "../services/agent-manager.js";
import { createOrder } from "../services/comms-db.js";
import { createFleetHealthMonitor } from "../services/fleet-health-monitor.js";
import type { FleetHealthMonitor } from "../services/fleet-health-monitor.js";
import { initTracker as initRateLimitTracker } from "../services/rate-limit-tracker.js";
import { initializeNudgeSystem } from "./nudge-integration.js";
import { createFleetWatchdog } from "../services/fleet-watchdog.js";

const log = createLogger("mcp-factory");

// Parameter names from our TOOL_SCHEMAS, extracted for schema drift detection.
// Must be kept in sync with TOOL_SCHEMAS inside createGantryServer().
export const OUR_SCHEMA_PARAMS: Record<string, string[]> = {
  captains_log_add: ["entry"],
  captains_log_list: ["index"],
  travel: ["destination_id"],
  jump: ["system_id"],
  craft: ["recipe_id", "count", "deliver_to"],
  deposit_items: ["item_id", "quantity"],
  withdraw_items: ["item_id", "quantity"],
  sell: ["item_id", "quantity", "auto_list"],
  buy: ["item_id", "quantity", "auto_list", "deliver_to"],
  create_sell_order: ["item_id", "quantity", "price_each", "orders"],
  create_buy_order: ["item_id", "quantity", "price_each", "deliver_to", "orders"],
  cancel_order: ["order_id", "order_ids"],
  modify_order: ["order_id", "new_price", "orders"],
  accept_mission: ["mission_id"],
  complete_mission: ["mission_id"],
  abandon_mission: ["mission_id"],
  decline_mission: ["template_id"],
  attack: ["target_id"],
  loot_wreck: ["wreck_id", "item_id", "quantity"],
  salvage_wreck: ["wreck_id"],
  chat: ["channel", "content", "target_id"],
  get_chat_history: ["channel", "target_id", "before", "limit"],
  find_route: ["destination_system_id"],
  search_systems: ["name"],
  buy_ship: ["ship_class"],
  switch_ship: ["ship_id"],
  view_market: ["item_id", "category"],
  get_system: ["system_id"],
  get_poi: ["poi_id"],
  get_map: ["system_id"],
  estimate_purchase: ["item_id", "quantity"],
  forum_get_thread: ["thread_id"],
  forum_create_thread: ["title", "content", "category"],
  forum_reply: ["thread_id", "content"],
  forum_upvote: ["reply_id", "thread_id"],
  trade_accept: ["trade_id"],
  trade_decline: ["trade_id"],
  trade_cancel: ["trade_id"],
  commission_ship: ["ship_class", "provide_materials"],
  commission_quote: ["ship_class"],
};

/**
 * Create the Express app with MCP transport handling.
 * Each MCP session gets its own McpServer instance (SDK requirement),
 * but they all share the same SessionManager and state.
 */
export async function createMcpServer(config: GantryConfig) {
  // Fetch dynamic tool list from game server (falls back to static list)
  const { tools: gameTools, descriptions: serverDescriptions } = await resolveGameTools(
    config.gameUrl,
    STATIC_GAME_TOOLS,
    OUR_SCHEMA_PARAMS,
  );

  const isDynamic = serverDescriptions.size > 0;
  log.info("registered game tools", { count: gameTools.length, source: isDynamic ? "dynamic" : "static" });

  // --- v2 schema fetching ---
  // Determine which v2 presets are needed from agent configs.
  // Fetch in background asynchronously (don't block server startup).
  const v2Presets = new Set<string>();
  for (const agent of config.agents) {
    if (agent.mcpVersion === "v2") {
      v2Presets.add(agent.mcpPreset ?? "standard");
    }
  }

  const v2SchemaByPreset = new Map<string, {
    tools: string[];
    descriptions: Map<string, string>;
    toolSchemas: Map<string, ServerTool>;
  }>();

  // Load v2 schemas asynchronously in series (one at a time, not all at once)
  const loadV2Schemas = async () => {
    for (const preset of v2Presets) {
      try {
        const v2Result = await resolveGameToolsV2(config.gameUrl, preset);
        if (v2Result.tools.length > 0) {
          v2SchemaByPreset.set(preset, v2Result);
          log.info("loaded v2 preset", { preset, toolCount: v2Result.tools.length });
        } else {
          log.warn("failed to load v2 preset", { preset, reason: "fetch failed" });
        }
      } catch (err) {
        log.warn("error loading v2 preset", { preset, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (v2Presets.size > 0 && v2SchemaByPreset.size === 0) {
      log.warn("no v2 schemas loaded", { presetCount: v2Presets.size });
    }
  };

  // Load v2 schemas before accepting connections to prevent MCP_TOOLS_MISSING on first agent turn
  await loadV2Schemas().catch((err) => {
    log.warn("loadV2Schemas error", { error: err instanceof Error ? err.message : String(err) });
  });

  // Shared state across all MCP sessions
  const breakerRegistry = new BreakerRegistry();
  const serverMetrics = new MetricsWindow();
  const persistPath = new URL("../data/sessions.json", import.meta.url).pathname;
  const sessions = new SessionManager(config, breakerRegistry, serverMetrics, persistPath);
  const sessionStore = new SessionStore();
  // Clear any stale MCP sessions from previous server runs.
  // After restart the in-memory transports map is empty, so any DB session IDs
  // would pass isValidSession() but fail transports.get() — causing MCP errors.
  sessionStore.clearAll();
  const sessionAgentMap = new Map<string, string>();
  const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
  const battleCache = new Map<string, BattleState | null>();
  const eventBuffers = new Map<string, EventBuffer>();
  const callTrackers = new Map<string, AgentCallTracker>();

  // --- Public API caches (no auth required) ---
  const marketCache = new MarketCache();
  const arbitrageAnalyzer = new ArbitrageAnalyzer();
  type GalaxyGraphRef = { current: GalaxyGraph };
  const galaxyGraphRef: GalaxyGraphRef = { current: new GalaxyGraph() };

  // Restore persisted caches from previous server run
  const restoredCaches = await restorePublicCaches();
  if (restoredCaches.marketData) {
    const md = restoredCaches.marketData;
    marketCache.restore(
      {
        categories: md.categories ?? [],
        empires: (md.empires ?? []) as import("./market-cache.js").MarketData['empires'],
        items: (md.items ?? []) as import("./market-cache.js").MarketData['items'],
      },
      restoredCaches.marketFetchedAt ?? Date.now(),
    );
    log.info("restored market cache", { itemCount: restoredCaches.marketData.items?.length ?? 0 });
  }

  if (restoredCaches.galaxyGraphSystems) {
    // Rebuild graph from persisted systems and edges
    for (const sys of restoredCaches.galaxyGraphSystems as any[]) {
      galaxyGraphRef.current.addSystem(sys.id, sys.name);
    }
    for (const edge of restoredCaches.galaxyGraphEdges ?? []) {
      galaxyGraphRef.current.addEdge(edge.from, edge.to);
    }
    galaxyGraphRef.current.setLastFetch(restoredCaches.galaxyGraphFetchedAt ?? Date.now());
    log.info("restored galaxy graph", { systemCount: galaxyGraphRef.current.systemCount });
  }

  // Load initial data asynchronously in series (don't block server startup, don't send multiple requests at once)
  const loadInitialData = async () => {
    try {
      // First: Market cache refresh (5 min TTL)
      await marketCache.refresh();

      // Second: Galaxy graph fetch (1 hour TTL)
      const { graph, success } = await fetchAndBuildGraph(config.gameUrl.replace(/\/mcp$/, "/api/map"));
      if (success) {
        galaxyGraphRef.current = graph;
        log.info("loaded galaxy graph (initial)", { systemCount: galaxyGraphRef.current.systemCount });
      }
    } catch (err) {
      log.warn("initial cache load failed (non-fatal)", { error: err instanceof Error ? err.message : String(err) });
    }
  };

  // Fire off async initial load (non-blocking) — runs in series to avoid rate limit cascade
  loadInitialData().catch((err) => {
    log.warn("loadInitialData error", { error: err instanceof Error ? err.message : String(err) });
  });

  // Start periodic refresh (will use restored data initially, then refreshed data)
  const mcpTimers = new LifecycleManager();
  mcpTimers.register("marketCache", marketCache.start());
  mcpTimers.register("galaxyGraph", galaxyGraphRef.current.start());

  // Restore sessions from previous run (tries SQL, falls back to file)
  const restored = await sessions.restoreSessions();
  if (restored > 0) {
    log.info("restored game sessions", { count: restored });
  }

  // Restore proxy caches from fleet-web SQL
  await restoreAllCaches(statusCache, battleCache, callTrackers);

  // Restore POI resolution cache from galaxy_pois table
  const { restoreSystemPoiCache } = await import("./poi-resolver.js");
  restoreSystemPoiCache();

  // --- Game server health poller ---
  // Polls the game server's /health endpoint every 30s to track the current tick
  // and detect version changes. The server tick is used for drift detection in
  // navigation logging and exposed on our own /health endpoint.
  const gameHealthRef: GameHealthRef = { current: null };
  const HEALTH_URL = config.gameUrl.replace(/\/mcp$/, "/health");
  const HEALTH_INTERVAL_MS = 10_000; // Match game tick interval

  async function pollGameHealth(): Promise<void> {
    try {
      const resp = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) return;
      let data: { status: string; tick: number; version: string; estimated_next_tick?: string };
      try {
        const text = await resp.text();
        data = JSON.parse(text) as { status: string; tick: number; version: string; estimated_next_tick?: string };
      } catch (parseErr) {
        log.warn("pollGameHealth: JSON parse error", { error: parseErr instanceof Error ? parseErr.message : String(parseErr) });
        return;
      }
      const prev = gameHealthRef.current;
      gameHealthRef.current = {
        tick: data.tick,
        version: data.version,
        fetchedAt: Date.now(),
        estimatedNextTick: data.estimated_next_tick ?? null,
      };

      // Log version changes (game updates while proxy is running)
      if (prev && prev.version !== data.version) {
        log.warn("game server version changed", { from: prev.version, to: data.version });
        invalidateSchemaCache();
        // Refresh galaxy graph — system IDs or connections may have changed
        galaxyGraphRef.current.forceRefresh().then((changed) => {
          if (changed) {
            log.info("galaxy graph refreshed after game version change", {
              from: prev.version, to: data.version, systemCount: galaxyGraphRef.current.systemCount,
            });
          } else {
            log.info("galaxy graph unchanged after game version change", {
              from: prev.version, to: data.version, systemCount: galaxyGraphRef.current.systemCount,
            });
          }
        }).catch((err) => {
          log.warn("galaxy graph refresh failed after game version change", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    } catch (err) {
      // Non-fatal — game server may be temporarily unreachable
      log.debug(`pollGameHealth: fetch error — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Initial fetch (don't block startup)
  pollGameHealth();
  const healthInterval = setInterval(pollGameHealth, HEALTH_INTERVAL_MS);
  healthInterval.unref();

  // Wire recovery probe: when unstable/down, poll game health every 30s so
  // a successful response can transition the status back toward healthy.
  serverMetrics.setProbeCallback(pollGameHealth);
  serverMetrics.startRecoveryProbe();

  // Circuit breaker state changes are intentionally NOT wired to fleet-wide
  // serverMetrics to avoid a single agent's WS failure blocking the entire fleet.
  // Fleet-wide instability is determined solely by error-rate + latency metrics.
  // Individual agent health is tracked per-agent in the health endpoint.
  //
  // If ALL breakers open simultaneously, that's a fleet-wide issue — but we let
  // the error rate / latency metrics catch that naturally.
  const breakerLog = createLogger("circuit-breaker");
  for (const [agentName, breaker] of breakerRegistry.getAll()) {
    breaker.onStateChange((from, to) => {
      // Log state changes but don't propagate to fleet-wide metrics
      breakerLog.info(`Agent ${agentName} circuit breaker: ${from} → ${to}`);
    });
  }

  // Shared sell log for cross-agent sell deconfliction
  const sellLog = new SellLog();
  const marketReservations = new MarketReservationCache();
  const analyzeMarketCache = new AnalyzeMarketCache();

  // Overseer event log — receives copies of all agent events for fleet-wide monitoring
  const overseerEventLog = new OverseerEventLog();
  // Prune stale events every 5 minutes
  const overseerEventPruneInterval = setInterval(() => overseerEventLog.prune(), 5 * 60 * 1000);
  overseerEventPruneInterval.unref();

  // Shared transit throttle — single instance for the entire fleet server lifetime.
  // Persists across agent turns and session restarts, keyed by agent name.
  const transitThrottle = new TransitThrottle();

  // Shared transit stuck detector — persists across sessions so the counter
  // doesn't reset when agents reconnect (same fix as TransitThrottle in session 46).
  const transitStuckDetector = new TransitStuckDetector();

  // Shared nav loop detector — persists across sessions so repeated travel_to
  // calls within the same 10-minute window are detected even across turn boundaries.
  const navLoopDetector = new NavLoopDetector();

  // Shared override registry — condition-triggered directives that fire before each
  // tool call. Persists cooldown state across sessions so overrides don't re-fire
  // immediately when an agent reconnects.
  const overrideRegistry = new OverrideRegistry(BUILT_IN_RULES);

  // Initialize the game-API rate limit tracker singleton (tracks req/min per agent and exit IP).
  initRateLimitTracker(config);

  // Initialize nudge state manager — tracks per-agent escalation state.
  // Full escalation hooks (retry/reset) need deeper integration; stubs make
  // getAgentNudgeState() return real state for the directives API.
  initializeNudgeSystem({
    retryFn: async () => {},
    sessionResetFn: async () => {},
    configReloadFn: async () => {},
    healthCheckFn: async () => true,
    alertOperatorFn: async (agent_id, level, error, _errorChain) => {
      log.warn(`[NUDGE] agent=${agent_id} level=${level} error=${error}`);
    },
    logger: log,
  });

  // Shared state passed to every server instance (v1 and v2)
  const sharedInstanceState = {
    sessions: { active: sessions, store: sessionStore, agentMap: sessionAgentMap },
    cache: { status: statusCache, battle: battleCache, market: marketCache, events: eventBuffers },
    proxy: { gameTools, serverDescriptions, gameHealthRef, callTrackers, breakerRegistry, serverMetrics, transitThrottle, transitStuckDetector, navLoopDetector, overrideRegistry },
    fleet: { galaxyGraphRef, sellLog, arbitrageAnalyzer, coordinator: null as FleetCoordinator | null, marketReservations, analyzeMarketCache, overseerEventLog },
  };

  // v1 factory: creates a new McpServer wired to shared state
  function createServerInstance() {
    return createGantryServer(config, sharedInstanceState);
  }

  // v2 factory: creates a v2 McpServer for a given game preset and optional role tool filter.
  // roleType filters which tools are advertised to the LLM (advisory only).
  function createServerInstanceV2(preset: string, roleType?: string) {
    const v2Schema = v2SchemaByPreset.get(preset);
    if (!v2Schema) return null;

    // Build role-based tool allowlist from fleet-config mcpPresets
    let allowedTools: Set<string> | undefined;
    const roleToolList = getToolsForRolePreset(config.mcpPresets, roleType);
    if (roleToolList) {
      allowedTools = new Set(roleToolList);
      log.debug("applying role tool filter", {
        roleType: roleType ?? "none",
        allowedCount: allowedTools.size,
        allCount: v2Schema.tools.length,
      });
    }

    return createGantryServerV2(config, {
      ...sharedInstanceState,
      v2Tools: v2Schema.tools,
      v2Descriptions: v2Schema.descriptions,
      v2ToolSchemas: v2Schema.toolSchemas,
    }, allowedTools);
  }

  // Get tool count from a throwaway instance
  const { registeredTools } = createServerInstance();

  // Get v2 tool counts for logging
  let v2ToolCount = 0;
  for (const [preset, schema] of v2SchemaByPreset) {
    v2ToolCount += schema.tools.length;
    log.debug("v2 preset tool count", { preset, toolCount: schema.tools.length });
  }

  const router: Router = express.Router();

  const transports = new Map<string, StreamableHTTPServerTransport>();

  // --- Fleet health monitor ---
  // Polls per-agent connection health every 60s and enforces auto-shutdown triggers:
  //   - Error rate >30% sustained 5+ min → stop fleet
  //   - Agent >10 reconnects/min → stop that agent
  //   - Agent in short-connection loop (duration <30s + reconnects >3/min) → stop agent
  const fleetHealthMonitor: FleetHealthMonitor = createFleetHealthMonitor({
    getAgentHealth: (agentName: string) => {
      const client = sessions.getClient(agentName);
      if (!client || !('getConnectionHealth' in client)) return null;
      return (client as import("./game-client.js").HttpGameClient).getConnectionHealth();
    },
    getActiveAgents: () => sessions.listActive(),
    getErrorRate: () => {
      const metrics = serverMetrics.getMetrics();
      return metrics.requests.total > 0
        ? metrics.errors.total / metrics.requests.total
        : 0;
    },
    getTransportCount: () => transports.size,
    stopAgent: (name: string) => stopAgent(name),
    stopAllAgents: async () => { await stopAllAgents(); },
  });

  const FLEET_HEALTH_INTERVAL_MS = 60_000;
  const fleetHealthInterval = setInterval(async () => {
    try {
      await fleetHealthMonitor.tick();
    } catch (err) {
      log.warn("fleet health monitor tick failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, FLEET_HEALTH_INTERVAL_MS);
  fleetHealthInterval.unref();
  log.info("fleet health monitor started", { intervalMs: FLEET_HEALTH_INTERVAL_MS });

  // --- Fleet watchdog (webhook alerting) ---
  const fleetWatchdog = createFleetWatchdog({
    getFleetHealth: () => fleetHealthMonitor.getSnapshot(),
    getErrorRate: () => {
      const metrics = serverMetrics.getMetrics();
      return metrics.requests.total > 0 ? metrics.errors.total / metrics.requests.total : 0;
    },
    webhookUrl: process.env.WATCHDOG_WEBHOOK_URL ?? null,
  });

  // Clean up expired sessions from persistent store every 60s.
  // Also reaps orphaned transports whose DB session has expired or been removed,
  // preventing unbounded transport map growth during long server runs.
  const cleanupInterval = setInterval(() => {
    const deleted = sessionStore.cleanup();
    if (deleted > 0) {
      log.debug("cleaned up expired sessions", { count: deleted });
    }

    // Reap transports whose DB session no longer exists or has expired.
    // Without this, transports accumulate in memory even after the session TTL.
    let reaped = 0;
    for (const [sid, transport] of transports) {
      if (!sessionStore.isValidSession(sid)) {
        transports.delete(sid);
        sessionAgentMap.delete(sid);
        transport.close?.().catch(() => {});
        reaped++;
      }
    }
    if (reaped > 0) {
      log.debug("reaped orphaned transports", { count: reaped, remaining: transports.size });
    }
  }, 60_000);
  cleanupInterval.unref();

  // Helper: create an MCP transport and wire it up
  function createTransport(logPrefix: string): StreamableHTTPServerTransport {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        transports.set(id, transport);
        // Register session in persistent store with SDK-generated ID
        sessionStore.createSession(undefined, id);
        log.debug("session created", { type: logPrefix, sessionId: id.slice(0, 8), activeCount: transports.size });
      },
    });
    transport.onclose = () => {
      const sid = [...transports.entries()].find(([, t]) => t === transport)?.[0];
      if (sid) {
        transports.delete(sid);
        sessionAgentMap.delete(sid);
      }
    };
    return wrapTransportForCodexCompat(transport);
  }

  // Codex's rmcp client only sends "Accept: application/json" but the SDK's
  // StreamableHTTPServerTransport requires both application/json AND text/event-stream.
  // We monkey-patch the transport's handleRequest to inject the missing Accept type
  // into the raw Node.js request before Hono converts it to a Web Standard Request.
  function wrapTransportForCodexCompat(transport: StreamableHTTPServerTransport): StreamableHTTPServerTransport {
    const origHandleRequest = transport.handleRequest.bind(transport);
    transport.handleRequest = async (req: any, res: any, parsedBody?: any) => {
      const accept = req.headers.accept ?? "";
      if (!accept.includes("text/event-stream")) {
        const patched = accept ? `${accept}, text/event-stream` : "application/json, text/event-stream";
        req.headers.accept = patched;
        // Patch rawHeaders too — Hono's getRequestListener reads from these
        const rawIdx = (req.rawHeaders as string[]).findIndex((h: string) => h.toLowerCase() === "accept");
        if (rawIdx >= 0 && rawIdx + 1 < req.rawHeaders.length) {
          req.rawHeaders[rawIdx + 1] = patched;
        }
      }
      return origHandleRequest(req, res, parsedBody);
    };
    return transport;
  }

  // Shared helpers for MCP route handlers
  function logSanitized(version: string, body: unknown): void {
    const raw = sanitizeToolCallBody(body);
    if (raw) {
      log.warn(`${version} MCP tool name sanitized`, { raw, cleaned: ((body as Record<string, unknown>).params as Record<string, unknown>)?.name });
    }
  }

  function sendBadSession(res: import("express").Response, body: unknown): void {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: No valid session ID (server may have restarted)" },
      id: (body as any)?.id ?? null,
    });
  }

  function sendInternalError(res: import("express").Response): void {
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }

  router.post("/mcp", async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport: StreamableHTTPServerTransport | undefined;
      if (sessionId && sessionStore.isValidSession(sessionId)) {
        transport = transports.get(sessionId);
      }

      if (transport) {
        logSanitized("v1", req.body);
        await transport.handleRequest(req as Parameters<typeof transport.handleRequest>[0], res, req.body);
      } else if (!sessionId && isInitializeRequest(req.body)) {
        const newTransport = createTransport("v1 MCP");
        const { mcpServer } = createServerInstance();
        await mcpServer.connect(newTransport);
        logSanitized("v1", req.body);
        await newTransport.handleRequest(req as Parameters<typeof newTransport.handleRequest>[0], res, req.body);
      } else {
        sendBadSession(res, req.body);
      }
    } catch (error) {
      log.error("MCP request error", { error: error instanceof Error ? error.message : String(error) });
      sendInternalError(res);
    }
  });

  // --- v2 MCP endpoint ---
  // Serves consolidated tools (6-15 instead of ~79). Agents connect here via mcp-v2.json.
  // The preset is determined at startup from fleet-config.json (default: "standard").

  router.post("/mcp/v2", async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport: StreamableHTTPServerTransport | undefined;
      if (sessionId && sessionStore.isValidSession(sessionId)) {
        transport = transports.get(sessionId);
      }

      if (transport) {
        logSanitized("v2", req.body);
        await transport.handleRequest(req as Parameters<typeof transport.handleRequest>[0], res, req.body);
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // Determine preset from query param or default to first available preset
        const defaultPreset = v2SchemaByPreset.keys().next().value ?? "standard";
        const preset = (req.query.preset as string) ?? defaultPreset;
        // Optional roleType query param enables role-based tool filtering
        const roleType = req.query.roleType as string | undefined;
        const v2Instance = createServerInstanceV2(preset, roleType);
        if (!v2Instance) {
          res.status(503).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: `v2 endpoint not available for preset "${preset}" — schema fetch failed at startup` },
            id: (req.body as any)?.id ?? null,
          });
          return;
        }
        const newTransport = createTransport(`v2 MCP (${preset})`);
        await v2Instance.mcpServer.connect(newTransport);
        logSanitized("v2", req.body);
        await newTransport.handleRequest(req as Parameters<typeof newTransport.handleRequest>[0], res, req.body);
      } else {
        sendBadSession(res, req.body);
      }
    } catch (error) {
      log.error("v2 MCP request error", { error: error instanceof Error ? error.message : String(error) });
      sendInternalError(res);
    }
  });

  // --- Overseer MCP endpoint ---
  // The overseer agent connects here via mcp-overseer.json. Separate McpServer with fleet tools.
  const overseerAgent = new OverseerAgent();
  const overseerMcpServer = createOverseerMcpServer({
    stateGatherer: () => gatherFleetSnapshot({
      statusCache: sharedInstanceState.cache.status,
      battleCache: sharedInstanceState.cache.battle,
      marketCache: sharedInstanceState.cache.market,
      arbitrageAnalyzer: sharedInstanceState.fleet.arbitrageAnalyzer,
      overseerEventLog,
      agentConfigs: buildAgentConfigs(),
    }),
    actionExecutor: createActionExecutor({
      agentManager: { startAgent, stopAgent },
      commsDb: { createOrder: (opts: { message: string; target_agent: string; priority?: string }) => createOrder({ ...opts, priority: (opts.priority as "normal" | "urgent") ?? "normal" }) },
    }),
    overseerAgent,
    statusCache: sharedInstanceState.cache.status,
    battleCache: sharedInstanceState.cache.battle,
  });

  router.post("/mcp/overseer", async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport: StreamableHTTPServerTransport | undefined;
      if (sessionId && sessionStore.isValidSession(sessionId)) {
        transport = transports.get(sessionId);
      }

      if (transport) {
        logSanitized("overseer", req.body);
        await transport.handleRequest(req as Parameters<typeof transport.handleRequest>[0], res, req.body);
      } else if (!sessionId && isInitializeRequest(req.body)) {
        const newTransport = createTransport("overseer MCP");
        // Close any existing connection before reconnecting — McpServer only allows one transport at a time
        try { await overseerMcpServer.close(); } catch { /* ignore if not connected */ }
        await overseerMcpServer.connect(newTransport);
        logSanitized("overseer", req.body);
        await newTransport.handleRequest(req as Parameters<typeof newTransport.handleRequest>[0], res, req.body);
      } else {
        sendBadSession(res, req.body);
      }
    } catch (error) {
      log.error("overseer MCP request error", { error: error instanceof Error ? error.message : String(error) });
      sendInternalError(res);
    }
  });

  router.get("/mcp", (_req, res) => {
    res.status(405).set("Allow", "POST").send("Method Not Allowed");
  });

  router.get("/mcp/v2", (_req, res) => {
    res.status(405).set("Allow", "POST").send("Method Not Allowed");
  });

  router.get("/mcp/overseer", (_req, res) => {
    res.status(405).set("Allow", "POST").send("Method Not Allowed");
  });

  router.get("/health", (_req, res) => {
    const breaker = breakerRegistry.getAggregateStatus();
    const gh = gameHealthRef.current;
    const metrics = serverMetrics.getMetrics();
    res.json({
      status: metrics.status === "healthy" ? "ok" : metrics.status,
      version: BUILD_VERSION,
      commit: BUILD_COMMIT,
      uptime_seconds: getUptimeSeconds(),
      started_at: SERVER_START_TIME.toISOString(),
      active_agents: sessions.listActive(),
      tools: registeredTools.length,
      tools_v2: v2ToolCount,
      v2_presets: [...v2SchemaByPreset.keys()],
      mcp_sessions: transports.size,
      sessions_reaped: 0,
      memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      game_server: {
        ...breaker,
        agents: breakerRegistry.getPerAgentStatus(),
        tick: gh?.tick ?? null,
        version: gh?.version ?? null,
        estimated_next_tick: gh?.estimatedNextTick ?? null,
        health_age_s: gh ? Math.round((Date.now() - gh.fetchedAt) / 1000) : null,
      },
      instability: {
        status: metrics.status,
        reason: metrics.reason,
        error_rate: metrics.requests.total > 0
          ? ((metrics.errors.total / metrics.requests.total) * 100).toFixed(1) + "%"
          : "0%",
        errors: metrics.errors,
        requests: metrics.requests,
      },
      connection_health: (() => {
        const health: Record<string, unknown> = {};
        const activeAgents = sessions.listActive();
        for (const name of activeAgents) {
          const client = sessions.getClient(name);
          if (client && 'getConnectionHealth' in client) {
            health[name] = (client as import("./game-client.js").HttpGameClient).getConnectionHealth();
          }
        }
        return {
          agents: health,
          session_leak: transports.size > Math.max(activeAgents.length * 3, 10),
        };
      })(),
      analyze_market_cache: (() => {
        const m = analyzeMarketCache.getMetrics();
        return { ...m, hit_rate: analyzeMarketCache.hitRatePct };
      })(),
      fleet_health: fleetHealthMonitor.getSnapshot(),
    });
  });

  router.get("/health/instability", (_req, res) => {
    res.json(serverMetrics.getMetrics());
  });

  router.delete("/sessions/:agent", async (req, res) => {
    const agentName = req.params.agent;
    const resolved = sessions.resolveAgentName(agentName);
    const client = sessions.getClient(resolved);

    if (!client) {
      res.status(404).json({ error: "no active session", agent: resolved });
      return;
    }

    try {
      if (client.getCredentials()) {
        await client.logout();
      }
    } catch (err) {
      log.error("error during kick logout", { agent: resolved, error: err instanceof Error ? err.message : String(err) });
    }

    sessions.removeClient(resolved);
    // Also clean up sessionAgentMap entries pointing to this agent
    for (const [sid, name] of sessionAgentMap) {
      if (name === resolved) sessionAgentMap.delete(sid);
    }

    log.debug("session kicked via API", { agent: resolved });
    res.json({ status: "kicked", agent: resolved });
  });

  // --- Game state endpoints (read from statusCache) ---

  router.get("/game-state/all", (_req, res) => {
    const result: Record<string, unknown> = {};
    for (const [agentName, entry] of statusCache) {
      result[agentName] = entry.data;
    }
    res.json(result);
  });

  router.get("/game-state/:agent", (req, res) => {
    const entry = statusCache.get(req.params.agent);
    if (!entry) {
      res.status(404).json({ error: "not found", agent: req.params.agent });
      return;
    }
    res.json(entry.data);
  });

  // Override status API — shows active override history and cooldown state per agent.
  router.get("/api/overrides/:agent", (req, res) => {
    const agent = req.params.agent;
    const history = overrideRegistry.getHistory(agent);
    const ruleNames = overrideRegistry.getRuleNames();
    res.json({
      agent,
      history,
      rules: ruleNames,
    });
  });

  router.get("/api/overrides", (_req, res) => {
    res.json(overrideRegistry.getAllHistory());
  });

  // Lifecycle management: dispose() cleans up all background resources
  let disposed = false;
  async function dispose(): Promise<void> {
    if (disposed) return; // Idempotent
    disposed = true;

    // Clear all intervals
    clearInterval(healthInterval);
    log.debug("disposed: cleared health interval");

    clearInterval(cleanupInterval);
    log.debug("disposed: cleared session reap interval");

    clearInterval(overseerEventPruneInterval);
    log.debug("disposed: cleared overseer event prune interval");


    clearInterval(fleetHealthInterval);
    log.debug("disposed: cleared fleet health monitor interval");
    fleetWatchdog.stop();
    log.debug("disposed: stopped fleet watchdog");
    serverMetrics.stopRecoveryProbe();
    log.debug("disposed: stopped recovery probe");

    // Stop market cache, galaxy graph, and reservation cache.
    // mcpTimers.stopAll() clears the registered setInterval timers.
    // marketCache.stop() and galaxyGraph.stop() additionally abort pending requests.
    mcpTimers.stopAll();
    marketCache.stop();
    galaxyGraphRef.current.stop();
    marketReservations.dispose();
    log.debug("disposed: stopped market cache and galaxy graph refresh");

    // Close all MCP transports in parallel with a per-transport timeout.
    // Sequential closes were the primary cause of 54s+ shutdown times on stale sessions.
    const TRANSPORT_CLOSE_TIMEOUT_MS = 3_000;
    const transportEntries = [...transports.entries()];
    await Promise.allSettled(
      transportEntries.map(async ([sid, transport]) => {
        const closeWithTimeout = Promise.race([
          transport.close(),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error("transport close timeout")), TRANSPORT_CLOSE_TIMEOUT_MS)
          ),
        ]);
        try {
          await closeWithTimeout;
          log.debug("disposed: closed MCP transport", { sessionId: sid.slice(0, 8) });
        } catch (err) {
          log.warn("disposed: transport close timed out or failed, forcing", {
            sessionId: sid.slice(0, 8),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
    transports.clear();
    sessionAgentMap.clear();
  }

  return {
    router,
    sessions,
    registeredToolCount: registeredTools.length,
    sharedState: sharedInstanceState,
    overseerAgent,
    dispose,
  };
}
