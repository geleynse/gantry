import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import * as z from "zod";
import { createLogger } from "../lib/logger.js";
import { FLEET_DIR, SCHEMA_TTL_MS } from "../config.js";

const log = createLogger("schema");

// Schema cache lives in FLEET_DIR/data alongside other persistent files.
// Persists across proxy restarts; invalidated on game version change.
// Computed dynamically to support tests that call setConfigForTesting()
function getSchemaCachePath(): string {
  return join(FLEET_DIR, "data", "schema-cache.json");
}

// TTL for cached schemas: 1 hour by default. Auto-refreshes to pick up new endpoints.

interface SchemaCacheEntry {
  commands: GameCommand[];
  serverTools: ServerTool[];
  fetchedAt: number;
  ttl: number; // TTL in milliseconds
}

interface SchemaCache {
  v1: SchemaCacheEntry | null;
  v2: Record<string, SchemaCacheEntry>;
  cachedAt: number;
}

function readSchemaCache(): SchemaCache | null {
  try {
    return JSON.parse(readFileSync(getSchemaCachePath(), "utf-8"));
  } catch {
    return null;
  }
}

function writeSchemaCache(cache: SchemaCache): void {
  try {
    mkdirSync(dirname(getSchemaCachePath()), { recursive: true });
    writeFileSync(getSchemaCachePath(), JSON.stringify(cache, null, 2));
  } catch (err) {
    const cachePath = getSchemaCachePath();

    // In test environments, FLEET_DIR may be /dev/null; silently skip cache writes
    if (cachePath.includes("/dev/null")) {
      return;
    }

    // Permission errors in test environments: skip cache write but don't fail
    // This handles cases where FLEET_DIR points to an unwritable directory
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'EACCES') {
      log.warn(`Cannot write schema cache (permission denied): ${cachePath}`);
      return;
    }

    throw err;
  }
}

/**
 * Check if a cached entry is still valid based on its TTL.
 * Cache is valid if (now - fetchedAt) < ttl.
 */
function isCacheEntryValid(entry: SchemaCacheEntry | null): boolean {
  if (!entry) return false;
  const age = Date.now() - entry.fetchedAt;
  return age < entry.ttl;
}

/** Delete the schema cache file. Called when game version changes. */
export function invalidateSchemaCache(): void {
  try {
    unlinkSync(getSchemaCachePath());
    log.info("Cache invalidated");
  } catch {
    // File doesn't exist — that's fine
  }
}

export interface GameCommand {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description?: string; required?: boolean }>;
}

// Tools the game server exposes but we don't want agents using.
// These are filtered out after fetching the tool list.
// Review periodically as agents gain capabilities.
const DENIED_TOOLS = new Set([
  // Auth/meta — handled by proxy or not useful
  "register",
  "login",
  "logout",
  "get_commands",
  "get_version",
  "get_notifications",

  // Cosmetic/identity — agents shouldn't touch
  "set_colors",
  "set_anonymous",
  "set_status",

  // Destructive/risky — moved to agentDeniedTools
  // "self_destruct",
  // "jettison",

  // Drones — not implemented yet, agents hallucinate these
  "deploy_drone",
  "recall_drone",
  "order_drone",


  // Game's built-in notes — we use our own MCP note tools (write_doc/read_doc)
  "create_note",
  "read_note",
  "write_note",
  "get_notes",

  // v2 consolidated tools — agents hallucinate these and waste tokens
  // Block them so agents use the regular tool names instead
  "v2_get_missions",
  "v2_get_cargo",
  "v2_get_ship",
  "v2_get_state",
  "v2_get_player",
  "v2_get_queue",
  "v2_get_skills",
  "get_state",

  // Destructive forum actions — agents shouldn't delete content
  "forum_delete_thread",
  "forum_delete_reply",

  // Credits are wallet-only — these tools return errors
  "deposit_credits",
  "withdraw_credits",

  // Factions — too complex for current fleet, adds 36 tools to system prompt
  "create_faction",
  "join_faction",
  "leave_faction",
  "faction_accept_peace",
  "faction_cancel_mission",
  "faction_create_buy_order",
  "faction_create_role",
  "faction_create_sell_order",
  "faction_declare_war",
  "faction_decline_invite",
  "faction_delete_role",
  "faction_delete_room",
  "faction_deposit_credits",
  "faction_deposit_items",
  "faction_edit",
  "faction_edit_role",
  "faction_get_invites",
  "faction_gift",
  "faction_info",
  "faction_intel_status",
  "faction_invite",
  "faction_kick",
  "faction_list",
  "faction_list_missions",
  "faction_post_mission",
  "faction_promote",
  "faction_propose_peace",
  "faction_query_trade_intel",
  "faction_rooms",
  "faction_set_ally",
  "faction_set_enemy",
  "faction_submit_intel",
  "faction_submit_trade_intel",
  "faction_trade_intel_status",
  "faction_visit_room",
  "faction_withdraw_credits",
  "faction_withdraw_items",
  "faction_write_room",

  // Huge response (188KB) — use catalog instead
  "get_recipes",
]);

// Patches for tools with known bad/missing specs from the server
const SCHEMA_PATCHES: Record<string, Partial<GameCommand>> = {
  // Add patches as we discover issues with server-provided schemas
};

// Known parameter remaps: our agent-facing name → game server name.
// Used by the passthrough handler in server.ts and the drift detector here.
export const PARAM_REMAPS: Record<string, Record<string, string>> = {
  jump: { system_id: "target_system" },
  travel: { destination_id: "target_poi", poi_id: "target_poi" },
  find_route: { destination_system_id: "target_system" },
  search_systems: { name: "query" },
  craft: { count: "quantity" },
};

/** Raw tool data from the game server including inputSchema. */
interface ServerTool {
  name: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
}

/**
 * Retry a fetch that may return 429 (rate limited).
 * Waits for Retry-After header or exponential backoff before retrying.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxRetries = 3,
  label = "fetch",
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetch(url, init);
    if (resp.status !== 429 || attempt === maxRetries) return resp;

    const retryAfter = resp.headers.get("retry-after");
    const waitMs = retryAfter
      ? Math.min(parseInt(retryAfter, 10) * 1000 || 5000, 30000)
      : Math.min(1000 * Math.pow(2, attempt), 15000);
    log.info(`${label}: 429 rate limited, retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${maxRetries})`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  // Unreachable, but TypeScript needs it
  throw new Error("fetchWithRetry: exhausted retries");
}

/**
 * Perform the 3-step MCP handshake (initialize → initialized → tools/list)
 * against any MCP endpoint URL and return the raw server tools.
 * Used by both v1 and v2 fetch functions.
 */
async function fetchMcpToolsFromUrl(url: string, label: string): Promise<ServerTool[]> {
  const initResp = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      id: 1,
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "gantry", version: "0.1.0" },
      },
    }),
  }, 3, `${label} initialize`);

  if (!initResp.ok) return [];

  const sessionId = initResp.headers.get("mcp-session-id");
  if (!sessionId) return [];

  const sessionHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "mcp-session-id": sessionId,
  };

  await fetchWithRetry(url, {
    method: "POST",
    headers: sessionHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }, 3, `${label} initialized`);

  const toolsResp = await fetchWithRetry(url, {
    method: "POST",
    headers: sessionHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 2 }),
  }, 3, `${label} tools/list`);

  if (!toolsResp.ok) return [];

  let toolsData: { result?: { tools?: ServerTool[] } };
  try {
    toolsData = JSON.parse(await toolsResp.text()) as { result?: { tools?: ServerTool[] } };
  } catch (err) {
    log.warn(`${label}: JSON parse error on tools/list response — ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  return toolsData.result?.tools ?? [];
}

function toolsToCommands(serverTools: ServerTool[]): GameCommand[] {
  return serverTools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    parameters: {},
  }));
}

export async function fetchGameCommands(mcpUrl: string): Promise<{ commands: GameCommand[]; serverTools: ServerTool[] }> {
  try {
    const serverTools = await fetchMcpToolsFromUrl(mcpUrl, "fetchGameCommands");
    return { commands: toolsToCommands(serverTools), serverTools };
  } catch (err) {
    log.warn(`fetchGameCommands failed: ${err instanceof Error ? err.message : String(err)}`);
    return { commands: [], serverTools: [] };
  }
}

export function applyPatches(commands: GameCommand[]): GameCommand[] {
  return commands.map((cmd) => {
    const patch = SCHEMA_PATCHES[cmd.name];
    if (!patch) return cmd;
    return { ...cmd, ...patch };
  });
}

/**
 * Compare our TOOL_SCHEMAS parameter names against the game server's inputSchema.
 * Logs warnings for mismatches, accounting for known PARAM_REMAPS.
 * Runs once at startup — no runtime cost.
 */
export function checkSchemaDrift(
  ourSchemaParams: Record<string, string[]>,
  serverTools: ServerTool[],
): void {
  // Params the server includes on every tool that we handle at proxy level — not real drift.
  const IGNORED_SERVER_PARAMS = new Set(["session_id"]);

  const serverMap = new Map<string, Set<string>>();
  for (const tool of serverTools) {
    if (tool.inputSchema?.properties) {
      const params = new Set(
        Object.keys(tool.inputSchema.properties).filter((p) => !IGNORED_SERVER_PARAMS.has(p)),
      );
      serverMap.set(tool.name, params);
    }
  }

  let driftCount = 0;

  for (const [toolName, ourParams] of Object.entries(ourSchemaParams)) {
    const serverParams = serverMap.get(toolName);
    if (!serverParams) continue; // Tool not on server or no schema — skip

    const remaps = PARAM_REMAPS[toolName] ?? {};
    // Build set of our param names as the server would see them (after remapping)
    const ourMappedParams = new Set(
      ourParams.map((p) => remaps[p] ?? p),
    );

    // Check: our params not on server (after remapping)
    const ourExtra: string[] = [];
    for (const p of ourParams) {
      const mapped = remaps[p] ?? p;
      if (!serverParams.has(mapped)) {
        const remapNote = remaps[p] ? ` (remapped to ${mapped})` : "";
        ourExtra.push(`${p}${remapNote}`);
      }
    }

    // Check: server params not in our schema
    const serverExtra: string[] = [];
    for (const p of serverParams) {
      if (!ourMappedParams.has(p)) {
        serverExtra.push(p);
      }
    }

    if (ourExtra.length > 0 || serverExtra.length > 0) {
      driftCount++;
      const parts: string[] = [];
      if (ourExtra.length > 0) parts.push(`our extra: [${ourExtra.join(", ")}]`);
      if (serverExtra.length > 0) parts.push(`server extra: [${serverExtra.join(", ")}]`);
      log.info(`⚠ Drift: ${toolName} — ${parts.join(", ")}`);
    }
  }

  if (driftCount === 0) {
    log.info("No schema drift detected");
  } else {
    log.info(`⚠ ${driftCount} tool(s) with schema drift`);
  }
}

/**
 * Fetch game commands from the server via MCP protocol, apply patches
 * and deny list, and build the tool list + description map.
 * Falls back to the static list if the server is unreachable.
 */
export async function resolveGameTools(
  mcpUrl: string,
  fallbackTools: string[],
  ourSchemaParams?: Record<string, string[]>,
): Promise<{ tools: string[]; descriptions: Map<string, string> }> {
  const descriptions = new Map<string, string>();

  // Try cached schema first
  const cached = readSchemaCache();
  let rawCommands: GameCommand[];
  let serverTools: ServerTool[];

  if (cached?.v1 && isCacheEntryValid(cached.v1)) {
    const ageMs = Date.now() - cached.v1.fetchedAt;
    const ageMinutes = Math.round(ageMs / 60000);
    log.info(`Using cached v1 schema (${cached.v1.serverTools.length} tools, fetched ${ageMinutes} min ago, TTL: 24h)`);
    rawCommands = cached.v1.commands;
    serverTools = cached.v1.serverTools;
  } else {
    if (cached?.v1) {
      const ageMs = Date.now() - cached.v1.fetchedAt;
      const ageHours = Math.round(ageMs / 3600000);
      log.info(`v1 cache stale (${ageHours} hours old, TTL: 24h), refreshing from server`);
    }
    const fetched = await fetchGameCommands(mcpUrl);
    rawCommands = fetched.commands;
    serverTools = fetched.serverTools;

    // Write to cache if fetch succeeded
    if (rawCommands.length > 0) {
      const c = cached ?? { v1: null, v2: {}, cachedAt: 0 };
      c.v1 = { commands: rawCommands, serverTools, fetchedAt: Date.now(), ttl: SCHEMA_TTL_MS };
      c.cachedAt = Date.now();
      writeSchemaCache(c);
      log.info("Cached v1 schema to disk (24h TTL)");
    }
  }

  const commands = applyPatches(rawCommands);
  if (commands.length === 0) {
    log.info("Could not fetch commands from game server, using static GAME_TOOLS");
    return { tools: fallbackTools, descriptions };
  }

  // Filter out denied tools
  const allowed: GameCommand[] = [];
  const deniedNames: string[] = [];
  for (const cmd of commands) {
    if (DENIED_TOOLS.has(cmd.name)) deniedNames.push(cmd.name);
    else allowed.push(cmd);
  }
  if (deniedNames.length > 0) {
    log.info(`Filtered ${deniedNames.length} denied tools: ${deniedNames.join(", ")}`);
  }

  const tools = allowed.map((cmd) => cmd.name);
  for (const cmd of allowed) {
    if (cmd.description) descriptions.set(cmd.name, cmd.description);
  }

  // Log differences vs static list for visibility
  const staticSet = new Set(fallbackTools);
  const dynamicSet = new Set(tools);
  const added = tools.filter((t) => !staticSet.has(t));
  const removed = fallbackTools.filter((t) => !dynamicSet.has(t));
  if (added.length > 0) log.info(`New tools from server: ${added.join(", ")}`);
  if (removed.length > 0) log.info(`Tools in static list but not on server: ${removed.join(", ")}`);
  log.info(`Loaded ${tools.length} tools from game server (${commands.length} total, ${deniedNames.length} denied)`);

  // Schema drift detection — compare our Zod schemas vs server inputSchemas
  if (ourSchemaParams && serverTools.length > 0) {
    checkSchemaDrift(ourSchemaParams, serverTools);
  }

  return { tools, descriptions };
}

// --- v2 MCP support ---

/**
 * v1 tool names that v2 agents might hallucinate. Used to prevent agents on the
 * v2 endpoint from trying to call individual v1 tools that don't exist for them.
 * These are the inverse of DENIED_TOOLS blocking v2 names on the v1 endpoint.
 */
export const DENIED_TOOLS_V2 = new Set([
  // All individual game tools are consolidated into v2 action-dispatch tools.
  // Agents on v2 should never call these directly.
  "mine", "travel", "jump", "dock", "undock", "refuel", "repair",
  "sell", "buy", "craft", "cloak", "scan", "attack", "battle",
  "get_cargo", "get_system", "get_nearby", "get_poi", "get_map",
  "get_missions", "get_active_missions", "get_skills", "get_ship", "get_base",
  "accept_mission", "complete_mission", "decline_mission", "abandon_mission",
  "deposit_items", "withdraw_items", "view_storage",
  "create_sell_order", "create_buy_order", "cancel_order", "modify_order", "view_orders",
  "view_market", "analyze_market", "estimate_purchase",
  "find_route", "search_systems", "survey_system",
  "captains_log_add", "captains_log_list",
  "buy_ship", "sell_ship", "list_ships", "switch_ship",
  "shipyard_showroom", "commission_ship", "commission_quote", "claim_commission",
  "commission_status", "cancel_commission", "browse_ships", "buy_listed_ship",
  "list_ship_for_sale", "cancel_ship_listing", "refit_ship",
  "install_mod", "uninstall_mod", "use_item", "send_gift", "claim",
  "get_insurance_quote", "buy_insurance", "claim_insurance", "reload", "set_home_base",
  "chat", "get_chat_history",
  "forum_list", "forum_get_thread", "forum_create_thread", "forum_reply", "forum_upvote",
  "trade_offer", "trade_accept", "trade_decline", "trade_cancel", "get_trades",
  "loot_wreck", "salvage_wreck", "sell_wreck", "scrap_wreck", "tow_wreck", "release_tow",
  "get_wrecks", "get_battle_status",
  "help", "catalog", "get_guide",
  "repair_module", "jettison", "inspect_cargo", "view_faction_storage",
  "view_completed_mission", "completed_missions", "get_action_log",
  "faction_query_intel", "distress_signal", "captains_log_get",
]);

/**
 * v2 tool:action pairs that are denied (maps to DENIED_TOOLS for v1).
 * Keys are v2 tool names, values are Sets of denied action names.
 */
export const DENIED_ACTIONS_V2: Record<string, Set<string>> = {
  spacemolt: new Set(["trade_offer"]),
  spacemolt_social: new Set([
    "set_colors", "set_anonymous", "set_status",
    "create_note", "read_note", "write_note", "get_notes",
  ]),
  spacemolt_auth: new Set(["register"]),
};

/**
 * v2-to-v1 parameter remapping: maps v2 generic params to v1 specific params per action.
 * The v2 consolidated tools use generic param names (id, text, count, quantity)
 * but the WebSocket expects v1-specific param names (target_system, target_poi, etc.).
 *
 * Keys are v1 action names (extracted from the v2 `action` param).
 * Values map v2 generic param → v1 specific param name.
 */
export const V2_TO_V1_PARAM_MAP: Record<string, Record<string, string>> = {
  // spacemolt tool — core gameplay
  jump: { id: "target_system" },
  travel: { id: "target_poi" },
  sell: { id: "item_id" },
  buy: { id: "item_id" },
  craft: { id: "recipe_id" },
  find_route: { id: "target_system" },
  search_systems: { text: "query" },
  attack: { id: "target_id" },
  scan: { id: "target_id" },
  accept_mission: { id: "mission_id" },
  complete_mission: { id: "mission_id" },
  decline_mission: { id: "mission_id" },
  abandon_mission: { id: "mission_id" },
  get_system: { id: "system_id" },
  get_poi: { id: "poi_id" },
  get_map: { id: "system_id" },
  install_mod: { id: "module_id" },
  uninstall_mod: { id: "module_id" },
  estimate_purchase: { id: "item_id" },
  use_item: { id: "item_id" },
  send_gift: { id: "target_id", text: "item_id" },
  faction_upgrade: { id: "facility_id", text: "facility_type" },
  // spacemolt_ship tool
  buy_ship: { id: "ship_class" },
  switch_ship: { id: "ship_id" },
  sell_ship: { id: "ship_id" },
  commission_ship: { id: "ship_class" },
  commission_quote: { id: "ship_class" },
  claim_commission: { id: "commission_id" },
  cancel_commission: { id: "commission_id" },
  supply_commission: { id: "commission_id" },
  buy_listed_ship: { id: "listing_id" },
  cancel_ship_listing: { id: "listing_id" },
  // spacemolt_social tool
  captains_log_list: { index: "index" },  // same name, explicit for clarity
  captains_log_add: { content: "entry" },
  forum_get_thread: { target: "thread_id" },
  forum_reply: { target: "thread_id" },
  forum_upvote: { target: "post_id" },
  chat: { target: "target_id" },
  // spacemolt_market tool — uses its own param names (item_id, quantity, price_each, order_id)
  cancel_order: { order_id: "order_id" },  // same name
  modify_order: { order_id: "order_id" },  // same name
  // spacemolt trade actions
  trade_accept: { id: "trade_id" },
  trade_decline: { id: "trade_id" },
  trade_cancel: { id: "trade_id" },
  // spacemolt_facility actions
  faction_list: {},
  faction_build: {},
  personal_build: {},
  types: { category: "category" },
  upgrades: {},
  // spacemolt_storage tool
  deposit: { item_id: "item_id" },
  withdraw: { item_id: "item_id" },
  // spacemolt_battle tool
  engage: { id: "target_id" },
  reload: { id: "weapon_instance_id", text: "ammo_item_id" },
  stance: { id: "stance" },
  target: { id: "target_id" },
  // spacemolt_salvage tool
  loot: { id: "wreck_id" },
  salvage: { id: "wreck_id" },
  scrap: { id: "wreck_id" },
  tow: { id: "wreck_id" },
  release: { id: "wreck_id" },
  quote: { id: "wreck_id" },
  insure: { id: "ship_id" },
  // spacemolt_catalog — uses `type` not `action`, no remapping needed
};

/**
 * Fetch v2 consolidated tools from the game server's MCP v2 endpoint.
 * Same MCP protocol flow as v1: initialize → initialized → tools/list.
 * The v2 endpoint URL is derived from the base MCP URL with `/v2?preset=X`.
 */
export async function fetchGameCommandsV2(
  mcpUrl: string,
  preset: string,
): Promise<{ commands: GameCommand[]; serverTools: ServerTool[] }> {
  const v2Url = `${mcpUrl}/v2?preset=${preset}`;
  try {
    const serverTools = await fetchMcpToolsFromUrl(v2Url, `fetchGameCommandsV2(${preset})`);
    return { commands: toolsToCommands(serverTools), serverTools };
  } catch (err) {
    log.warn(`fetchGameCommandsV2 failed: ${err instanceof Error ? err.message : String(err)}`);
    return { commands: [], serverTools: [] };
  }
}

/**
 * Resolve v2 consolidated game tools for a given preset.
 * Fetches from game server, filters denied actions, returns tool info
 * including full schemas for Zod conversion.
 */
export async function resolveGameToolsV2(
  mcpUrl: string,
  preset: string,
): Promise<{
  tools: string[];
  descriptions: Map<string, string>;
  toolSchemas: Map<string, ServerTool>;
}> {
  const descriptions = new Map<string, string>();
  const toolSchemas = new Map<string, ServerTool>();

  // Try cached schema first
  const cached = readSchemaCache();
  let commands: GameCommand[];
  let serverTools: ServerTool[];

  const cachedV2 = cached?.v2?.[preset];
  if (cachedV2 && isCacheEntryValid(cachedV2)) {
    const ageMs = Date.now() - cachedV2.fetchedAt;
    const ageMinutes = Math.round(ageMs / 60000);
    log.info(`Using cached v2 schema for preset=${preset} (${cachedV2.serverTools.length} tools, fetched ${ageMinutes} min ago, TTL: 24h)`);
    commands = cachedV2.commands;
    serverTools = cachedV2.serverTools;
  } else {
    if (cachedV2) {
      const ageMs = Date.now() - cachedV2.fetchedAt;
      const ageHours = Math.round(ageMs / 3600000);
      log.info(`v2 cache stale for preset=${preset} (${ageHours} hours old, TTL: 24h), refreshing from server`);
    }
    const fetched = await fetchGameCommandsV2(mcpUrl, preset);
    commands = fetched.commands;
    serverTools = fetched.serverTools;

    // Write to cache if fetch succeeded
    if (commands.length > 0) {
      const c = cached ?? { v1: null, v2: {}, cachedAt: 0 };
      c.v2[preset] = { commands, serverTools, fetchedAt: Date.now(), ttl: SCHEMA_TTL_MS };
      c.cachedAt = Date.now();
      writeSchemaCache(c);
      log.info(`Cached v2 schema for preset=${preset} to disk (24h TTL)`);
    }
  }

  if (commands.length === 0) {
    log.info(`Could not fetch v2 commands for preset=${preset}`);
    return { tools: [], descriptions, toolSchemas };
  }

  // For v2, we don't filter the top-level tool names — they're consolidated.
  // Action-level filtering (DENIED_ACTIONS_V2) happens at runtime in the handler.
  const tools = commands.map((cmd) => cmd.name);
  for (const cmd of commands) {
    if (cmd.description) descriptions.set(cmd.name, cmd.description);
  }
  for (const tool of serverTools) {
    toolSchemas.set(tool.name, tool);
  }

  log.info(`Loaded ${tools.length} v2 tools (preset=${preset}): ${tools.join(", ")}`);

  return { tools, descriptions, toolSchemas };
}

/**
 * Convert a game server tool's JSON schema → Zod schema for v2 MCP registration.
 * Handles string, number/integer, boolean, array, enum types.
 * Skips session_id (proxy-internal). Unknown types fall back to z.string().
 */
export function serverSchemaToZod(serverTool: ServerTool): z.ZodType {
  const props = serverTool.inputSchema?.properties;
  if (!props || Object.keys(props).length === 0) {
    return z.object({}).passthrough().optional();
  }

  const shape: Record<string, z.ZodType> = {};
  const required = new Set(serverTool.inputSchema?.required ?? []);

  for (const [paramName, paramDef] of Object.entries(props)) {
    // Skip session_id — proxy strips it, agents shouldn't pass it
    if (paramName === "session_id") continue;

    const def = paramDef as { type?: string; description?: string; enum?: string[] };
    let field: z.ZodType;

    if (def.enum && Array.isArray(def.enum) && def.enum.length > 0) {
      // Enum type — use z.enum for string enums
      field = z.enum(def.enum as [string, ...string[]]);
    } else {
      switch (def.type) {
        case "integer":
        case "number":
          field = z.number();
          break;
        case "boolean":
          field = z.boolean();
          break;
        case "array":
          field = z.array(z.unknown());
          break;
        default:
          field = z.string();
      }
    }

    if (def.description) {
      field = field.describe(def.description);
    }

    if (!required.has(paramName)) {
      field = field.optional();
    }

    shape[paramName] = field;
  }

  return z.object(shape).passthrough();
}

// Exported for testing
export { DENIED_TOOLS, type ServerTool };
