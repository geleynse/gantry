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

import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import type { Request } from "express";
import { createLogger } from "../lib/logger.js";
import type { AuthAdapter, AuthRole } from "./auth/types.js";

const log = createLogger("websocket");

/**
 * Build a minimal Express-`Request`-shaped shim from a raw HTTP upgrade
 * request so the SAME AuthAdapter used by the HTTP `authMiddleware` can
 * resolve a role for a WebSocket upgrade, instead of the upgrade handler
 * running no auth at all.
 *
 * LIMITATION: `.ip` is read directly from the socket's peer address
 * (`request.socket.remoteAddress`), NOT through Express's `trust proxy`
 * X-Forwarded-For resolution. Behind a reverse proxy with `trust proxy`
 * enabled, ordinary HTTP requests see the real client IP; this shim will
 * instead see the proxy's own address. This only affects adapters that key
 * off `req.ip` (`local-network`, `loopback`, and the local-network leg of
 * `layered`) — header-based adapters (`cloudflare-access`, `token`,
 * `domain`) read `req.headers`/`req.get()`, which this shim reproduces
 * faithfully from the raw request and are unaffected.
 */
function buildAuthRequestShim(request: IncomingMessage): Request {
  const headers = request.headers;
  return {
    headers,
    ip: request.socket?.remoteAddress,
    socket: request.socket,
    get(name: string) {
      const v = headers[name.toLowerCase()];
      return Array.isArray(v) ? v[0] : v;
    },
  } as unknown as Request;
}

/**
 * Resolve a role for a raw WS upgrade request using the given auth adapter.
 * Mirrors `authMiddleware`'s semantics for non-admin/viewer-level data:
 *   - adapter resolves a role → that role (admin or viewer)
 *   - adapter returns null (unauthenticated) → viewer (matches HTTP: viewer
 *     is the public default for read-only, non-admin-prefix data, which is
 *     exactly what these WS channels carry)
 *   - adapter throws → null, meaning "reject" (fail-closed, matching
 *     authMiddleware's 503 fail-closed behavior on adapter errors)
 *   - adapter returns some other truthy-but-invalid role (misbehaving custom
 *     adapter) → null, reject
 * Exported for unit testing without a live socket.
 */
export async function resolveWsRole(
  authAdapter: AuthAdapter,
  request: IncomingMessage,
): Promise<AuthRole | null> {
  try {
    const result = await authAdapter.authenticate(buildAuthRequestShim(request));
    const role = result?.role ?? "viewer";
    if (role !== "admin" && role !== "viewer") {
      log.warn("WS auth adapter returned an unrecognized role — rejecting", { role });
      return null;
    }
    return role;
  } catch (err) {
    log.warn("WS auth adapter threw during upgrade — rejecting (fail-closed)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

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
export function attachWebSocketServer(
  httpServer: HttpServer,
  authAdapter: AuthAdapter,
): {
  broadcast: (channel: WsChannel, event: string, data: unknown) => void;
  close: () => void;
} {
  const wss = new WebSocketServer({ noServer: true });

  const upgradeHandler = (request: IncomingMessage, socket: Socket, head: Buffer) => {
    if (request.url !== "/ws") {
      socket.destroy();
      return;
    }

    resolveWsRole(authAdapter, request)
      .then((role) => {
        if (role === null) {
          log.debug("WS upgrade rejected (auth failed)");
          socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit("connection", ws, request);
        });
      })
      .catch((err) => {
        // Defensive: resolveWsRole already catches adapter errors internally
        // and returns null; this only guards against something unexpected
        // (e.g. buildAuthRequestShim throwing synchronously).
        log.error("WS upgrade auth resolution failed unexpectedly", {
          error: err instanceof Error ? err.message : String(err),
        });
        socket.destroy();
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
        const subscribing = msg.type === "subscribe";
        subscribing ? state.subscriptions.add(ch) : state.subscriptions.delete(ch);
        sendMessage(ws, { type: subscribing ? "subscribed" : "unsubscribed", channel: ch });
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
