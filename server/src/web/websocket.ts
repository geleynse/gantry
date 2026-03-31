/**
 * WebSocket server for real-time fleet dashboard updates.
 *
 * Mirrors the SSE event channels over WebSocket for better mobile support.
 * Supported channels: fleet-status, agent-events, tool-calls
 *
 * Protocol (JSON messages):
 *   Client → Server: { type: "subscribe", channel: "fleet-status" | "agent-events" | "tool-calls" }
 *   Client → Server: { type: "unsubscribe", channel: "..." }
 *   Server → Client: { type: "event", channel: "...", event: "...", data: ... }
 *   Server → Client: { type: "error", message: "..." }
 *   Server → Client: { type: "subscribed", channel: "..." }
 */

import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { createLogger } from "../lib/logger.js";

const log = createLogger("websocket");

export type WsChannel = "fleet-status" | "agent-events" | "tool-calls";

const VALID_CHANNELS = new Set<WsChannel>(["fleet-status", "agent-events", "tool-calls"]);

interface ClientMessage {
  type: "subscribe" | "unsubscribe" | "ping";
  channel?: string;
}

interface ServerMessage {
  type: "event" | "error" | "subscribed" | "unsubscribed" | "pong";
  channel?: string;
  event?: string;
  data?: unknown;
  message?: string;
}

/** Per-connection state */
interface ClientState {
  subscriptions: Set<WsChannel>;
}

/** Active WebSocket connections, keyed by the WS instance */
const clients = new Map<WebSocket, ClientState>();

/**
 * Attach a WebSocket server to an existing HTTP server.
 * Returns a broadcast function for pushing events to subscribed clients.
 */
export function attachWebSocketServer(httpServer: HttpServer): {
  broadcast: (channel: WsChannel, event: string, data: unknown) => void;
  close: () => void;
} {
  const wss = new WebSocketServer({ noServer: true });

  const upgradeHandler = (request: import("node:http").IncomingMessage, socket: import("node:net").Socket, head: Buffer) => {
    if (request.url !== "/ws") {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  };

  httpServer.on("upgrade", upgradeHandler);

  wss.on("connection", (ws: WebSocket) => {
    const state: ClientState = { subscriptions: new Set() };
    clients.set(ws, state);

    log.debug("WebSocket client connected", { total: clients.size });

    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        sendMessage(ws, { type: "error", message: "Invalid JSON" });
        return;
      }

      if (msg.type === "ping") {
        sendMessage(ws, { type: "pong" });
        return;
      }

      if (msg.type === "subscribe" || msg.type === "unsubscribe") {
        const ch = msg.channel as WsChannel;
        if (!ch || !VALID_CHANNELS.has(ch)) {
          sendMessage(ws, { type: "error", message: `Unknown channel: ${msg.channel ?? "(none)"}` });
          return;
        }

        if (msg.type === "subscribe") {
          state.subscriptions.add(ch);
          sendMessage(ws, { type: "subscribed", channel: ch });
        } else {
          state.subscriptions.delete(ch);
          sendMessage(ws, { type: "unsubscribed", channel: ch });
        }
        return;
      }

      sendMessage(ws, { type: "error", message: `Unknown message type: ${msg.type}` });
    });

    ws.on("close", () => {
      clients.delete(ws);
      log.debug("WebSocket client disconnected", { total: clients.size });
    });

    ws.on("error", (err) => {
      log.debug("WebSocket client error", { error: err.message });
      clients.delete(ws);
    });
  });

  wss.on("error", (err) => {
    log.error("WebSocket server error", { error: err.message });
  });

  /**
   * Broadcast an event to all clients subscribed to the given channel.
   */
  function broadcast(channel: WsChannel, event: string, data: unknown): void {
    const msg: ServerMessage = { type: "event", channel, event, data };
    const payload = JSON.stringify(msg);

    for (const [ws, state] of clients) {
      if (!state.subscriptions.has(channel)) continue;
      if (ws.readyState !== ws.OPEN) continue;
      ws.send(payload, (err) => {
        if (err) {
          log.debug("WebSocket send error", { channel, error: err.message });
          clients.delete(ws);
        }
      });
    }
  }

  function close() {
    httpServer.off("upgrade", upgradeHandler);
    for (const ws of wss.clients) {
      clients.delete(ws);
      try {
        ws.terminate();
      } catch {
        // Best-effort cleanup during shutdown.
      }
    }
    wss.close();
  }

  log.info("WebSocket server attached", { path: "/ws" });

  return { broadcast, close };
}

/** Send a typed message to a single client, ignoring errors (client may have disconnected). */
function sendMessage(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(msg), () => {});
}

/** Returns the count of currently connected WebSocket clients (for diagnostics). */
export function getWebSocketClientCount(): number {
  return clients.size;
}
