/**
 * Context Summary Route
 *
 * GET /api/agents/:name/context-summary
 *
 * Returns a structured state summary for an agent, used by the "compressed" context mode
 * in the fleet CLI runner. Instead of maintaining a long-running Claude session with full
 * conversation history, compressed-mode agents fetch this summary before each turn and
 * inject it into their system prompt as structured JSON.
 *
 * Response shape:
 * {
 *   status:        { ...latest status cache data }
 *   location:      { system, poi, docked }
 *   resources:     { credits, fuel, cargo_summary }
 *   last_actions:  [ last 5 tool calls with results ]
 *   active_orders: [ pending fleet orders for this agent ]
 *   recent_events: [ last 3 events from the event buffer ]
 * }
 */

import { Router } from "express";
import { queryAll } from "../../services/database.js";
import { getPendingOrders } from "../../services/comms-db.js";
import { validateAgentName } from "../config.js";
import { createLogger } from "../../lib/logger.js";
import type { EventBuffer } from "../../proxy/event-buffer.js";

const log = createLogger("context-summary");

// ── Types ──────────────────────────────────────────────────────────────────

export interface ContextSummary {
  status: Record<string, unknown> | null;
  location: {
    system: string | null;
    poi: string | null;
    docked: boolean;
  };
  resources: {
    credits: number | null;
    fuel: number | null;
    cargo_summary: string | null;
  };
  last_actions: Array<{
    tool: string;
    args_summary: string | null;
    result_summary: string | null;
    success: boolean;
    duration_ms: number | null;
    timestamp: string;
  }>;
  active_orders: Array<{
    id: number;
    message: string;
    priority: string;
    created_at: string;
  }>;
  recent_events: Array<{
    type: string;
    payload: unknown;
    receivedAt: number;
  }>;
}

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Create the context-summary router.
 * Requires the statusCache and eventBuffers from shared state so it can read live data.
 */
export function createContextSummaryRouter(
  statusCache: Map<string, { data: Record<string, unknown>; fetchedAt: number }>,
  eventBuffers: Map<string, EventBuffer>,
): Router {
  const router = Router();

  router.get("/:name/context-summary", (req, res) => {
    const name = req.params.name;

    if (!validateAgentName(name)) {
      res.status(404).json({ error: `Unknown agent: ${name}` });
      return;
    }

    try {
      // --- Status cache ---
      const cached = statusCache.get(name);
      const statusData = cached?.data ?? null;

      // --- Location (extracted from status cache) ---
      const player = (statusData?.player ?? {}) as Record<string, unknown>;
      const location = {
        system: (player.current_system as string | undefined) ?? null,
        poi: (player.current_poi as string | undefined) ?? null,
        docked: typeof player.docked === "boolean" ? player.docked : Boolean(player.docked_at ?? player.docked),
      };

      // --- Resources ---
      const ship = (statusData?.ship ?? {}) as Record<string, unknown>;
      const resources = {
        credits: typeof player.credits === "number" ? player.credits : null,
        fuel: typeof ship.fuel === "number" ? ship.fuel : null,
        cargo_summary:
          typeof ship.cargo_used === "number" && typeof ship.cargo_capacity === "number"
            ? `${ship.cargo_used}/${ship.cargo_capacity}`
            : null,
      };

      // --- Last 5 tool calls (from DB) ---
      interface ToolCallRow {
        tool_name: string;
        args_summary: string | null;
        result_summary: string | null;
        success: number;
        duration_ms: number | null;
        timestamp: string;
      }
      const toolCallRows = queryAll<ToolCallRow>(
        `SELECT tool_name, args_summary, result_summary, success, duration_ms, timestamp
         FROM proxy_tool_calls
         WHERE agent = ?
         ORDER BY timestamp DESC
         LIMIT 5`,
        name,
      );

      const last_actions = toolCallRows.map((row) => ({
        tool: row.tool_name,
        args_summary: row.args_summary,
        result_summary: row.result_summary,
        success: row.success === 1,
        duration_ms: row.duration_ms,
        timestamp: row.timestamp,
      }));

      // --- Active fleet orders ---
      const pendingOrders = getPendingOrders(name);
      const active_orders = pendingOrders.map((o) => ({
        id: o.id,
        message: o.message,
        priority: o.priority,
        created_at: o.created_at,
      }));

      // --- Recent events (peek, do not drain) ---
      const eventBuffer = eventBuffers.get(name);
      const recent_events = eventBuffer ? peekRecentEvents(eventBuffer, 3) : [];

      const summary: ContextSummary = {
        status: statusData,
        location,
        resources,
        last_actions,
        active_orders,
        recent_events,
      };

      res.json(summary);
    } catch (err) {
      log.error("Failed to build context summary", { agent: name, error: String(err) });
      res.status(500).json({ error: "Failed to build context summary" });
    }
  });

  return router;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Peek at the most recent N events from an event buffer without draining them.
 * We use the internal drain/re-push pattern to avoid exposing private buffer state.
 * Since EventBuffer doesn't have a read-only peek, we drain up to N events and
 * immediately push them back. This is safe for a read-only summary.
 */
function peekRecentEvents(
  buffer: EventBuffer,
  limit: number,
): Array<{ type: string; payload: unknown; receivedAt: number }> {
  // EventBuffer.drain() removes events — we need peek semantics.
  // Access via a read-only view: drain all, snapshot, re-push.
  // Use the drain() method which returns events in order (oldest first).
  const drained = buffer.drain(undefined, undefined);
  const recent = drained.slice(-limit);

  // Re-push all events back in order so the buffer is unchanged
  for (const event of drained) {
    buffer.push(event);
  }

  return recent.map((e) => ({
    type: e.type,
    payload: e.payload,
    receivedAt: e.receivedAt,
  }));
}
