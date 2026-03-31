/**
 * API sync test: validates our proxied command list against the live game server.
 *
 * STALE commands (we proxy something the server no longer has) → hard fail.
 * MISSING commands (server has something we don't proxy) → warning only.
 *
 * Skipped gracefully on:
 *   - Network errors (game server unreachable)
 *   - HTTP 429 (rate limited)
 *   - SKIP_API_SYNC=1 environment variable
 */

import { describe, it, expect } from "bun:test";

// ---- What we proxy -------------------------------------------------------

// V1: tools from STATIC_GAME_TOOLS that agents actually call through to the game.
// Sourced from server.ts STATIC_GAME_TOOLS, minus tools removed from the game
// or moved to INTENTIONALLY_SKIPPED below.
const V1_PROXIED_TOOLS = new Set([
  "captains_log_list", "captains_log_add",
  "get_cargo", "get_system",
  "mine", "travel", "jump", "dock", "undock", "refuel", "repair",
  "sell", "buy", "deposit_items", "withdraw_items",
  "create_sell_order", "create_buy_order", "cancel_order", "modify_order", "view_orders",
  "craft",
  "get_missions", "accept_mission", "complete_mission", "get_active_missions",
  "decline_mission", "abandon_mission",
  "view_market", "view_storage", "estimate_purchase",
  "scan", "survey_system", "search_systems", "get_nearby", "get_map", "get_poi", "find_route",
  "attack", "battle", "get_battle_status", "get_wrecks", "loot_wreck", "salvage_wreck",
  "sell_wreck", "scrap_wreck", "tow_wreck", "release_tow",
  "cloak",
  "sell_ship", "list_ships", "switch_ship", "get_ship",
  "commission_ship", "commission_quote", "claim_commission",
  "commission_status", "cancel_commission", "supply_commission", "browse_ships",
  "buy_listed_ship", "list_ship_for_sale", "cancel_ship_listing",
  "install_mod", "uninstall_mod",
  "analyze_market", "get_base", "use_item", "send_gift", "claim",
  "get_insurance_quote", "buy_insurance", "claim_insurance", "reload", "set_home_base",
  "chat", "get_chat_history",
  "forum_list", "forum_get_thread", "forum_create_thread", "forum_reply", "forum_upvote",
  "trade_offer", "trade_accept", "trade_decline", "trade_cancel", "get_trades",
  "get_skills", "help", "catalog", "get_guide",
  // V2 pass-through targets (resolved at dispatch time from V2_ACTION_TO_V1_NAME)
  "faction_list",
]);

// ---- Intentional skip list -----------------------------------------------
//
// Endpoints the game server has (or had) but we deliberately don't proxy.
// Add entries here (with a comment) instead of letting the test flag them
// as MISSING every run.
const INTENTIONALLY_SKIPPED = new Set([
  // Auth/meta — handled by proxy internally
  "register", "login", "logout", "get_commands", "get_version", "get_notifications",
  "get_status",   // intercepted by cached-queries, never forwarded raw

  // Cosmetic — agents don't need these
  "set_colors", "set_anonymous", "set_status",

  // Drones — not implemented, agents hallucinate them
  "deploy_drone", "recall_drone", "order_drone",

  // Game's built-in notes — we use our own proxy note tools
  "create_note", "read_note", "write_note", "get_notes",

  // V2 consolidated tools — game exposes but agents use spacemolt_* wrappers instead
  "v2_get_missions", "v2_get_cargo", "v2_get_ship", "v2_get_state",
  "v2_get_player", "v2_get_queue", "v2_get_skills", "get_state",

  // Destructive forum actions
  "forum_delete_thread", "forum_delete_reply",

  // Credits wallet stubs — always return errors
  "deposit_credits", "withdraw_credits",

  // Factions — too complex for current fleet (adds 36+ tools to system prompt)
  "create_faction", "join_faction", "leave_faction",
  "faction_accept_peace", "faction_cancel_mission", "faction_create_buy_order",
  "faction_create_role", "faction_create_sell_order", "faction_declare_war",
  "faction_decline_invite", "faction_delete_role", "faction_delete_room",
  "faction_deposit_credits", "faction_deposit_items", "faction_edit",
  "faction_edit_role", "faction_get_invites", "faction_gift", "faction_info",
  "faction_intel_status", "faction_invite", "faction_kick",
  "faction_list_missions", "faction_post_mission", "faction_promote",
  "faction_propose_peace", "faction_query_trade_intel", "faction_rooms",
  "faction_set_ally", "faction_set_enemy", "faction_submit_intel",
  "faction_submit_trade_intel", "faction_trade_intel_status", "faction_visit_room",
  "faction_withdraw_credits", "faction_withdraw_items", "faction_write_room",
  // New faction intel tool — not proxied yet
  "faction_query_intel",

  // Huge response (~188KB) — use catalog instead
  "get_recipes",

  // Self-destruct / jettison — moved to agentDeniedTools (not DENIED_TOOLS),
  // so the server still exposes them but we don't include them for all agents
  "self_destruct",
  "jettison",

  // Removed from game server (were in our STATIC_GAME_TOOLS; now gone)
  "buy_ship",          // replaced by browse_ships + buy_listed_ship
  "shipyard_showroom", // replaced by browse_ships
  "faction_build",     // removed
  "faction_upgrade",   // removed
  "personal_build",    // removed
  "types",             // removed (was facility sub-tool)
  "upgrades",          // removed (was facility sub-tool)

  // New server tools not yet evaluated for proxying
  "get_action_log",           // new — action history log
  "view_completed_mission",   // new — view a specific completed mission
  "facility",                 // new — consolidated facility tool
  "distress_signal",          // new — distress beacon
  "completed_missions",       // new — list of completed missions
  "view_faction_storage",     // new — faction storage viewer
  "fleet",                    // new — fleet management tool
  "name_ship",                // new — rename a ship
  "repair_module",            // new — repair individual modules
  "captains_log_get",         // new — read specific captains log entry
]);

// ---- MCP fetch (same 3-step handshake as schema.ts) ----------------------

const GAME_MCP_URL = "https://game.spacemolt.com/mcp";

interface ServerTool {
  name: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, unknown> };
}

async function fetchServerTools(): Promise<ServerTool[] | null> {
  try {
    const initResp = await fetch(GAME_MCP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        id: 1,
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "gantry-schema-drift-test", version: "1.0.0" },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (initResp.status === 429) return null; // rate limited — skip
    if (!initResp.ok) return null;

    const sessionId = initResp.headers.get("mcp-session-id");
    if (!sessionId) return null;

    const sessionHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "mcp-session-id": sessionId,
    };

    await fetch(GAME_MCP_URL, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      signal: AbortSignal.timeout(5_000),
    });

    const toolsResp = await fetch(GAME_MCP_URL, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 2 }),
      signal: AbortSignal.timeout(10_000),
    });

    if (toolsResp.status === 429) return null;
    if (!toolsResp.ok) return null;

    const data = JSON.parse(await toolsResp.text()) as {
      result?: { tools?: ServerTool[] };
    };
    return data.result?.tools ?? null;
  } catch {
    // Network error, timeout, DNS failure — game server unreachable
    return null;
  }
}

// ---- Tests ---------------------------------------------------------------

const skipSync = process.env.SKIP_API_SYNC === "1";
const maybeDescribe = skipSync ? describe.skip : describe;

maybeDescribe("API sync — live game server schema", () => {
  it("no STALE proxied commands (hard fail if server dropped something we rely on)", async () => {
    const serverTools = await fetchServerTools();

    if (serverTools === null) {
      // Game server unreachable or rate-limited — skip gracefully
      console.log("[schema-drift] Game server unreachable or rate-limited — skipping API sync");
      return;
    }

    const serverToolNames = new Set(serverTools.map((t) => t.name));

    // STALE: we proxy it, server no longer has it, not on the skip list
    const stale: string[] = [];
    for (const tool of V1_PROXIED_TOOLS) {
      if (!serverToolNames.has(tool) && !INTENTIONALLY_SKIPPED.has(tool)) {
        stale.push(tool);
      }
    }

    if (stale.length > 0) {
      console.error(
        `[schema-drift] STALE: ${stale.length} proxied tool(s) no longer exist on game server:\n` +
        stale.map((t) => `  - ${t}`).join("\n") +
        "\n  Fix: remove from V1_PROXIED_TOOLS or add to INTENTIONALLY_SKIPPED with a comment.",
      );
    }

    expect(stale).toEqual([]);
  });

  it("report MISSING commands (warning — server has tools we don't proxy)", async () => {
    const serverTools = await fetchServerTools();

    if (serverTools === null) {
      console.log("[schema-drift] Game server unreachable or rate-limited — skipping API sync");
      return;
    }

    const serverToolNames = serverTools.map((t) => t.name);

    // MISSING: server has it, we don't proxy it, not intentionally skipped
    const missing: string[] = [];
    for (const name of serverToolNames) {
      if (!V1_PROXIED_TOOLS.has(name) && !INTENTIONALLY_SKIPPED.has(name)) {
        missing.push(name);
      }
    }

    if (missing.length > 0) {
      console.warn(
        `[schema-drift] MISSING: ${missing.length} server tool(s) not proxied (not a failure — just FYI):\n` +
        missing.map((t) => `  - ${t}`).join("\n") +
        "\n  Review: add to V1_PROXIED_TOOLS if agents should use them, or to INTENTIONALLY_SKIPPED.",
      );
    }

    // Not a hard failure — just informational. Test always passes.
    expect(true).toBe(true);
  });

  it("server tool count is within expected range (sanity check)", async () => {
    const serverTools = await fetchServerTools();

    if (serverTools === null) {
      console.log("[schema-drift] Game server unreachable or rate-limited — skipping API sync");
      return;
    }

    const count = serverTools.length;
    console.log(`[schema-drift] Game server exposes ${count} tools`);

    // Sanity bounds — if the count drops below 30 something is very wrong,
    // if it jumps above 400 the game added a whole new category we should review.
    expect(count).toBeGreaterThan(30);
    expect(count).toBeLessThan(400);
  });
});

// Always-on unit tests (no network required) --------------------------------

describe("schema-drift — static consistency checks", () => {
  it("V1_PROXIED_TOOLS and INTENTIONALLY_SKIPPED are disjoint", () => {
    const overlap: string[] = [];
    for (const tool of V1_PROXIED_TOOLS) {
      if (INTENTIONALLY_SKIPPED.has(tool)) overlap.push(tool);
    }
    if (overlap.length > 0) {
      console.error(
        `[schema-drift] Tools in both lists (bug):\n` +
        overlap.map((t) => `  - ${t}`).join("\n"),
      );
    }
    expect(overlap).toEqual([]);
  });

  it("V1_PROXIED_TOOLS is non-empty", () => {
    expect(V1_PROXIED_TOOLS.size).toBeGreaterThan(40);
  });

  it("INTENTIONALLY_SKIPPED is non-empty", () => {
    expect(INTENTIONALLY_SKIPPED.size).toBeGreaterThan(10);
  });
});
