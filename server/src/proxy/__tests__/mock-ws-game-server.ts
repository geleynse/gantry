/**
 * Mock WebSocket Game Server for smoke tests.
 *
 * Minimal WS server that speaks the SpaceMolt game protocol:
 *   Client sends: { type: "command_name", payload: { ...args } }
 *   Server sends: { type: "welcome" } on connect, then { type: "ok", payload: {...} }
 *                 or { type: "error", payload: { code, message } } for responses.
 *
 * Canned responses are keyed by command name, with lightweight state tracking
 * for login/logout.
 */

import { WebSocketServer, type WebSocket } from "ws";
import type { Server } from "node:http";
import { createServer } from "node:http";

interface MockServerOptions {
  /** Additional canned responses keyed by command name */
  responses?: Record<string, unknown>;
}

const DEFAULT_RESPONSES: Record<string, (payload?: Record<string, unknown>) => unknown> = {
  login: (payload) => ({
    status: "ok",
    session_id: "mock-ws-session-001",
    username: payload?.username ?? "test-agent",
    agent_name: payload?.username ?? "test-agent",
    credits: 5000,
    fuel: 80,
    location: "nexus_core",
    home_system: "nexus_core",
  }),

  get_status: () => ({
    status: "ok",
    tick: 42,
    player: {
      current_system: "nexus_core",
      current_poi: "nexus_station",
      credits: 5000,
      docked_at_base: "nexus_station",
    },
    ship: {
      hull: 100,
      max_hull: 100,
      shield: 50,
      max_shield: 50,
      fuel: 80,
      fuel_capacity: 100,
      cargo: [],
      cargo_used: 0,
      cargo_capacity: 50,
    },
  }),

  mine: () => ({
    status: "ok",
    ore_extracted: 3,
    item_id: "iron_ore",
    xp_gained: 9,
    cargo_after: { cargo_used: 3, cargo_capacity: 50 },
  }),

  travel: (payload) => ({
    status: "completed",
    location: "nexus_core",
    poi: payload?.target_poi ?? "nexus_belt_alpha",
    docked_at_base: null,
    fuel: 72,
    tick: 43,
  }),

  get_missions: () => ({
    status: "ok",
    missions: [
      { id: "m1", title: "Deliver Iron", type: "delivery", reward: 100 },
    ],
  }),

  logout: () => ({
    status: "ok",
    message: "Session ended.",
  }),

  // Catch-all for storage/view etc.
  storage: () => ({
    status: "ok",
    items: [],
    capacity: 100,
    used: 0,
  }),
};

export class MockWsGameServer {
  private httpServer: Server;
  private wss: WebSocketServer;
  private clients = new Set<WebSocket>();
  private customResponses: Record<string, unknown>;
  private _url: string | null = null;
  private tickCounter = 42;

  constructor(options: MockServerOptions = {}) {
    this.customResponses = options.responses ?? {};
    this.httpServer = createServer();
    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on("connection", (ws) => {
      this.clients.add(ws);

      // Send welcome message immediately (game protocol handshake)
      ws.send(JSON.stringify({ type: "welcome", payload: { version: "mock-0.1.0" } }));

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString()) as {
            type: string;
            payload?: Record<string, unknown>;
          };
          this.handleMessage(ws, msg);
        } catch {
          ws.send(JSON.stringify({
            type: "error",
            payload: { code: "parse_error", message: "Invalid JSON" },
          }));
        }
      });

      ws.on("close", () => {
        this.clients.delete(ws);
      });
    });
  }

  private handleMessage(
    ws: WebSocket,
    msg: { type: string; payload?: Record<string, unknown> },
  ): void {
    const { type: command, payload } = msg;

    // Check for custom response first
    if (command in this.customResponses) {
      const custom = this.customResponses[command];
      const result = typeof custom === "function" ? custom(payload) : custom;
      ws.send(JSON.stringify({ type: "ok", payload: result }));
      return;
    }

    // Check default responses
    const handler = DEFAULT_RESPONSES[command];
    if (handler) {
      const result = handler(payload);
      ws.send(JSON.stringify({ type: "ok", payload: result }));
      return;
    }

    // Unknown command — return generic ok
    ws.send(JSON.stringify({
      type: "ok",
      payload: { status: "ok", message: `Mock response for ${command}` },
    }));
  }

  /** Start the server on an ephemeral port (port 0). Returns the ws:// URL. */
  async start(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.httpServer.listen(0, "127.0.0.1", () => {
        const addr = this.httpServer.address();
        if (addr && typeof addr === "object") {
          this._url = `ws://127.0.0.1:${addr.port}`;
          resolve(this._url);
        } else {
          reject(new Error("Failed to bind mock WS server"));
        }
      });
      this.httpServer.once("error", reject);
    });
  }

  /** Get the server URL (available after start()). */
  get url(): string {
    if (!this._url) throw new Error("Server not started");
    return this._url;
  }

  /** Send a tick event to all connected clients. */
  broadcastTick(): void {
    this.tickCounter++;
    const msg = JSON.stringify({ type: "tick", payload: this.tickCounter });
    for (const ws of this.clients) {
      ws.send(msg);
    }
  }

  /** Close the server and all client connections. */
  async close(): Promise<void> {
    for (const ws of this.clients) {
      ws.close();
    }
    this.clients.clear();

    return new Promise<void>((resolve, reject) => {
      this.wss.close(() => {
        this.httpServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
  }
}
