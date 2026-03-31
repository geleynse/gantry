/**
 * Cached status queries — read from the WebSocket state cache.
 * No game server interaction. Instant responses.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { summarizeToolResult } from "./summarizers.js";
import { logToolCall } from "./tool-call-logger.js";
import { textResult, type McpTextResult } from "./passthrough-handler.js";
import { TransitStuckDetector } from "./transit-stuck-detector.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("cached-queries");

export interface CachedQueryDeps {
  mcpServer: McpServer;
  registeredTools: string[];
  statusCache: Map<string, { data: Record<string, unknown>; fetchedAt: number }>;
  getAgentForSession: (sessionId?: string) => string | undefined;
  withInjections: (agentName: string, response: McpTextResult) => Promise<McpTextResult>;
  /** Transit stuck detector — injects warnings when agent appears stranded in hyperspace. */
  transitStuckDetector?: TransitStuckDetector;
}

/** Pure extraction functions for each cached query tool. Shared by v1 and v2 handlers. */
export const STATUS_SLICE_EXTRACTORS: Record<string, (data: Record<string, unknown>) => unknown> = {
  get_status: (d) => {
    // state_update shape: { tick, player, ship, modules, nearby, in_combat }
    const player = (d.player ?? d) as Record<string, unknown>;
    const ship = (d.ship ?? player.ship ?? {}) as Record<string, unknown>;
    const currentPoi = player.current_poi as string | undefined;
    const statusResult: Record<string, unknown> = {
      username: player.username,
      credits: player.credits,
      current_system: player.current_system,
      current_poi: currentPoi,
      docked_at_base: player.docked_at_base,
      ship: {
        name: ship.name, class_id: ship.class_id,
        hull: ship.hull, max_hull: ship.max_hull,
        fuel: ship.fuel, max_fuel: ship.max_fuel,
        cargo_used: ship.cargo_used, cargo_capacity: ship.cargo_capacity,
        modules: ship.modules ?? d.modules,
      },
      in_combat: d.in_combat,
    };

    // Add transit context when location is empty
    if (!currentPoi || (typeof currentPoi === "string" && currentPoi.trim() === "")) {
      statusResult.in_transit = true;
      statusResult._note = "You are in hyperspace/transit. Do productive work while waiting — do NOT repeatedly check location.";
      const transitDest = player.transit_destination as string | undefined;
      if (transitDest) statusResult.destination = transitDest;
    }

    return summarizeToolResult("get_status", statusResult);
  },
  get_credits: (d) => {
    const player = (d.player ?? d) as Record<string, unknown>;
    return { credits: player.credits };
  },
  get_location: (d) => {
    const player = (d.player ?? d) as Record<string, unknown>;
    const system = player.current_system as string | undefined;
    const poi = player.current_poi as string | undefined;
    const result: Record<string, unknown> = { system, poi, docked_at_base: player.docked_at_base };

    // When POI is empty, the agent is in transit. Add helpful context instead of bare empty string.
    if (!poi || (typeof poi === "string" && poi.trim() === "")) {
      result.in_transit = true;
      result._note = "You are in hyperspace/transit. Do NOT repeatedly check location. Do productive work (check cargo, read docs, plan sells) while waiting. The proxy notifies you when you arrive.";
      const transitDest = player.transit_destination as string | undefined;
      if (transitDest) result.destination = transitDest;
      const ticksRemaining = player.ticks_remaining as number | undefined;
      if (typeof ticksRemaining === "number") result.eta_ticks = ticksRemaining;
    }
    return result;
  },
  get_cargo_summary: (d) => {
    const ship = (d.ship ?? d) as Record<string, unknown>;
    return { cargo_used: ship.cargo_used, cargo_capacity: ship.cargo_capacity, cargo: ship.cargo };
  },
  get_fuel: (d) => {
    const ship = (d.ship ?? d) as Record<string, unknown>;
    return { fuel: ship.fuel, max_fuel: ship.max_fuel };
  },
  get_health: (d) => {
    const ship = (d.ship ?? d) as Record<string, unknown>;
    return { hull: ship.hull, max_hull: ship.max_hull };
  },
};

/** MCP tool description strings for each cached query tool. */
export const STATUS_DESCRIPTIONS: Record<string, string> = {
  get_status: "Get full player status from cache. Instant, no game action. Prefer specific queries (get_credits, get_fuel, etc.) to save context.",
  get_credits: "Get current credit balance. Instant, no game action — use this instead of get_status.",
  get_location: "Get current system/POI/docked state. Instant, no game action — use this instead of get_status. Max 8 calls per session.",
  get_cargo_summary: "Get cargo used/capacity/items. Instant, no game action — use this instead of get_cargo.",
  get_fuel: "Get fuel/max_fuel. Instant, no game action — use this instead of get_status.",
  get_health: "Get hull/max_hull. Instant, no game action — use this instead of get_status.",
};

export function registerCachedQueries(deps: CachedQueryDeps): void {
  const { mcpServer, registeredTools, statusCache, getAgentForSession, withInjections } = deps;
  const stuckDetector = deps.transitStuckDetector;

  for (const [name, extract] of Object.entries(STATUS_SLICE_EXTRACTORS)) {
    const description = STATUS_DESCRIPTIONS[name]!;
    mcpServer.registerTool(name, { description }, async (extra) => {
      const agentName = getAgentForSession(extra.sessionId);
      if (!agentName) return textResult({ error: "not logged in" });

      const cached = statusCache.get(agentName);
      if (!cached) return textResult({ error: "no status data yet — login first" });
      const extracted = extract(cached.data);
      const staleness_seconds = Math.round((Date.now() - cached.fetchedAt) / 1000);
      const tick = cached.data.tick;
      let withRecency = typeof extracted === "object" && extracted !== null
        ? { ...extracted as Record<string, unknown>, _cache: { tick, staleness_seconds } }
        : extracted;

      // Transit stuck detection for get_location and get_status
      if (stuckDetector && (name === "get_location" || name === "get_status")) {
        try {
          const { warning } = stuckDetector.record(agentName, name, extracted);
          if (warning && typeof withRecency === "object" && withRecency !== null) {
            withRecency = { ...withRecency as Record<string, unknown>, _transit_warning: warning };
          }
        } catch {
          // non-fatal
        }
      }

      logToolCall(agentName, name, {}, withRecency, 0);
      log.debug("cached query", { agent: agentName, tool: name, staleness_seconds });
      return await withInjections(agentName, textResult(withRecency));
    });
    registeredTools.push(name);
  }
}
