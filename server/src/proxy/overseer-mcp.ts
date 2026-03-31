/**
 * overseer-mcp.ts — MCP endpoint factory for the overseer agent.
 *
 * Creates an McpServer with fleet management tools that the overseer
 * (a 6th Claude Code agent) connects to via its own MCP config.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FleetSnapshot } from "../services/coordinator-state.js";
import type { createActionExecutor } from "../services/overseer-actions.js";
import type { OverseerAgent } from "../services/overseer-agent.js";
import { queryAll } from "../services/database.js";
import { buildUserPrompt } from "../services/overseer-prompt.js";
import { searchCatalog } from "../services/game-catalog.js";
import { ResourceKnowledge } from "../services/resource-knowledge.js";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

interface StatusCacheEntry {
  data: Record<string, unknown>;
  fetchedAt: number;
}

export interface OverseerMcpDeps {
  stateGatherer: () => FleetSnapshot;
  actionExecutor: ReturnType<typeof createActionExecutor>;
  overseerAgent: OverseerAgent;
  statusCache: Map<string, StatusCacheEntry>;
  battleCache: Map<string, import("../shared/types.js").BattleState | null>;
}

// ---------------------------------------------------------------------------
// MCP Server factory
// ---------------------------------------------------------------------------

export function createOverseerMcpServer(deps: OverseerMcpDeps): McpServer {
  const server = new McpServer({ name: "gantry-overseer", version: "1.0.0" });

  // --- State reading tools ---

  server.registerTool(
    "get_fleet_status",
    {
      description:
        "Get current fleet status: all agents, market summary, active orders, recent events, fleet totals. Call this at the start of each turn.",
      inputSchema: z.object({}),
    },
    async () => {
      const snapshot = deps.stateGatherer();
      const decisions = deps.overseerAgent.getDecisionHistory(3);
      const text = buildUserPrompt(snapshot, decisions);
      return { content: [{ type: "text" as const, text }] };
    },
  );

  server.registerTool(
    "get_decision_history",
    {
      description: "Get recent overseer decisions with their outcomes.",
      inputSchema: z.object({
        limit: z.number().optional().describe("Number of decisions (default 10)"),
      }),
    },
    async (params) => {
      const limit = params.limit ?? 10;
      const decisions = deps.overseerAgent.getDecisionHistory(limit);
      return { content: [{ type: "text" as const, text: JSON.stringify(decisions, null, 2) }] };
    },
  );

  // --- Detailed agent data (full cache) ---

  server.registerTool(
    "get_agent_details",
    {
      description:
        "Get detailed data for one or all agents: ship stats, modules, cargo items, skills, fuel, hull, combat state. Use this when you need specifics beyond the fleet status table (e.g., to decide which routine to assign based on ship class, skill levels, or equipped modules).",
      inputSchema: z.object({
        agent: z.string().optional().describe("Agent name (omit for all agents)"),
      }),
    },
    async (params) => {
      const result: Record<string, unknown> = {};

      const agents = params.agent
        ? [params.agent]
        : Array.from(deps.statusCache.keys());

      for (const name of agents) {
        const cached = deps.statusCache.get(name);
        if (!cached) {
          result[name] = { error: "no cached data" };
          continue;
        }

        const d = cached.data;
        const player = (d.player ?? d) as Record<string, unknown>;
        const ship = (d.ship ?? player.ship ?? {}) as Record<string, unknown>;
        const battle = deps.battleCache.get(name);

        result[name] = {
          // Player state
          username: player.username,
          credits: player.credits,
          current_system: player.current_system,
          current_poi: player.current_poi,
          docked_at_base: player.docked_at_base,
          skills: player.skills ?? d.skills ?? null,
          // Ship
          ship: {
            name: ship.name,
            class_id: ship.class_id,
            hull: ship.hull,
            max_hull: ship.max_hull,
            fuel: ship.fuel,
            max_fuel: ship.max_fuel,
            cargo_used: ship.cargo_used,
            cargo_capacity: ship.cargo_capacity,
            cargo: ship.cargo ?? null,
            modules: ship.modules ?? d.modules ?? null,
          },
          // Combat
          in_combat: d.in_combat ?? false,
          battle: battle ? {
            battle_id: battle.battle_id,
            status: battle.status,
            target: battle.target,
          } : null,
          // Nearby (if available)
          nearby: d.nearby ?? null,
          // Cache freshness
          _cache_age_ms: Date.now() - cached.fetchedAt,
        };
      }

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  // --- Comms reading tools ---

  server.registerTool(
    "get_agent_comms",
    {
      description:
        "Get recent chat messages, diary entries, and reports from agents. Use to monitor agent communications, detect contamination, or understand what agents are doing.",
      inputSchema: z.object({
        agent: z.string().optional().describe("Filter to a single agent (omit for all)"),
        type: z.enum(["chat", "diary", "report", "all"]).optional().describe("Message type (default: all)"),
        limit: z.number().optional().describe("Max results (default 20)"),
      }),
    },
    async (params) => {
      const limit = Math.min(params.limit ?? 20, 100);
      const results: Record<string, unknown>[] = [];

      // Chat messages from proxy_tool_calls (ws:chat_message events)
      if (!params.type || params.type === "all" || params.type === "chat") {
        const agentFilter = params.agent ? `AND agent = ?` : "";
        const agentParams = params.agent ? [params.agent] : [];
        const chats = queryAll<{ agent: string; result_summary: string; created_at: string }>(
          `SELECT agent, result_summary, created_at FROM proxy_tool_calls
           WHERE tool_name = 'ws:chat_message' ${agentFilter}
           ORDER BY created_at DESC LIMIT ?`,
          ...agentParams, limit,
        );
        for (const c of chats) {
          let parsed: Record<string, unknown> = {};
          try { parsed = JSON.parse(c.result_summary); } catch { /* ignore */ }
          results.push({
            type: "chat",
            agent: c.agent,
            sender: parsed.sender ?? "unknown",
            channel: parsed.channel ?? "unknown",
            content: parsed.content ?? c.result_summary?.slice(0, 200),
            timestamp: c.created_at,
          });
        }
      }

      // Diary entries
      if (!params.type || params.type === "all" || params.type === "diary") {
        const agentFilter = params.agent ? `AND agent = ?` : "";
        const agentParams = params.agent ? [params.agent] : [];
        const diaries = queryAll<{ agent: string; entry: string; created_at: string }>(
          `SELECT agent, entry, created_at FROM agent_diary
           WHERE 1=1 ${agentFilter}
           ORDER BY created_at DESC LIMIT ?`,
          ...agentParams, limit,
        );
        for (const d of diaries) {
          results.push({
            type: "diary",
            agent: d.agent,
            content: d.entry.slice(0, 300),
            timestamp: d.created_at,
          });
        }
      }

      // Reports (write_report results)
      if (!params.type || params.type === "all" || params.type === "report") {
        const agentFilter = params.agent ? `AND agent = ?` : "";
        const agentParams = params.agent ? [params.agent] : [];
        const reports = queryAll<{ agent: string; args_summary: string | null; result_summary: string | null; created_at: string }>(
          `SELECT agent, args_summary, result_summary, created_at FROM proxy_tool_calls
           WHERE tool_name = 'write_report' ${agentFilter}
           ORDER BY created_at DESC LIMIT ?`,
          ...agentParams, limit,
        );
        for (const r of reports) {
          results.push({
            type: "report",
            agent: r.agent,
            content: (r.args_summary ?? r.result_summary ?? "").slice(0, 300),
            timestamp: r.created_at,
          });
        }
      }

      // Sort by timestamp descending
      results.sort((a, b) => String(b.timestamp ?? "").localeCompare(String(a.timestamp ?? "")));

      return { content: [{ type: "text" as const, text: JSON.stringify(results.slice(0, limit), null, 2) }] };
    },
  );

  server.registerTool(
    "get_forum_posts",
    {
      description:
        "Get recent forum threads and replies. Forums are the public communication channel in the game — agents and other players post here.",
      inputSchema: z.object({
        limit: z.number().optional().describe("Max results (default 20)"),
      }),
    },
    async (params) => {
      const limit = Math.min(params.limit ?? 20, 50);
      // Forum posts are captured as proxy_tool_calls with tool_name = 'forum_list', 'forum_get_thread', etc.
      const posts = queryAll<{ agent: string; tool_name: string; args_summary: string | null; result_summary: string | null; created_at: string }>(
        `SELECT agent, tool_name, args_summary, result_summary, created_at FROM proxy_tool_calls
         WHERE tool_name LIKE 'forum%'
         ORDER BY created_at DESC LIMIT ?`,
        limit,
      );

      const results = posts.map(p => ({
        agent: p.agent,
        action: p.tool_name,
        args: p.args_summary?.slice(0, 200) ?? null,
        result: p.result_summary?.slice(0, 500) ?? null,
        timestamp: p.created_at,
      }));

      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    },
  );

  // --- Action tools ---

  server.registerTool(
    "issue_order",
    {
      description:
        "Send a fleet order to an agent. Orders are injected into the agent's next tool response.",
      inputSchema: z.object({
        agent: z.string().describe("Agent name (e.g. my-agent)"),
        message: z.string().describe("Order text"),
        priority: z
          .enum(["normal", "urgent"])
          .optional()
          .describe("Priority level (default: normal)"),
      }),
    },
    async (params) => {
      const results = await deps.actionExecutor.execute([
        { type: "issue_order", params: { agent: params.agent, message: params.message, priority: params.priority ?? "normal" } },
      ]);
      return { content: [{ type: "text" as const, text: JSON.stringify(results[0]) }] };
    },
  );

  server.registerTool(
    "trigger_routine",
    {
      description:
        "Start a named routine for an agent. Available: sell_cycle, mining_loop, refuel_repair, full_trade_run, navigate_home, explore_system, explore_and_mine, navigate_and_mine, supply_run, craft_and_sell, salvage_loop, patrol_and_attack, mission_run, mission_check, manage_storage, upgrade_ship, fleet_refuel, fleet_jump. Params are routine-specific objects (NOT strings). Example: navigate_and_mine requires {system: 'sol', belt: 'asteroid_belt_1', returnStation: 'sol_station'} (cycles optional, default 3).",
      inputSchema: z.object({
        agent: z.string().describe("Agent name"),
        routine: z.string().describe("Routine name"),
        params: z.record(z.unknown()).optional().describe("Optional routine params as a JSON object. navigate_and_mine: {system, belt, returnStation, cycles?}"),
      }),
    },
    async (params) => {
      const results = await deps.actionExecutor.execute([
        { type: "trigger_routine", params: { agent: params.agent, routine: params.routine, params: params.params } },
      ]);
      return { content: [{ type: "text" as const, text: JSON.stringify(results[0]) }] };
    },
  );

  server.registerTool(
    "start_agent",
    {
      description: "Start a stopped agent.",
      inputSchema: z.object({
        agent: z.string().describe("Agent name"),
      }),
    },
    async (params) => {
      const results = await deps.actionExecutor.execute([
        { type: "start_agent", params: { agent: params.agent } },
      ]);
      return { content: [{ type: "text" as const, text: JSON.stringify(results[0]) }] };
    },
  );

  server.registerTool(
    "stop_agent",
    {
      description: "Stop a running agent gracefully.",
      inputSchema: z.object({
        agent: z.string().describe("Agent name"),
        reason: z.string().describe("Reason for stopping"),
      }),
    },
    async (params) => {
      const results = await deps.actionExecutor.execute([
        { type: "stop_agent", params: { agent: params.agent, reason: params.reason } },
      ]);
      return { content: [{ type: "text" as const, text: JSON.stringify(results[0]) }] };
    },
  );

  server.registerTool(
    "reassign_role",
    {
      description: "Change an agent's operating focus by sending an urgent fleet order.",
      inputSchema: z.object({
        agent: z.string().describe("Agent name"),
        role: z.string().describe("New role: miner, trader, explorer, combat"),
        zone: z.string().optional().describe("Optional operating zone"),
      }),
    },
    async (params) => {
      const results = await deps.actionExecutor.execute([
        { type: "reassign_role", params: { agent: params.agent, role: params.role, zone: params.zone } },
      ]);
      return { content: [{ type: "text" as const, text: JSON.stringify(results[0]) }] };
    },
  );

  // --- Catalog query ---

  server.registerTool(
    "query_catalog",
    {
      description:
        "Search the game item/recipe/ship catalog. Use this to look up item stats, crafting requirements, or ship specs when planning assignments.",
      inputSchema: z.object({
        type: z.enum(["item", "recipe", "ship", "all"]).describe("Type of catalog entry to search"),
        search: z.string().optional().describe("Name or partial name to search for"),
        id: z.string().optional().describe("Exact item/recipe/ship ID to look up"),
      }),
    },
    (params: { type: "item" | "recipe" | "ship" | "all"; search?: string; id?: string }) => {
      const results = searchCatalog(params.type, params.search, params.id, 50);
      const total = results.items.length + results.recipes.length + results.ships.length;
      return { content: [{ type: "text" as const, text: JSON.stringify({ ...results, total }, null, 2) }] };
    },
  );

  // --- Resource knowledge query ---

  server.registerTool(
    "query_known_resources",
    {
      description:
        "Query fleet-wide knowledge of resource locations. Search by resource name or system to find where items have been spotted and at what prices.",
      inputSchema: z.object({
        resource: z.string().optional().describe("Resource/item ID to search for (e.g. 'iron_ore')"),
        system: z.string().optional().describe("System to list all known resources in"),
      }),
    },
    ({ resource, system }: { resource?: string; system?: string }) => {
      const rk = new ResourceKnowledge();

      if (resource) {
        const locations = rk.query(resource);
        const bestBuy = rk.getBestPrice(resource);
        const bestSell = rk.getBestSellPrice(resource);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              resource,
              locations: locations.slice(0, 20),
              best_buy_price: bestBuy,
              best_sell_price: bestSell,
              total_locations: locations.length,
            }, null, 2),
          }],
        };
      }

      if (system) {
        const resources = rk.querySystem(system);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ system, resources: resources.slice(0, 50), total_resources: resources.length }, null, 2),
          }],
        };
      }

      const allResources = rk.listResources();
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ known_resources: allResources.slice(0, 100), total: allResources.length }, null, 2),
        }],
      };
    },
  );

  // --- Decision logging ---

  server.registerTool(
    "log_decision",
    {
      description: "Log your reasoning and actions for this turn. Call this at the end of each turn.",
      inputSchema: z.object({
        reasoning: z.string().describe("Your reasoning for the actions taken"),
        actions_taken: z.array(z.string()).optional().describe("List of actions you took"),
      }),
    },
    async (params) => {
      const snapshot = deps.stateGatherer();
      const decision = deps.overseerAgent.logDecision({
        triggered_by: "agent_turn",
        snapshot_json: JSON.stringify(snapshot),
        actions_json: JSON.stringify(params.actions_taken ?? []),
        results_json: JSON.stringify({ reasoning: params.reasoning }),
        model: "claude",
      });
      return { content: [{ type: "text" as const, text: `Decision #${decision.id} logged.` }] };
    },
  );

  return server;
}
