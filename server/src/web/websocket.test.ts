/**
 * Tests for the WebSocket server (attachWebSocketServer).
 *
 * Uses a real HTTP server + WebSocket client to test the full protocol.
 * Each test gets a fresh server on a random port to avoid collisions.
 *
 * Opt-in only: Bun's test runner has been flaky with live ws loopback in this
 * environment even when the same handshake succeeds in a standalone `bun -e`
 * script. Run with `RUN_WS_INTEGRATION=1 bun test src/web/websocket.test.ts`.
 */

import { describe, it, expect } from "bun:test";
import http from "node:http";
import { WebSocket } from "ws";
import { attachWebSocketServer, getWebSocketClientCount, type WsChannel } from "./websocket.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestServer(): {
  server: http.Server;
  broadcast: (channel: WsChannel, event: string, data: unknown) => void;
  close: () => Promise<void>;
  port: () => number;
} {
  const server = http.createServer();
  const { broadcast, close: closeWss } = attachWebSocketServer(server);

  const closePromise = () =>
    new Promise<void>((resolve) => {
      closeWss();
      server.close(() => resolve());
    });

  return {
    server,
    broadcast,
    close: closePromise,
    port: () => (server.address() as { port: number }).port,
  };
}

function connectClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function nextMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    ws.once("message", (data) => {
      resolve(JSON.parse(data.toString()));
    });
  });
}

function startServer(srv: http.Server): Promise<void> {
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
}

async function withTestServer(
  fn: (ctx: ReturnType<typeof createTestServer>) => Promise<void> | void,
): Promise<void> {
  const ctx = createTestServer();
  await startServer(ctx.server);
  try {
    await fn(ctx);
  } finally {
    await ctx.close();
  }
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

const describeWebSocket =
  process.env.RUN_WS_INTEGRATION === "1" ? describe : describe.skip;

describeWebSocket("WebSocket server", () => {

  it("accepts a WebSocket connection on /ws", async () => {
    await withTestServer(async (ctx) => {
      const ws = await connectClient(ctx.port());
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });
  });

  // ---------------------------------------------------------------------------
  // Subscribe / unsubscribe
  // ---------------------------------------------------------------------------

  it("responds with subscribed after valid subscribe message", async () => {
    await withTestServer(async (ctx) => {
      const ws = await connectClient(ctx.port());
      const responsePromise = nextMessage(ws);
      ws.send(JSON.stringify({ type: "subscribe", channel: "fleet-status" }));
      const response = await responsePromise;
      expect(response).toMatchObject({ type: "subscribed", channel: "fleet-status" });
      ws.close();
    });
  });

  it("responds with unsubscribed after unsubscribe", async () => {
    await withTestServer(async (ctx) => {
      const ws = await connectClient(ctx.port());
      ws.send(JSON.stringify({ type: "subscribe", channel: "fleet-status" }));
      await nextMessage(ws);

      const responsePromise = nextMessage(ws);
      ws.send(JSON.stringify({ type: "unsubscribe", channel: "fleet-status" }));
      const response = await responsePromise;
      expect(response).toMatchObject({ type: "unsubscribed", channel: "fleet-status" });
      ws.close();
    });
  });

  it("rejects unknown channel with error", async () => {
    await withTestServer(async (ctx) => {
      const ws = await connectClient(ctx.port());
      const responsePromise = nextMessage(ws);
      ws.send(JSON.stringify({ type: "subscribe", channel: "not-a-channel" }));
      const response = await responsePromise as { type: string; message: string };
      expect(response.type).toBe("error");
      expect(response.message).toMatch(/unknown channel/i);
      ws.close();
    });
  });

  it("rejects invalid JSON with error", async () => {
    await withTestServer(async (ctx) => {
      const ws = await connectClient(ctx.port());
      const responsePromise = nextMessage(ws);
      ws.send("not-json");
      const response = await responsePromise as { type: string };
      expect(response.type).toBe("error");
      ws.close();
    });
  });

  it("responds to ping with pong", async () => {
    await withTestServer(async (ctx) => {
      const ws = await connectClient(ctx.port());
      const responsePromise = nextMessage(ws);
      ws.send(JSON.stringify({ type: "ping" }));
      const response = await responsePromise;
      expect(response).toMatchObject({ type: "pong" });
      ws.close();
    });
  });

  // ---------------------------------------------------------------------------
  // Broadcast
  // ---------------------------------------------------------------------------

  it("delivers broadcast to subscribed client", async () => {
    await withTestServer(async (ctx) => {
      const ws = await connectClient(ctx.port());
      ws.send(JSON.stringify({ type: "subscribe", channel: "fleet-status" }));
      await nextMessage(ws);

      const msgPromise = nextMessage(ws);
      ctx.broadcast("fleet-status", "status", { agents: 3 });
      const msg = await msgPromise;
      expect(msg).toMatchObject({
        type: "event",
        channel: "fleet-status",
        event: "status",
        data: { agents: 3 },
      });
      ws.close();
    });
  });

  it("does not deliver broadcast to unsubscribed client", async () => {
    await withTestServer(async (ctx) => {
      const ws = await connectClient(ctx.port());
      ws.send(JSON.stringify({ type: "subscribe", channel: "tool-calls" }));
      await nextMessage(ws);

      let received = false;
      ws.on("message", () => { received = true; });

      ctx.broadcast("fleet-status", "status", { agents: 3 });

      await new Promise((r) => setTimeout(r, 50));
      expect(received).toBe(false);
      ws.close();
    });
  });

  it("delivers broadcast to multiple subscribed clients", async () => {
    await withTestServer(async (ctx) => {
      const ws1 = await connectClient(ctx.port());
      const ws2 = await connectClient(ctx.port());

      ws1.send(JSON.stringify({ type: "subscribe", channel: "agent-events" }));
      ws2.send(JSON.stringify({ type: "subscribe", channel: "agent-events" }));
      await nextMessage(ws1);
      await nextMessage(ws2);

      const p1 = nextMessage(ws1);
      const p2 = nextMessage(ws2);
      ctx.broadcast("agent-events", "update", { agent: "drifter-gale" });

      const [m1, m2] = await Promise.all([p1, p2]);
      expect(m1).toMatchObject({ type: "event", channel: "agent-events" });
      expect(m2).toMatchObject({ type: "event", channel: "agent-events" });
      ws1.close();
      ws2.close();
    });
  });

  it("does not deliver to client after unsubscribe", async () => {
    await withTestServer(async (ctx) => {
      const ws = await connectClient(ctx.port());
      ws.send(JSON.stringify({ type: "subscribe", channel: "fleet-status" }));
      await nextMessage(ws);

      ws.send(JSON.stringify({ type: "unsubscribe", channel: "fleet-status" }));
      await nextMessage(ws);

      let received = false;
      ws.on("message", () => { received = true; });
      ctx.broadcast("fleet-status", "status", {});
      await new Promise((r) => setTimeout(r, 50));
      expect(received).toBe(false);
      ws.close();
    });
  });

  // ---------------------------------------------------------------------------
  // getWebSocketClientCount
  // ---------------------------------------------------------------------------

  it("getWebSocketClientCount returns 0 with no clients", () => {
    expect(getWebSocketClientCount()).toBe(0);
  });

  it("getWebSocketClientCount reflects connected clients", async () => {
    await withTestServer(async (ctx) => {
      const ws1 = await connectClient(ctx.port());
      const ws2 = await connectClient(ctx.port());
      await new Promise((r) => setTimeout(r, 30));
      expect(getWebSocketClientCount()).toBeGreaterThanOrEqual(2);
      ws1.close();
      ws2.close();
    });
  });

  // ---------------------------------------------------------------------------
  // Channel validation — all valid channels accepted
  // ---------------------------------------------------------------------------

  it.each(["fleet-status", "agent-events", "tool-calls"] as WsChannel[])(
    "accepts valid channel %s",
    async (channel) => {
      await withTestServer(async (ctx) => {
        const ws = await connectClient(ctx.port());
        const responsePromise = nextMessage(ws);
        ws.send(JSON.stringify({ type: "subscribe", channel }));
        const response = await responsePromise;
        expect(response).toMatchObject({ type: "subscribed", channel });
        ws.close();
      });
    }
  );
});
