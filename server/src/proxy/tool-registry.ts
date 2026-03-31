/**
 * Tool registration: passthrough game tools, compound tools, event tools, utility tools.
 * Extracted from server.ts to reduce its size.
 *
 * Covers the large middle section of createGantryServer:
 *   - TOOL_SCHEMAS: typed parameter schemas per tool
 *   - NO_PARAM_DESCRIPTIONS: descriptions for no-param tools
 *   - PROXY_HANDLED_TOOLS: tools NOT forwarded to game server
 *   - Passthrough tool registration loop
 *   - Compound tool registrations (batch_mine, travel_to, jump_route, multi_sell,
 *     scan_and_attack, battle_readiness, loot_wrecks)
 *   - Event tool: get_events
 *   - Utility tool: get_session_info
 */
import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GantryConfig } from "../config.js";
import type { SessionManager } from "./session-manager.js";
import type { EventBuffer } from "./event-buffer.js";
import type { MarketCache } from "./market-cache.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("registry");
import type { GalaxyGraph } from "./pathfinder.js";
import type { SellLog } from "./sell-log.js";
import type { AgentCallTracker, BattleState, GameHealthRef } from "./server.js";
import type { HttpGameClient as GameClient } from "./game-client.js";
import type { MockGameClient } from "./mock-game-client.js";
import type { GameClientLike } from "./compound-tools/types.js";
import { resolvePoiId } from "./poi-resolver.js";
import { logToolCall, logToolCallStart, logToolCallComplete } from "./tool-call-logger.js";
import { getAutoTriggerAction } from "./combat-auto-trigger.js";
import { persistBattleState } from "./cache-persistence.js";
import { handlePassthrough, type PassthroughDeps, type McpTextResult, textResult } from "./passthrough-handler.js";
import type { NavLoopDetector } from "./nav-loop-detector.js";
import { upsertNote } from "../services/notes-db.js";
import { getTracker } from "../services/rate-limit-tracker.js";
import {
  batchMine,
  travelTo,
  jumpRoute,
  multiSell,
  scanAndAttack,
  battleReadiness,
  lootWrecks,
  flee,
  getCraftProfitability,
  craftPathTo,
} from "./compound-tools/index.js";

// ---------------------------------------------------------------------------
// Typed parameter schemas for tools that require arguments.
// Exported so v2 factory can reference the param names via OUR_SCHEMA_PARAMS.
// ---------------------------------------------------------------------------

export const TOOL_SCHEMAS: Record<string, { description: string; schema: z.ZodType }> = {
  captains_log_add: {
    description: "Add a captain's log entry. This is your memory between sessions.",
    schema: z.object({ entry: z.string().describe("The log entry text") }),
  },
  captains_log_list: {
    description: "List captain's log entries. Returns most recent first.",
    schema: z.object({ index: z.number().int().min(0).optional().describe("Entry index (0=newest)") }),
  },
  travel: {
    description: "Travel to a POI in the current system. Must be undocked.",
    schema: z.object({ destination_id: z.string().describe("Target POI ID (e.g. 'main_belt', 'nexus_core')") }),
  },
  jump: {
    description: "Jump to a connected system. Costs fuel. Must be undocked.",
    schema: z.object({ system_id: z.string().describe("Target system ID") }),
  },
  craft: {
    description: "Craft an item using a recipe. Must be docked.",
    schema: z.object({
      recipe_id: z.string().describe("Recipe ID (e.g. 'refine_steel')"),
      count: z.number().int().min(1).max(50).optional().describe("How many to craft (default 1, max 50)"),
    }),
  },
  deposit_items: {
    description: "Deposit items from cargo to station storage. Must be docked.",
    schema: z.object({
      item_id: z.string().describe("Item ID to deposit"),
      quantity: z.number().int().min(1).describe("Amount to deposit"),
    }),
  },
  withdraw_items: {
    description: "Withdraw items from station storage to cargo. Must be docked.",
    schema: z.object({
      item_id: z.string().describe("Item ID to withdraw"),
      quantity: z.number().int().min(1).describe("Amount to withdraw"),
    }),
  },
  sell: {
    description: "Sell items directly to a market buyer.",
    schema: z.object({
      item_id: z.string().describe("Item ID to sell"),
      quantity: z.number().int().min(1).describe("Amount to sell"),
      auto_list: z.boolean().optional().describe("Auto-list as sell order if no buyer (default: true)"),
    }),
  },
  buy: {
    description: "Buy items from the market.",
    schema: z.object({
      item_id: z.string().describe("Item ID to buy"),
      quantity: z.number().int().min(1).describe("Amount to buy"),
      auto_list: z.boolean().optional().describe("Auto-list as buy order if no seller (default: true)"),
      deliver_to: z.string().optional().describe("Station ID to deliver to"),
    }),
  },
  create_sell_order: {
    description: "Create a sell order on the market.",
    schema: z.object({
      item_id: z.string().describe("Item ID"),
      quantity: z.number().int().min(1).describe("Amount"),
      price_each: z.number().int().min(1).describe("Price per unit"),
      orders: z.array(z.object({ item_id: z.string(), quantity: z.number(), price_each: z.number() })).optional().describe("Batch orders"),
    }),
  },
  create_buy_order: {
    description: "Create a buy order on the market.",
    schema: z.object({
      item_id: z.string().describe("Item ID"),
      quantity: z.number().int().min(1).describe("Amount"),
      price_each: z.number().int().min(1).describe("Price per unit"),
      deliver_to: z.string().optional().describe("Delivery location"),
      orders: z.array(z.object({ item_id: z.string(), quantity: z.number(), price_each: z.number() })).optional().describe("Batch orders"),
    }),
  },
  view_orders: {
    description: "View your active market orders. Supports pagination, filtering, and sorting.",
    schema: z.object({
      page: z.number().int().min(1).optional().describe("Page number (default: 1)"),
      page_size: z.number().int().min(1).optional().describe("Results per page"),
      order_type: z.enum(["buy", "sell"]).optional().describe("Filter by order type"),
      item_id: z.string().optional().describe("Filter by exact item ID"),
      search: z.string().optional().describe("Filter by name substring"),
      sort_by: z.enum(["newest", "oldest", "price_asc", "price_desc"]).optional().describe("Sort order"),
      scope: z.enum(["personal", "faction"]).optional().describe("'faction' to see faction orders (separate from personal)"),
    }),
  },
  cancel_order: {
    description: "Cancel a market order.",
    schema: z.object({
      order_id: z.string().describe("Order ID to cancel"),
      order_ids: z.array(z.string()).optional().describe("Batch cancel multiple orders"),
    }),
  },
  modify_order: {
    description: "Modify an existing market order.",
    schema: z.object({
      order_id: z.string().describe("Order ID"),
      new_price: z.number().int().optional().describe("New price per unit"),
      orders: z.array(z.object({ order_id: z.string(), new_price: z.number() })).optional().describe("Batch modify orders"),
    }),
  },
  accept_mission: {
    description: "Accept a mission from the mission board.",
    schema: z.object({ mission_id: z.string().describe("Mission template ID (e.g. 'common_iron_supply')") }),
  },
  complete_mission: {
    description: "Complete/turn in an active mission.",
    schema: z.object({ mission_id: z.string().describe("Active mission UUID from get_active_missions()") }),
  },
  abandon_mission: {
    description: "Abandon an active mission.",
    schema: z.object({ mission_id: z.string().describe("Active mission UUID") }),
  },
  decline_mission: {
    description: "Decline a mission from the board.",
    schema: z.object({ template_id: z.string().optional().describe("Mission template ID") }),
  },
  attack: {
    description: "Attack a target ship. Use scan() first to find targets.",
    schema: z.object({
      target_id: z.string().describe("Target ship ID from scan results"),
    }),
  },
  loot_wreck: {
    description: "Loot items from a wreck.",
    schema: z.object({
      wreck_id: z.string().describe("Wreck ID"),
      item_id: z.string().optional().describe("Specific item to loot (omit for all)"),
      quantity: z.number().int().min(1).optional().describe("Amount to loot"),
    }),
  },
  salvage_wreck: {
    description: "Salvage a wreck for materials.",
    schema: z.object({ wreck_id: z.string().describe("Wreck ID") }),
  },
  chat: {
    description: "Send a chat message.",
    schema: z.object({
      channel: z.enum(["system", "local", "faction", "private"]).describe("Chat channel"),
      content: z.string().describe("Message text (max 500 chars)"),
      target_id: z.string().optional().describe("Target player ID (for private messages)"),
    }),
  },
  get_chat_history: {
    description: "Get chat history for a channel.",
    schema: z.object({
      channel: z.enum(["system", "local", "faction", "private"]).describe("Chat channel"),
      target_id: z.string().optional().describe("Player ID (for private channel)"),
      before: z.string().optional().describe("Cursor for pagination"),
      limit: z.number().int().optional().describe("Max messages to return"),
    }),
  },
  find_route: {
    description: "Find a route to a destination system.",
    schema: z.object({ destination_system_id: z.string().describe("Target system ID") }),
  },
  search_systems: {
    description: "Search for systems by name.",
    schema: z.object({ name: z.string().optional().describe("System name to search for") }),
  },
  buy_ship: {
    description: "Buy a ship.",
    schema: z.object({ ship_class: z.string().describe("Ship class to buy") }),
  },
  switch_ship: {
    description: "Switch to a different owned ship.",
    schema: z.object({ ship_id: z.string().describe("Ship ID to switch to") }),
  },
  view_market: {
    description: "View market listings. On busy stations, returns a compact summary unless item_id or category is provided.",
    schema: z.object({ 
      item_id: z.string().optional().describe("Filter by specific item ID to see full order book depth"),
      category: z.string().optional().describe("Filter by item category (e.g., 'ore', 'commodity', 'module')")
    }),
  },
  get_system: {
    description: "Get system info including POIs and jump gates.",
    schema: z.object({ system_id: z.string().optional().describe("System ID (default: current system)") }),
  },
  get_poi: {
    description: "Get point of interest details.",
    schema: z.object({ poi_id: z.string().optional().describe("POI ID") }),
  },
  get_map: {
    description: "Get system map.",
    schema: z.object({ system_id: z.string().optional().describe("System ID") }),
  },
  estimate_purchase: {
    description: "Estimate cost of buying items from the market.",
    schema: z.object({
      item_id: z.string().describe("Item ID"),
      quantity: z.number().int().min(1).describe("Amount"),
    }),
  },
  forum_get_thread: {
    description: "Get a forum thread.",
    schema: z.object({ thread_id: z.string().describe("Thread ID") }),
  },
  forum_create_thread: {
    description: "Create a new forum thread.",
    schema: z.object({
      title: z.string().describe("Thread title"),
      content: z.string().describe("Thread body"),
      category: z.string().optional().describe("Forum category"),
    }),
  },
  forum_reply: {
    description: "Reply to a forum thread.",
    schema: z.object({
      thread_id: z.string().describe("Thread ID"),
      content: z.string().describe("Reply text"),
    }),
  },
  forum_upvote: {
    description: "Upvote a forum post.",
    schema: z.object({
      reply_id: z.string().describe("Reply ID to upvote"),
      thread_id: z.string().describe("Thread containing the reply"),
    }),
  },
  trade_offer: {
    description: "Send a trade offer to another player.",
    schema: z.object({}).passthrough(),
  },
  trade_accept: {
    description: "Accept a trade offer.",
    schema: z.object({ trade_id: z.string().describe("Trade ID") }),
  },
  trade_decline: {
    description: "Decline a trade offer.",
    schema: z.object({ trade_id: z.string().describe("Trade ID") }),
  },
  trade_cancel: {
    description: "Cancel your trade offer.",
    schema: z.object({ trade_id: z.string().describe("Trade ID") }),
  },
  commission_ship: {
    description: "Commission a new ship from an empire shipyard.",
    schema: z.object({
      ship_class: z.string().describe("Ship class to commission"),
      provide_materials: z.boolean().optional().describe("Whether to provide materials yourself"),
    }),
  },
  commission_quote: {
    description: "Get a cost quote for commissioning a ship.",
    schema: z.object({ ship_class: z.string().describe("Ship class to quote") }),
  },
  get_craft_profitability: {
    description: "Rank craftable recipes by profit using current market prices. Returns top recipes sorted by profit descending.",
    schema: z.object({
      limit: z.number().int().min(1).max(50).optional().describe("Max recipes to return (default 10)"),
      skill_filter: z.string().optional().describe("Filter by craft skill name (e.g. 'refining', 'engineering')"),
    }),
  },
  craft_path_to: {
    description: "Trace the full crafting chain for an item. Returns bill of materials, step-by-step recipe path, source classifications, and estimated cost/profit.",
    schema: z.object({
      item_id: z.string().describe("Item ID to trace the crafting path for (e.g. 'ship_engine', 'steel_plate')"),
    }),
  },
};

// ---------------------------------------------------------------------------
// No-param tools: short descriptions instead of full schemas
// ---------------------------------------------------------------------------

export const NO_PARAM_DESCRIPTIONS: Record<string, string> = {
  scan: "Scan for ships and objects at your current location.",
  mine: "Mine ore at current location. Use batch_mine() instead for efficiency.",
  dock: "Dock at current POI. Use travel_to() instead for full sequences.",
  undock: "Undock from current station. Use travel_to() instead for full sequences.",
  refuel: "Refuel your ship at a station. Must be docked.",
  repair: "Repair your ship at a station. Must be docked.",
  get_cargo: "Get full cargo contents. Expensive — use get_cargo_summary for quick checks.",
  get_missions: "List available missions at current station.",
  get_active_missions: "List your active/in-progress missions.",
  view_storage: "View station storage contents.",
  get_wrecks: "List wrecks at current location.",
  survey_system: "Survey the current system for exploration missions.",
  get_nearby: "Get nearby systems and POIs.",
  list_ships: "List your owned ships.",
  get_ship: "Get details of your current ship.",
  sell_ship: "Sell your current ship.",
  get_skills: "Get your character skills.",
  help: "Get game help information.",
  forum_list: "List forum threads.",
  get_trades: "List your active trades.",
};

// ---------------------------------------------------------------------------
// Tools handled by the proxy directly (NOT forwarded to game server)
// ---------------------------------------------------------------------------

export const PROXY_HANDLED_TOOLS = new Set([
  "login", "logout",
  // Cached status queries (populated by get_status polling)
  "get_status", "get_credits", "get_location", "get_cargo_summary", "get_fuel", "get_health",
  // Note tools (served via fleet-web SQL, not game server)
  "write_diary", "read_diary", "write_doc", "read_doc", "write_report", "search_memory",
  // Block game server's note tools (agents should use write_doc/read_doc instead)
  "write_note", "read_note",
  // Public API tools (served from cached public data, not game server)
  "get_global_market", "find_local_route",
]);

// ---------------------------------------------------------------------------
// Exported pure handlers — usable by v2 EVENT_ACTIONS dict without re-implementing
// ---------------------------------------------------------------------------

const MAX_EVENTS = 50;

/** Get accumulated game events from the event buffer. */
export function handleGetEvents(
  eventBuffers: Map<string, EventBuffer>,
  agentName: string,
  types?: string[],
  limit?: number,
): { events: unknown[]; count: number } {
  const buffer = eventBuffers.get(agentName);
  if (!buffer) return { events: [], count: 0 };
  const cap = Math.min(limit ?? MAX_EVENTS, MAX_EVENTS);
  const events = buffer.drain(types, cap);
  return { events, count: events.length };
}

/** Get session info for the current agent. */
export function handleGetSessionInfo(
  config: GantryConfig,
  sessions: SessionManager,
  agentName: string | undefined,
): Record<string, unknown> {
  const agentConfig = agentName
    ? config.agents.find((a) => a.name === agentName)
    : undefined;
  return {
    agent: agentName ?? "not logged in",
    proxy: agentConfig?.proxy ?? "direct",
    socks_port: agentConfig?.socksPort ?? null,
    active_agents: sessions.listActive(),
  };
}

// ---------------------------------------------------------------------------
// ToolRegistryDeps — everything the registration functions need from the closure
// ---------------------------------------------------------------------------

export interface ToolRegistryDeps {
  mcpServer: McpServer;
  registeredTools: string[];
  config: GantryConfig;
  sessions: SessionManager;
  statusCache: Map<string, { data: Record<string, unknown>; fetchedAt: number }>;
  battleCache: Map<string, BattleState | null>;
  callTrackers: Map<string, AgentCallTracker>;
  marketCache: MarketCache;
  galaxyGraph: GalaxyGraph;
  sellLog: SellLog;
  gameTools: string[];
  serverDescriptions: Map<string, string>;
  gameHealthRef: GameHealthRef;
  eventBuffers: Map<string, EventBuffer>;
  stateChangingTools: Set<string>;
  getAgentForSession: (sessionId?: string) => string | undefined;
  getTracker: (agentName: string) => AgentCallTracker;
  checkGuardrails: (agentName: string, toolName: string, args?: Record<string, unknown>) => string | null;
  withInjections: (agentName: string, response: McpTextResult) => Promise<McpTextResult>;
  waitForNavCacheUpdate: (
    client: { waitForTick: (ms?: number) => Promise<void>; lastArrivalTick: number | null; waitForNextArrival?: (beforeTick: number | null, timeoutMs?: number) => Promise<boolean> },
    agentName: string,
    beforeSystem: unknown,
    maxTicks?: number,
    arrivalTickBeforeAction?: number | null,
  ) => Promise<boolean>;
  waitForDockCacheUpdate: (
    client: { waitForTick: (ms?: number) => Promise<void> },
    agentName: string,
    maxTicks?: number,
  ) => Promise<boolean>;
  decontaminateLog: (result: unknown) => unknown;
  stripPendingFields: (result: unknown) => void;
  marketReservations?: import("./market-reservations.js").MarketReservationCache;
  analyzeMarketCache?: import("./analyze-market-cache.js").AnalyzeMarketCache;
  /** Nav loop detector — warns when agent travels to the same destination repeatedly. */
  navLoopDetector?: NavLoopDetector;
}

// ---------------------------------------------------------------------------
// buildCompoundActions — shared compound action dispatch table
// ---------------------------------------------------------------------------

export interface CompoundDepsBase {
  statusCache: Map<string, { data: Record<string, unknown>; fetchedAt: number }>;
  battleCache: Map<string, BattleState | null>;
  sellLog: SellLog;
  galaxyGraph: GalaxyGraph;
  /** Optional event buffers — forwarded to compound tools for mid-flight combat checks. */
  eventBuffers?: Map<string, { events?: Array<{ type: string }> }>;
}

export type CompoundActionHandler = (
  client: GameClientLike,
  agentName: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Build compound action dispatch table.
 * Used by v1 registerCompoundTools and v2 PROXY_COMPOUND_ACTIONS.
 * Args use generic keys (id, text, count, destination, system_ids, items, stance, target, etc.)
 * so both v1 (maps named params) and v2 (generic params) can call them.
 */
export function buildCompoundActions(
  deps: CompoundDepsBase,
  ourAgentNames: Set<string>,
): Record<string, CompoundActionHandler> {
  function makeDeps(client: GameClientLike, agentName: string) {
    return {
      client,
      agentName,
      statusCache: deps.statusCache,
      battleCache: deps.battleCache,
      sellLog: deps.sellLog,
      galaxyGraph: deps.galaxyGraph,
      persistBattleState,
      upsertNote,
      eventBuffers: deps.eventBuffers,
    };
  }

  return {
    batch_mine: async (client, agentName, args) => {
      const count = Number(args.count ?? args.id ?? 5);
      return batchMine(makeDeps(client, agentName), count);
    },

    travel_to: async (client, agentName, args) => {
      const destination = String(args.id ?? args.destination ?? "");
      if (!destination) return { error: "id (destination POI) is required for travel_to" };
      const shouldDock = args.should_dock as boolean | undefined;
      return travelTo(makeDeps(client, agentName), destination, resolvePoiId, shouldDock);
    },

    jump_route: async (client, agentName, args) => {
      let systemIds: string[];
      if (typeof args.text === "string") {
        try { systemIds = JSON.parse(args.text); } catch { return { error: "text must be a JSON array of system IDs" }; }
      } else if (Array.isArray(args.system_ids)) {
        const raw = args.system_ids as string[];
        // Resolve display names to IDs so agents can pass names from find_local_route
        systemIds = deps.galaxyGraph.systemCount > 0
          ? raw.map(id => deps.galaxyGraph.resolveSystemId(id) ?? id)
          : raw;
      } else if (typeof args.id === "string" || typeof args.destination === "string") {
        const destArg = String(args.id ?? args.destination);
        // Auto-route via galaxy graph
        const cachedStatus = deps.statusCache.get(agentName);
        const player = cachedStatus ? (cachedStatus.data.player ?? cachedStatus.data) as Record<string, unknown> : null;
        const currentSystem = player?.current_system;
        if (currentSystem && deps.galaxyGraph.systemCount > 0) {
          const fromId = deps.galaxyGraph.resolveSystemId(String(currentSystem)) ?? String(currentSystem);
          const toId = deps.galaxyGraph.resolveSystemId(destArg);
          if (toId && fromId !== toId) {
            const route = deps.galaxyGraph.findRoute(fromId, toId);
            if (route && route.jumps > 1) {
              systemIds = route.route.slice(1);
              log.info(`[${agentName}] jump_route: computed ${systemIds.length}-jump route to ${destArg}`);
            } else {
              systemIds = [toId];
            }
          } else if (toId && fromId === toId) {
            return { error: `Already at destination: ${destArg}` };
          } else {
            systemIds = [destArg];
          }
        } else {
          systemIds = [destArg];
        }
      } else {
        return { error: "Provide system IDs: id/destination for single system, system_ids for explicit array, or text for JSON array" };
      }
      if (!Array.isArray(systemIds) || systemIds.length === 0) return { error: "Empty system ID list" };
      const threshold = args.count ?? args.refuel_threshold ?? 20;
      return jumpRoute(makeDeps(client, agentName), systemIds, threshold as number | undefined);
    },

    multi_sell: async (client, agentName, args) => {
      let items: Array<{ item_id: string; quantity: number }>;
      if (typeof args.text === "string") {
        try { items = JSON.parse(args.text); } catch { return { error: "text must be a JSON array of {item_id, quantity} objects" }; }
      } else if (Array.isArray(args.items)) {
        items = args.items as Array<{ item_id: string; quantity: number }>;
      } else {
        return { error: "Provide items as text (JSON array) or items (array of {item_id, quantity})" };
      }
      if (!Array.isArray(items) || items.length === 0) return { error: "Empty items list" };
      const calledTools = (args._calledTools as Set<string>) ?? new Set<string>();
      return multiSell(makeDeps(client, agentName), items, calledTools);
    },

    scan_and_attack: async (client, agentName, args) => {
      const targetArg = typeof args.id === "string" && !["aggressive", "defensive", "evasive"].includes(args.id)
        ? args.id : typeof args.target === "string" ? args.target : undefined;
      const stanceArg = typeof args.stance === "string" ? args.stance
        : (typeof args.id === "string" && ["aggressive", "defensive", "evasive"].includes(args.id)) ? args.id
        : "aggressive";
      return scanAndAttack(makeDeps(client, agentName), ourAgentNames, targetArg, stanceArg);
    },

    battle_readiness: async (_client, agentName, _args) => {
      return battleReadiness({ agentName, statusCache: deps.statusCache }, ourAgentNames);
    },

    loot_wrecks: async (client, agentName, args) => {
      const maxWrecks = Math.min(typeof args.count === "number" ? args.count : 5, 10);
      return lootWrecks(makeDeps(client, agentName), maxWrecks);
    },

    flee: async (client, agentName, args) => {
      const targetPoi = typeof args.id === "string" ? args.id : typeof args.destination === "string" ? args.destination : undefined;
      return flee(makeDeps(client, agentName), targetPoi);
    },

    get_craft_profitability: async (client, agentName, args) => {
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      const skill_filter = typeof args.skill_filter === "string" ? args.skill_filter : undefined;
      return getCraftProfitability(makeDeps(client, agentName), { limit, skill_filter });
    },

    craft_path_to: async (client, agentName, args) => {
      const item_id = typeof args.item_id === "string" ? args.item_id
        : typeof args.id === "string" ? args.id
        : typeof args.text === "string" ? args.text
        : "";
      return craftPathTo(makeDeps(client, agentName), { item_id });
    },
  };
}

// ---------------------------------------------------------------------------
// registerPassthroughTools
// ---------------------------------------------------------------------------

/**
 * Register all game tools as passthrough MCP tools.
 * Iterates deps.gameTools, skips PROXY_HANDLED_TOOLS, registers each with
 * typed schema (from TOOL_SCHEMAS) or no-param description (NO_PARAM_DESCRIPTIONS).
 * The handler does: auth check, param remapping, POI resolution, guardrails,
 * auto-undock before jump, nav logging, execute, tick wait, error hints,
 * summarization, market enrichment, buy hint, logToolCall.
 */
export function registerPassthroughTools(deps: ToolRegistryDeps): void {
  const {
    mcpServer,
    registeredTools,
    sessions,
    statusCache,
    gameTools,
    serverDescriptions,
    gameHealthRef,
    marketCache,
    getAgentForSession,
    checkGuardrails,
    withInjections,
    waitForNavCacheUpdate,
    waitForDockCacheUpdate,
    decontaminateLog,
    stripPendingFields,
    stateChangingTools,
  } = deps;

  const passthroughDeps: PassthroughDeps = {
    statusCache,
    marketCache,
    gameHealthRef,
    stateChangingTools,
    waitForNavCacheUpdate,
    waitForDockCacheUpdate,
    decontaminateLog,
    stripPendingFields,
    withInjections,
    galaxyGraph: deps.galaxyGraph,
    eventBuffers: deps.eventBuffers,
    marketReservations: deps.marketReservations,
    analyzeMarketCache: deps.analyzeMarketCache,
    recordActivity: (agentName: string) => sessions.recordActivity(agentName),
    rateLimitTracker: getTracker() ?? undefined,
  };

  for (const toolName of gameTools) {
    if (PROXY_HANDLED_TOOLS.has(toolName)) continue;

    const typed = TOOL_SCHEMAS[toolName];
    const noParamDesc = NO_PARAM_DESCRIPTIONS[toolName];

    const toolDescription = typed?.description
      ?? noParamDesc
      ?? serverDescriptions.get(toolName)
      ?? `SpaceMolt ${toolName} command`;

    const toolSchema = typed?.schema
      ?? z.object({}).passthrough().optional();

    mcpServer.registerTool(toolName, {
      description: toolDescription,
      inputSchema: toolSchema,
    }, async (args: unknown, extra) => {
      const agentName = getAgentForSession(extra.sessionId);
      if (!agentName) return textResult({ error: "not logged in — call login first" });

      const client = sessions.getClient(agentName);
      if (!client) return textResult({ error: "no session" });

      // Pass args directly — no envelope wrapping
      const argsObj = args as Record<string, unknown> | undefined;
      // Strip hallucinated parameters that agents sometimes inject
      if (argsObj) delete argsObj.session_id;

      // Capture nav destination BEFORE remapping (for diagnostic logging)
      let navDest: unknown;
      if (argsObj && (toolName === "jump" || toolName === "travel")) {
        navDest = toolName === "jump"
          ? argsObj.system_id
          : (argsObj.destination_id ?? argsObj.poi_id);
      }

      // Remap agent-facing parameter names to game server names.
      // The game server uses target_system/target_poi but our schemas expose
      // system_id/destination_id for clarity. Remap before sending.
      if (argsObj) {
        if (toolName === "jump" && "system_id" in argsObj) {
          argsObj.target_system = argsObj.system_id;
          delete argsObj.system_id;
        }
        if (toolName === "travel" && "destination_id" in argsObj) {
          argsObj.target_poi = argsObj.destination_id;
          delete argsObj.destination_id;
        }
        if (toolName === "travel" && "poi_id" in argsObj) {
          argsObj.target_poi = argsObj.poi_id;
          delete argsObj.poi_id;
        }
        if (toolName === "find_route" && "destination_system_id" in argsObj) {
          argsObj.target_system = argsObj.destination_system_id;
          delete argsObj.destination_system_id;
        }
        if (toolName === "search_systems" && "name" in argsObj) {
          argsObj.query = argsObj.name;
          delete argsObj.name;
        }
        // Note: forum_create_thread uses "content" on both our side and the server — no remap needed.
      }

      // Resolve POI name to ID for passthrough travel calls
      if (toolName === "travel" && argsObj?.target_poi && typeof argsObj.target_poi === "string") {
        const resolved = resolvePoiId(agentName, argsObj.target_poi, statusCache);
        if (resolved !== argsObj.target_poi) {
          log.info(`[${agentName}] passthrough travel resolved POI: "${argsObj.target_poi}" → "${resolved}"`);
          argsObj.target_poi = resolved;
        }
      }

      const payload = argsObj && Object.keys(argsObj).length > 0 ? argsObj : undefined;

      // Guardrails: duplicate detection + call limits
      const blocked = checkGuardrails(agentName, toolName, payload);
      if (blocked) return textResult({ error: blocked });

      return handlePassthrough(passthroughDeps, client, agentName, toolName, toolName, payload, navDest);
    });
    registeredTools.push(toolName);
  }
}

// ---------------------------------------------------------------------------
// registerCompoundTools
// ---------------------------------------------------------------------------

/**
 * Register compound tools (multi-step game operations), event tools, and utility tools.
 *
 * Compound tools: batch_mine, travel_to, jump_route, multi_sell, scan_and_attack,
 *   battle_readiness, loot_wrecks
 * Event tools: get_events
 * Utility tools: get_session_info
 */
export function registerCompoundTools(deps: ToolRegistryDeps): void {
  const {
    mcpServer,
    registeredTools,
    config,
    sessions,
    statusCache,
    battleCache,
    galaxyGraph,
    sellLog,
    eventBuffers,
    getAgentForSession,
    getTracker,
    checkGuardrails,
    withInjections,
    navLoopDetector,
  } = deps;

  // Build set of our own agent names for friendly-fire prevention in combat
  const OUR_AGENT_NAMES = new Set(config.agents.map(a => a.name.replace(/-/g, " ").toLowerCase()));

  // Build shared compound action dispatch table
  const compoundActions = buildCompoundActions(
    { statusCache, battleCache, sellLog, galaxyGraph, eventBuffers: eventBuffers as Map<string, { events?: Array<{ type: string }> }> },
    OUR_AGENT_NAMES,
  );

  /**
   * Check if a pirate_combat event should interrupt a compound tool and return the
   * auto-trigger action name, or undefined if no interrupt needed.
   * Used by interruptible compound tools (batch_mine, travel_to, jump_route, multi_sell).
   */
  function checkAutoTriggerInterrupt(agentName: string, originalAction: string): string | undefined {
    const effectiveAction = getAutoTriggerAction(config, eventBuffers, agentName, originalAction);
    return effectiveAction !== originalAction ? effectiveAction : undefined;
  }

  /**
   * Execute an auto-triggered combat interrupt in place of the original compound action.
   * Logs the substituted action and returns the injected MCP result.
   */
  async function runAutoTrigger(
    autoTrigger: string,
    originalAction: string,
    client: GameClient,
    agentName: string,
  ): Promise<McpTextResult> {
    const pendingId = logToolCallStart(agentName, autoTrigger, { _original_action: originalAction }, { isCompound: true });
    const t0 = Date.now();
    const result = await compoundActions[autoTrigger](client as unknown as GameClient, agentName, {});
    logToolCallComplete(pendingId, agentName, autoTrigger, result, Date.now() - t0, { isCompound: true });
    return withInjections(agentName, textResult(result));
  }

  // --- batch_mine ---

  mcpServer.registerTool("batch_mine", {
    description: "Mine multiple times in one call. Returns all ore mined and final cargo state. Use this instead of calling mine() repeatedly.",
    inputSchema: {
      count: z.number().int().min(1).max(50).describe("Number of mine actions to execute"),
    },
  }, async ({ count }, extra) => {
    const agentName = getAgentForSession(extra.sessionId);
    if (!agentName) return textResult({ error: "not logged in" });
    const blocked = checkGuardrails(agentName, "batch_mine", { count });
    if (blocked) return textResult({ error: blocked });
    const client = sessions.getClient(agentName);
    if (!client) return textResult({ error: "no session" });

    const autoTrigger = checkAutoTriggerInterrupt(agentName, "batch_mine");
    if (autoTrigger) return runAutoTrigger(autoTrigger, "batch_mine", client as unknown as GameClient, agentName);

    const pendingId = logToolCallStart(agentName, "batch_mine", { count }, { isCompound: true });
    const compoundStartMs = Date.now();
    const compoundResult = await compoundActions.batch_mine(client as unknown as GameClient, agentName, { count });
    logToolCallComplete(pendingId, agentName, "batch_mine", compoundResult, Date.now() - compoundStartMs, { isCompound: true });
    return await withInjections(agentName, textResult(compoundResult));
  });
  registeredTools.push("batch_mine");

  // --- travel_to ---

  mcpServer.registerTool("travel_to", {
    description: "Travel to a POI and optionally dock. Handles undock automatically. Use this instead of calling undock/travel/dock separately.",
    inputSchema: {
      destination: z.string().describe("Target POI ID (e.g., 'main_belt', 'sol_central')"),
      should_dock: z.boolean().optional().describe("Whether to dock on arrival (default: true for stations)"),
    },
  }, async ({ destination, should_dock }, extra) => {
    const agentName = getAgentForSession(extra.sessionId);
    if (!agentName) return textResult({ error: "not logged in" });
    const blocked = checkGuardrails(agentName, "travel_to", { destination, should_dock });
    if (blocked) return textResult({ error: blocked });
    const client = sessions.getClient(agentName);
    if (!client) return textResult({ error: "no session" });

    const autoTrigger = checkAutoTriggerInterrupt(agentName, "travel_to");
    if (autoTrigger) return runAutoTrigger(autoTrigger, "travel_to", client as unknown as GameClient, agentName);

    const pendingId = logToolCallStart(agentName, "travel_to", { destination, should_dock }, { isCompound: true });
    const t0 = Date.now();
    const travelResult = await compoundActions.travel_to(client as unknown as GameClient, agentName, { destination, should_dock });
    logToolCallComplete(pendingId, agentName, "travel_to", travelResult, Date.now() - t0, { isCompound: true });

    // Nav loop detection — warn if agent is repeatedly traveling to the same destination
    if (navLoopDetector && destination && typeof travelResult === "object" && travelResult !== null) {
      try {
        const { warning } = navLoopDetector.record(agentName, destination);
        if (warning) {
          (travelResult as Record<string, unknown>)._nav_loop_warning = warning;
        }
      } catch { /* non-fatal */ }
    }

    return await withInjections(agentName, textResult(travelResult));
  });
  registeredTools.push("travel_to");

  // --- jump_route ---

  mcpServer.registerTool("jump_route", {
    description: "Jump through systems sequentially. Handles undock and refuel automatically. Returns final location.",
    inputSchema: {
      system_ids: z.array(z.string()).max(30).optional().describe("Ordered list of system IDs to jump through"),
      destination: z.string().optional().describe("Destination system name or ID. Route computed automatically from current location."),
      refuel_threshold: z.number().int().min(0).optional().describe("Refuel when fuel drops below this (default: 20)"),
    },
  }, async (args, extra) => {
    const system_ids = args.system_ids as string[] | undefined;
    const destination = args.destination as string | undefined;
    const refuel_threshold = args.refuel_threshold as number | undefined;
    const agentName = getAgentForSession(extra.sessionId);
    if (!agentName) return textResult({ error: "not logged in" });
    const blocked = checkGuardrails(agentName, "jump_route", { system_ids, refuel_threshold });
    if (blocked) return textResult({ error: blocked });
    const client = sessions.getClient(agentName);
    if (!client) return textResult({ error: "no session" });

    const autoTrigger = checkAutoTriggerInterrupt(agentName, "jump_route");
    if (autoTrigger) return runAutoTrigger(autoTrigger, "jump_route", client as unknown as GameClient, agentName);

    const displayIds = Array.isArray(system_ids) ? system_ids.slice(0, 3) : [];
    const pendingId = logToolCallStart(agentName, "jump_route", { system_ids: displayIds, destination }, { isCompound: true });
    const t0 = Date.now();
    // Map v1 named params to generic args (system_ids takes precedence, then destination)
    const jumpRouteResult = await compoundActions.jump_route(
      client as unknown as GameClient,
      agentName,
      { system_ids, destination, count: refuel_threshold },
    );
    logToolCallComplete(pendingId, agentName, "jump_route", jumpRouteResult, Date.now() - t0, { isCompound: true });
    return await withInjections(agentName, textResult(jumpRouteResult));
  });
  registeredTools.push("jump_route");

  // --- multi_sell ---

  mcpServer.registerTool("multi_sell", {
    description: "Sell multiple item types in one call, with proper tick spacing between each. Use this instead of calling sell() repeatedly. Returns per-item results and final credits.",
    inputSchema: {
      items: z.array(z.object({
        item_id: z.string().describe("Item ID to sell (e.g. 'iron_ore', 'steel_plate')"),
        quantity: z.number().int().min(1).describe("Quantity to sell"),
      })).min(1).max(20).describe("List of items to sell"),
    },
  }, async ({ items }, extra) => {
    const agentName = getAgentForSession(extra.sessionId);
    if (!agentName) return textResult({ error: "not logged in — call login first" });
    const blocked = checkGuardrails(agentName, "multi_sell", { items });
    if (blocked) return textResult({ error: blocked });
    const client = sessions.getClient(agentName);
    if (!client) return textResult({ error: "no session" });

    const pendingId = logToolCallStart(agentName, "multi_sell", { items_count: items.length }, { isCompound: true });
    const multiSellStartMs = Date.now();
    const tracker = getTracker(agentName);
    // Map v1 named params to generic args; inject _calledTools for analyze_market gate
    const sellResult = await compoundActions.multi_sell(
      client as unknown as GameClient,
      agentName,
      { items, _calledTools: tracker.calledTools },
    );
    logToolCallComplete(pendingId, agentName, "multi_sell", sellResult, Date.now() - multiSellStartMs, { isCompound: true });
    return await withInjections(agentName, textResult(sellResult));
  });
  registeredTools.push("multi_sell");

  // --- scan_and_attack ---

  mcpServer.registerTool("scan_and_attack", {
    description: "PvP combat loop (PLAYER vs PLAYER only): scan nearby entities, attack first available PLAYER target, monitor battle, auto-loot wrecks. NOTE: NPC/pirate combat is AUTOMATIC — the game resolves it server-side when you travel through lawless space. This tool cannot attack NPCs. For NPC loot, use loot_wrecks after traveling.",
    inputSchema: {
      stance: z.enum(["aggressive", "defensive", "evasive"]).optional().describe("Combat stance (default: aggressive)"),
      target: z.string().optional().describe("Specific target username or player_id to attack. If omitted, attacks first available target."),
    },
  }, async ({ stance, target: targetArg }, extra) => {
    const agentName = getAgentForSession(extra.sessionId);
    if (!agentName) return textResult({ error: "not logged in" });
    const blocked = checkGuardrails(agentName, "scan_and_attack", { stance });
    if (blocked) return textResult({ error: blocked });
    const client = sessions.getClient(agentName);
    if (!client) return textResult({ error: "no session" });

    const pendingId = logToolCallStart(agentName, "scan_and_attack", { stance }, { isCompound: true });
    const combatStartMs = Date.now();
    // Map v1 named params to generic args
    const combatResult = await compoundActions.scan_and_attack(
      client as unknown as GameClient,
      agentName,
      { stance, target: targetArg },
    );
    logToolCallComplete(pendingId, agentName, "scan_and_attack", combatResult, Date.now() - combatStartMs, { isCompound: true });
    return await withInjections(agentName, textResult(combatResult));
  });
  registeredTools.push("scan_and_attack");

  // --- battle_readiness ---

  mcpServer.registerTool("battle_readiness", {
    description: "Check combat readiness: hull, fuel, ammo, insurance, nearby threats. Call before scan_and_attack to assess if you're ready to fight.",
    inputSchema: {},
  }, async (_args, extra) => {
    const agentName = getAgentForSession(extra.sessionId);
    if (!agentName) return textResult({ error: "not logged in" });

    const readinessResult = await compoundActions.battle_readiness(
      {} as unknown as GameClient,
      agentName,
      {},
    );
    return await withInjections(agentName, textResult(readinessResult));
  });
  registeredTools.push("battle_readiness");

  // --- loot_wrecks ---

  mcpServer.registerTool("loot_wrecks", {
    description: "Salvage up to N wrecks in your area. Calls get_wrecks, then salvage_wreck on each. Returns loot per wreck and final cargo.",
    inputSchema: {
      count: z.number().int().min(1).max(10).optional().describe("Max wrecks to salvage (default 5, max 10)"),
    },
  }, async ({ count }, extra) => {
    const agentName = getAgentForSession(extra.sessionId);
    if (!agentName) return textResult({ error: "not logged in" });
    const blocked = checkGuardrails(agentName, "loot_wrecks", { count });
    if (blocked) return textResult({ error: blocked });
    const client = sessions.getClient(agentName);
    if (!client) return textResult({ error: "no session" });

    const pendingId = logToolCallStart(agentName, "loot_wrecks", { count: count ?? 5 }, { isCompound: true });
    const lootStartMs = Date.now();
    const lootResult = await compoundActions.loot_wrecks(client as unknown as GameClient, agentName, { count: count ?? 5 });
    logToolCallComplete(pendingId, agentName, "loot_wrecks", lootResult, Date.now() - lootStartMs, { isCompound: true });
    return await withInjections(agentName, textResult(lootResult));
  });
  registeredTools.push("loot_wrecks");

  // --- flee ---

  mcpServer.registerTool("flee", {
    description: "Escape active combat safely. Triggers flee stance, waits for escape, undocks, and travels to nearest station. Use when hull is critical or battle seems unwinnable.",
    inputSchema: {
      target_poi: z.string().optional().describe("Optional destination POI (e.g., 'sol_central'). If omitted, flees to nearest station."),
    },
  }, async ({ target_poi }, extra) => {
    const agentName = getAgentForSession(extra.sessionId);
    if (!agentName) return textResult({ error: "not logged in" });
    const blocked = checkGuardrails(agentName, "flee", { target_poi });
    if (blocked) return textResult({ error: blocked });
    const client = sessions.getClient(agentName);
    if (!client) return textResult({ error: "no session" });

    const pendingId = logToolCallStart(agentName, "flee", { target_poi: target_poi ?? "auto" }, { isCompound: true });
    const fleeStartMs = Date.now();
    const fleeResult = await compoundActions.flee(client as unknown as GameClient, agentName, { id: target_poi });
    logToolCallComplete(pendingId, agentName, "flee", fleeResult, Date.now() - fleeStartMs, { isCompound: true });
    return await withInjections(agentName, textResult(fleeResult));
  });
  registeredTools.push("flee");

  // --- get_craft_profitability ---

  mcpServer.registerTool("get_craft_profitability", {
    description: "Rank craftable recipes by profit using current market prices. Returns top recipes sorted by profit descending.",
    inputSchema: {
      limit: z.number().int().min(1).max(50).optional().describe("Max recipes to return (default 10)"),
      skill_filter: z.string().optional().describe("Filter by craft skill name (e.g. 'refining', 'engineering')"),
    },
  }, async ({ limit, skill_filter }, extra) => {
    const agentName = getAgentForSession(extra.sessionId);
    if (!agentName) return textResult({ error: "not logged in" });
    const blocked = checkGuardrails(agentName, "get_craft_profitability", { limit, skill_filter });
    if (blocked) return textResult({ error: blocked });
    const client = sessions.getClient(agentName);
    if (!client) return textResult({ error: "no session" });

    const pendingId = logToolCallStart(agentName, "get_craft_profitability", { limit: limit ?? 10, skill_filter }, { isCompound: true });
    const startMs = Date.now();
    const craftResult = await compoundActions.get_craft_profitability(
      client as unknown as GameClient,
      agentName,
      { limit, skill_filter },
    );
    logToolCallComplete(pendingId, agentName, "get_craft_profitability", craftResult, Date.now() - startMs, { isCompound: true });
    return await withInjections(agentName, textResult(craftResult));
  });
  registeredTools.push("get_craft_profitability");

  // --- get_events ---

  mcpServer.registerTool("get_events", {
    description: "Get accumulated game events (chat, combat, arrivals). Events are cleared after reading. Max 3 calls per session — do NOT poll.",
    inputSchema: {
      types: z.array(z.string()).optional().describe("Filter by event types (e.g. ['chat_message', 'arrived']). Omit for all events."),
      limit: z.number().int().min(1).max(MAX_EVENTS).optional().describe(`Max events to return (default: ${MAX_EVENTS}, max: ${MAX_EVENTS}). Excess events stay in buffer.`),
    },
  }, async ({ types, limit }, extra) => {
    const agentName = getAgentForSession(extra.sessionId);
    if (!agentName) return textResult({ error: "not logged in" });
    return textResult(handleGetEvents(eventBuffers, agentName, types, limit));
  });
  registeredTools.push("get_events");

  // --- get_session_info ---

  mcpServer.registerTool("get_session_info", {
    description: "Get info about your current proxy session (agent name, proxy route, active sessions).",
  }, async (extra) => {
    const agentName = getAgentForSession(extra.sessionId);
    return textResult(handleGetSessionInfo(config, sessions, agentName));
  });
  registeredTools.push("get_session_info");
}
