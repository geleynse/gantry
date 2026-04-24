import { describe, it, expect, beforeAll, afterAll, mock } from "bun:test";
import express from "express";
import request from "supertest";
import { createMcpServer } from "./server.js";
import { invalidateSchemaCache } from "./schema.js";
import { createDatabase, closeDb } from "../services/database.js";
import type { GantryConfig } from "../config.js";

const testConfig: GantryConfig = {
  agents: [{ name: "test-agent" }],
  gameUrl: "https://game.spacemolt.com/mcp",
  gameApiUrl: "https://game.spacemolt.com/api/v1",
  gameMcpUrl: "https://game.spacemolt.com/mcp",
  agentDeniedTools: {},
  callLimits: {},
  turnSleepMs: 90,
  staggerDelay: 20,
};

let app: ReturnType<typeof express>;

// MCP requests need both Accept types for Streamable HTTP transport
const MCP_HEADERS = {
  "Content-Type": "application/json",
  "Accept": "application/json, text/event-stream",
};

/**
 * Send an MCP request via supertest and return parsed JSON + headers.
 * The MCP Streamable HTTP transport returns text/plain content-type,
 * so we parse resp.text manually instead of relying on supertest's
 * auto-parsed resp.body (which stays {} for non-JSON content types).
 */
async function mcpRequest(body: unknown, sessionId?: string) {
  const req = request(app)
    .post("/mcp")
    .set(MCP_HEADERS);
  if (sessionId) req.set("mcp-session-id", sessionId);
  const resp = await req.send(body as string | object | undefined);
  // Parse the response text manually since content-type is text/plain
  const parsed = resp.text ? JSON.parse(resp.text) : {};
  return { status: resp.status, headers: resp.headers, body: parsed };
}

/** Initialize an MCP session and return the session ID */
async function initSession(): Promise<string> {
  const { status, headers } = await mcpRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  });
  expect(status).toBe(200);
  return headers["mcp-session-id"];
}

describe("Gantry Integration", () => {
  beforeAll(async () => {
    createDatabase(":memory:");
    invalidateSchemaCache();

    const originalFetch = global.fetch;
    const gameTools = [
      { name: "mine", description: "Mine ore", inputSchema: { type: "object", properties: {} } },
      { name: "travel", description: "Travel", inputSchema: { type: "object", properties: { target_poi: { type: "string" } } } },
      { name: "jump", description: "Jump", inputSchema: { type: "object", properties: { target_system: { type: "string" } } } },
      { name: "dock", description: "Dock", inputSchema: { type: "object", properties: {} } },
      { name: "undock", description: "Undock", inputSchema: { type: "object", properties: {} } },
      { name: "get_cargo", description: "Get cargo", inputSchema: { type: "object", properties: {} } },
      { name: "sell", description: "Sell", inputSchema: { type: "object", properties: { item: { type: "string" } } } },
      { name: "buy", description: "Buy", inputSchema: { type: "object", properties: { item: { type: "string" } } } },
      { name: "login", description: "Login", inputSchema: { type: "object", properties: { username: { type: "string" }, password: { type: "string" } } } },
      { name: "logout", description: "Logout", inputSchema: { type: "object", properties: {} } },
      { name: "get_status", description: "Status", inputSchema: { type: "object", properties: {} } },
    ];

    /** Build a minimal Response-like object that satisfies both .json() and .text() callers. */
    function fakeResponse(body: unknown, init?: { ok?: boolean; status?: number; headers?: Record<string, string> }) {
      const jsonStr = JSON.stringify(body);
      const ok = init?.ok ?? true;
      const status = init?.status ?? (ok ? 200 : 500);
      return {
        ok,
        status,
        headers: new Headers(init?.headers ?? {}),
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(jsonStr),
      };
    }

    global.fetch = mock(async (url: string | URL | Request, opts?: any) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("game.spacemolt.com")) {
        if (!opts?.body) {
          return fakeResponse({}, { ok: false, status: 404 });
        }
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(opts.body);
        } catch {
          return fakeResponse({}, { ok: false, status: 400 });
        }
        if (body.method === "initialize") {
          return fakeResponse(
            { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26" } },
            { headers: { "mcp-session-id": "test-session" } },
          );
        }
        if (body.method === "notifications/initialized") {
          return fakeResponse({});
        }
        if (body.method === "tools/list") {
          return fakeResponse(
            { jsonrpc: "2.0", id: body.id, result: { tools: gameTools } },
          );
        }
        return fakeResponse({}, { ok: false, status: 404 });
      }
      return originalFetch(url, opts);
    }) as any;

    const { router } = await createMcpServer(testConfig);
    global.fetch = originalFetch;

    app = express();
    app.use(express.json());
    app.use("/", router);
  });

  afterAll(() => {
    invalidateSchemaCache();
    closeDb();
  });

  // --- Health endpoint tests (supertest auto-parses JSON for these) ---

  it("responds to health check", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.tools).toBeGreaterThan(0);
  });

  it("health check includes version field", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(typeof res.body.version).toBe("string");
    expect((res.body.version as string).length).toBeGreaterThan(0);
  });

  it("health check includes uptime and start time fields", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(typeof res.body.uptime_seconds).toBe("number");
    expect(res.body.uptime_seconds as number).toBeGreaterThanOrEqual(0);
    expect(typeof res.body.started_at).toBe("string");
    const parsed = new Date(res.body.started_at as string);
    expect(isNaN(parsed.getTime())).toBe(false);
  });

  it("rejects GET on /mcp", async () => {
    const res = await request(app).get("/mcp");
    expect(res.status).toBe(405);
  });

  // --- MCP session tests (use mcpRequest helper which parses text/plain bodies) ---

  it("initializes MCP session", async () => {
    const { status, headers, body: data } = await mcpRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    });
    expect(status).toBe(200);
    const result = data.result as Record<string, unknown>;
    expect(result).toBeDefined();
    const serverInfo = result.serverInfo as Record<string, unknown>;
    expect(serverInfo.name).toBe("gantry");

    const sessionId = headers["mcp-session-id"];
    expect(sessionId).toBeTruthy();
  });

  it("lists tools after initialization", async () => {
    const sessionId = await initSession();

    const { status, body: data } = await mcpRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }, sessionId);
    expect(status).toBe(200);
    const result = data.result as { tools: Array<{ name: string }> };
    const toolNames = result.tools.map((t) => t.name);

    // Compound tools
    expect(toolNames).toContain("batch_mine");
    expect(toolNames).toContain("travel_to");

    // Passthrough tools
    expect(toolNames).toContain("mine");
    expect(toolNames).toContain("get_cargo");
    expect(toolNames).toContain("travel");
    expect(toolNames).toContain("dock");

    // Cached status tools
    expect(toolNames).toContain("get_credits");
    expect(toolNames).toContain("get_fuel");
    expect(toolNames).toContain("get_location");

    // Event tools
    expect(toolNames).toContain("get_events");

    // Utility tools
    expect(toolNames).toContain("get_session_info");
  });

  it("calls get_session_info without login", async () => {
    const sessionId = await initSession();

    const { status, body: data } = await mcpRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "get_session_info",
        arguments: {},
      },
    }, sessionId);
    expect(status).toBe(200);
    const result = data.result as { content: Array<{ type: string; text: string }> };
    const info = JSON.parse(result.content[0].text);
    expect(info.agent).toBe("not logged in");
  });

  it("get_events returns error for unauthenticated session", async () => {
    const sessionId = await initSession();
    const { status, body: data } = await mcpRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "get_events", arguments: {} },
    }, sessionId);
    expect(status).toBe(200);
    const result = data.result as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("not logged in");
  });
});
