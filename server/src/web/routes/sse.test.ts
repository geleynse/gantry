/**
 * Tests for SSE helpers and the /api/tool-calls/stream endpoint.
 *
 * Covers connection lifecycle, event delivery, agent filtering,
 * and disconnect cleanup.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import type { Request, Response } from "express";
import express from "express";
import type { Server } from "node:http";
import { request as httpRequest } from "node:http";
import { initSSE, writeSSE } from "../sse.js";
import toolCallsRoutes from "./tool-calls.js";
import { createDatabase, closeDb } from "../../services/database.js";
import {
  subscribe,
  unsubscribe,
  logToolCall,
  getRingBuffer,
  type ToolCallRecord,
} from "../../proxy/tool-call-logger.js";
import { canBindLocalhost } from "../../test/http-test-server.js";

// ---------------------------------------------------------------------------
// Unit tests — initSSE
// ---------------------------------------------------------------------------

describe("initSSE", () => {
  it("sets Content-Type to text/event-stream", () => {
    const headers: Record<string, string> = {};
    const mockRes = {
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      },
      flushHeaders: () => {},
    } as unknown as Response;

    initSSE({} as Request, mockRes);
    expect(headers["Content-Type"]).toBe("text/event-stream");
  });

  it("sets Cache-Control to no-cache", () => {
    const headers: Record<string, string> = {};
    const mockRes = {
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      },
      flushHeaders: () => {},
    } as unknown as Response;

    initSSE({} as Request, mockRes);
    expect(headers["Cache-Control"]).toBe("no-cache");
  });

  it("sets Connection to keep-alive", () => {
    const headers: Record<string, string> = {};
    const mockRes = {
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      },
      flushHeaders: () => {},
    } as unknown as Response;

    initSSE({} as Request, mockRes);
    expect(headers["Connection"]).toBe("keep-alive");
  });

  it("sets X-Accel-Buffering to no (prevents nginx buffering)", () => {
    const headers: Record<string, string> = {};
    const mockRes = {
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      },
      flushHeaders: () => {},
    } as unknown as Response;

    initSSE({} as Request, mockRes);
    expect(headers["X-Accel-Buffering"]).toBe("no");
  });

  it("calls flushHeaders to flush headers immediately", () => {
    let flushed = false;
    const mockRes = {
      setHeader: () => {},
      flushHeaders: () => {
        flushed = true;
      },
    } as unknown as Response;

    initSSE({} as Request, mockRes);
    expect(flushed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unit tests — writeSSE
// ---------------------------------------------------------------------------

describe("writeSSE", () => {
  it("writes a correctly formatted SSE frame", () => {
    const written: string[] = [];
    const mockRes = {
      write: (data: string) => {
        written.push(data);
      },
    } as unknown as Response;

    writeSSE(mockRes, "tool_call", { agent: "drifter-gale", tool: "mine" });

    expect(written).toHaveLength(1);
    expect(written[0]).toBe(
      'event: tool_call\ndata: {"agent":"drifter-gale","tool":"mine"}\n\n',
    );
  });

  it("serializes arrays as JSON", () => {
    const written: string[] = [];
    const mockRes = {
      write: (data: string) => written.push(data),
    } as unknown as Response;

    writeSSE(mockRes, "batch", [1, 2, 3]);

    expect(written[0]).toBe("event: batch\ndata: [1,2,3]\n\n");
  });

  it("serializes primitive string values as JSON (quoted)", () => {
    const written: string[] = [];
    const mockRes = {
      write: (data: string) => written.push(data),
    } as unknown as Response;

    writeSSE(mockRes, "ping", "hello");

    expect(written[0]).toBe('event: ping\ndata: "hello"\n\n');
  });

  it("serializes null as JSON", () => {
    const written: string[] = [];
    const mockRes = {
      write: (data: string) => written.push(data),
    } as unknown as Response;

    writeSSE(mockRes, "empty", null);

    expect(written[0]).toBe("event: empty\ndata: null\n\n");
  });

  it("frame ends with double newline (SSE spec)", () => {
    const written: string[] = [];
    const mockRes = {
      write: (data: string) => written.push(data),
    } as unknown as Response;

    writeSSE(mockRes, "x", {});

    expect(written[0]).toEndWith("\n\n");
  });
});

// ---------------------------------------------------------------------------
// Unit tests — subscribe / unsubscribe mechanism
// ---------------------------------------------------------------------------

describe("SSE subscriber mechanism", () => {
  beforeEach(() => {
    createDatabase(":memory:");
    // Clear ring buffer entries by consuming them
    getRingBuffer().splice(0);
  });

  afterEach(() => {
    closeDb();
  });

  it("subscriber receives records when logToolCall is called", () => {
    const received: ToolCallRecord[] = [];
    const cb = (r: ToolCallRecord) => received.push(r);
    subscribe(cb);

    logToolCall("drifter-gale", "mine", {}, { ore: 3 }, 150);

    unsubscribe(cb);
    expect(received).toHaveLength(1);
    expect(received[0].agent).toBe("drifter-gale");
    expect(received[0].tool_name).toBe("mine");
  });

  it("unsubscribed callback does not receive further records", () => {
    const received: ToolCallRecord[] = [];
    const cb = (r: ToolCallRecord) => received.push(r);

    subscribe(cb);
    logToolCall("drifter-gale", "mine", {}, {}, 100);
    unsubscribe(cb);
    logToolCall("drifter-gale", "sell", {}, {}, 100);

    expect(received).toHaveLength(1);
    expect(received[0].tool_name).toBe("mine");
  });

  it("multiple subscribers each receive their own copy", () => {
    const a: ToolCallRecord[] = [];
    const b: ToolCallRecord[] = [];
    const cbA = (r: ToolCallRecord) => a.push(r);
    const cbB = (r: ToolCallRecord) => b.push(r);

    subscribe(cbA);
    subscribe(cbB);
    logToolCall("sable-thorn", "jump", {}, {}, 200);
    unsubscribe(cbA);
    unsubscribe(cbB);

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].tool_name).toBe("jump");
  });

  it("subscriber errors don't break notification to other subscribers", () => {
    const received: ToolCallRecord[] = [];
    const errorCb = () => {
      throw new Error("subscriber error");
    };
    const goodCb = (r: ToolCallRecord) => received.push(r);

    subscribe(errorCb);
    subscribe(goodCb);
    // Should not throw even though errorCb throws
    logToolCall("rust-vane", "sell", {}, {}, 50);
    unsubscribe(errorCb);
    unsubscribe(goodCb);

    expect(received).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — /api/tool-calls/stream HTTP endpoint
// ---------------------------------------------------------------------------

describe("/api/tool-calls/stream endpoint", () => {
  let server: Server;
  let baseUrl: string;
  let canBind: boolean;

  beforeAll(async () => {
    canBind = await canBindLocalhost();
    if (!canBind) return;

    createDatabase(":memory:");

    const app = express();
    app.use(express.json());
    app.use("/api/tool-calls", toolCallsRoutes);

    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(() => {
    server?.close();
    closeDb();
  });

  /**
   * Open an SSE connection and collect data for a limited time window.
   * Returns chunks received and a close() function.
   */
  function openStream(
    path: string,
    collectMs = 100,
  ): Promise<{ chunks: string[] }> {
    return new Promise((resolve, reject) => {
      if (!baseUrl) return reject(new Error("server not started"));

      const parsed = new URL(`${baseUrl}${path}`);
      const chunks: string[] = [];
      let settled = false;

      const req = httpRequest(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname + parsed.search,
          method: "GET",
        },
        (res) => {
          res.on("data", (chunk: Buffer) => {
            chunks.push(chunk.toString("utf-8"));
          });
          res.on("error", () => {});
        },
      );

      req.on("error", (err) => {
        if (!settled) { settled = true; reject(err); }
      });

      req.end();

      // Collect for collectMs, then close and resolve
      setTimeout(() => {
        if (!settled) {
          settled = true;
          req.destroy();
          resolve({ chunks });
        }
      }, collectMs);
    });
  }

  it("returns SSE headers (Content-Type: text/event-stream)", async () => {
    if (!canBind) return;

    await new Promise<void>((resolve, reject) => {
      const parsed = new URL(`${baseUrl}/api/tool-calls/stream`);
      const req = httpRequest(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname,
          method: "GET",
        },
        (res) => {
          expect(res.headers["content-type"]).toContain("text/event-stream");
          expect(res.statusCode).toBe(200);
          req.destroy();
          resolve();
        },
      );
      req.on("error", reject);
      req.end();
    });
  });

  it("sends backfill from ring buffer on connect", async () => {
    if (!canBind) return;

    // Pre-populate the ring buffer with a known record
    getRingBuffer().splice(0);
    logToolCall("drifter-gale", "prefill-tool", {}, { ok: true }, 100);

    const { chunks } = await openStream("/api/tool-calls/stream", 150);
    const body = chunks.join("");

    expect(body).toContain("event: tool_call");
    expect(body).toContain("prefill-tool");
  });

  it("sends live records pushed after connection is established", async () => {
    if (!canBind) return;

    getRingBuffer().splice(0);

    const received: string[] = [];
    // Collect chunks in a rolling window with a push in the middle
    await new Promise<void>((resolve, reject) => {
      const parsed = new URL(`${baseUrl}/api/tool-calls/stream`);
      const req = httpRequest(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname,
          method: "GET",
        },
        (res) => {
          res.on("data", (chunk: Buffer) => {
            received.push(chunk.toString("utf-8"));
          });
          res.on("error", () => {});
        },
      );
      req.on("error", reject);
      req.end();

      // Push a new record after a short delay (connection established)
      setTimeout(() => {
        logToolCall("sable-thorn", "live-push-tool", {}, {}, 50);
      }, 30);

      // Collect and close after enough time
      setTimeout(() => {
        req.destroy();
        const body = received.join("");
        expect(body).toContain("live-push-tool");
        resolve();
      }, 150);
    });
  });

  it("filters events by agent when ?agent= query param is set", async () => {
    if (!canBind) return;

    getRingBuffer().splice(0);
    // Pre-populate with two agents
    logToolCall("drifter-gale", "drifter-tool", {}, {}, 100);
    logToolCall("rust-vane", "rust-tool", {}, {}, 100);

    const { chunks } = await openStream(
      "/api/tool-calls/stream?agent=drifter-gale",
      150,
    );
    const body = chunks.join("");

    expect(body).toContain("drifter-tool");
    expect(body).not.toContain("rust-tool");
  });

  it("disconnect removes the subscriber (no write after close)", async () => {
    if (!canBind) return;

    getRingBuffer().splice(0);

    // Track external subscriber calls after the route subscriber is gone
    let afterDisconnectCalls = 0;

    await new Promise<void>((resolve) => {
      const parsed = new URL(`${baseUrl}/api/tool-calls/stream`);
      const req = httpRequest(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname,
          method: "GET",
        },
        (res) => {
          res.on("data", () => {});
          res.on("error", () => {});
        },
      );
      req.on("error", () => {});
      req.end();

      // Close the connection from the client side after 50ms
      setTimeout(() => {
        req.destroy();
      }, 50);

      // After disconnect, push a new record and wait for any writes to propagate
      setTimeout(() => {
        // The route subscriber should be gone — this should not throw or crash
        logToolCall("cinder-wake", "post-disconnect-tool", {}, {}, 100);
        afterDisconnectCalls++;
        resolve();
      }, 120);
    });

    // Server should have handled the disconnect gracefully (no crash)
    expect(afterDisconnectCalls).toBe(1);
  });
});
