/**
 * Smoke tests for the Gantry proxy — exercises the full MCP pipeline end-to-end.
 *
 * Uses mockMode (MockGameClient) so no real WebSocket connections are needed.
 * Each test: initialize MCP session -> login -> exercise tool -> verify -> cleanup.
 *
 * @see integration.test.ts for lighter integration tests (schema, health, session init)
 * @see mock-ws-game-server.ts for the standalone mock WS server (used by game-client tests)
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Server } from "node:http";
import { request as httpRequest } from "node:http";
import express from "express";
import { createMcpServer } from "../server.js";
import { invalidateSchemaCache } from "../schema.js";
import { createDatabase, closeDb } from "../../services/database.js";
import { canBindLocalhost } from "../../test/http-test-server.js";
import type { GantryConfig } from "../../config.js";

// ---------------------------------------------------------------------------
// Test config — mockMode enabled for deterministic in-process testing
// ---------------------------------------------------------------------------

const TEST_AGENT = "smoke-agent";

const testConfig: GantryConfig = {
  agents: [{ name: TEST_AGENT }],
  gameUrl: "https://game.spacemolt.com/mcp",
  gameApiUrl: "https://game.spacemolt.com/api/v1",
  agentDeniedTools: {
    "*": {
      self_destruct: "Self destruct is disabled in smoke tests.",
    },
    [TEST_AGENT]: {
      jettison: "Jettison is disabled for this agent.",
    },
  },
  callLimits: {},
  turnSleepMs: 90,
  staggerDelay: 20,
  mockMode: {
    enabled: true,
    tickIntervalMs: 0, // instant ticks for fast tests
    initialState: {
      credits: 5000,
      fuel: 80,
      location: "nexus_core",
      dockedAt: "nexus_station",
      cargo: [{ item_id: "iron_ore", quantity: 10 }],
    },
  },
};

// Game tools returned by the mocked schema fetch
const GAME_TOOLS = [
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
  { name: "get_missions", description: "Get missions", inputSchema: { type: "object", properties: {} } },
  { name: "self_destruct", description: "Self destruct", inputSchema: { type: "object", properties: {} } },
  { name: "jettison", description: "Jettison cargo", inputSchema: { type: "object", properties: {} } },
  { name: "refuel", description: "Refuel", inputSchema: { type: "object", properties: {} } },
  { name: "get_system", description: "Get system info", inputSchema: { type: "object", properties: {} } },
  { name: "view_storage", description: "View storage", inputSchema: { type: "object", properties: {} } },
];

// ---------------------------------------------------------------------------
// MCP request helpers (same pattern as integration.test.ts)
// ---------------------------------------------------------------------------

const MCP_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

let server: Server;
let baseUrl: string;
let dispose: (() => Promise<void>) | undefined;

/**
 * Make an HTTP request using node:http — completely bypasses global.fetch
 * to avoid contamination from bun:test mock() in other test files.
 */
function httpPost(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ ok: boolean; status: number; headers: Headers; json: () => Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = httpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          const status = res.statusCode ?? 500;
          const resHeaders = new Headers();
          for (const [key, val] of Object.entries(res.headers)) {
            if (val) resHeaders.set(key, Array.isArray(val) ? val[0] : val);
          }
          resolve({
            ok: status >= 200 && status < 300,
            status,
            headers: resHeaders,
            json: () => Promise.resolve(JSON.parse(text)),
          });
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function httpGet(
  url: string,
): Promise<{ ok: boolean; status: number }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = httpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: "GET",
      },
      (res) => {
        // Drain response body
        res.on("data", () => {});
        res.on("end", () => {
          const status = res.statusCode ?? 500;
          resolve({ ok: status >= 200 && status < 300, status });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function mcpRequest(
  body: unknown,
  sessionId?: string,
  endpoint = "/mcp",
) {
  const headers: Record<string, string> = { ...MCP_HEADERS };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  return httpPost(`${baseUrl}${endpoint}`, headers, JSON.stringify(body));
}

async function initSession(endpoint = "/mcp"): Promise<string> {
  const resp = await mcpRequest(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "smoke-test", version: "1.0.0" },
      },
    },
    undefined,
    endpoint,
  );
  expect(resp.ok).toBe(true);
  return resp.headers.get("mcp-session-id")!;
}

/**
 * Call a tool and parse the JSON response from the text content.
 * Returns the parsed result object, or the raw JSON-RPC error if the
 * tool is not registered (e.g. MCP-level "method not found").
 */
async function callTool(
  sessionId: string,
  toolName: string,
  args: Record<string, unknown> = {},
  id = 10,
  endpoint = "/mcp",
) {
  const resp = await mcpRequest(
    {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    },
    sessionId,
    endpoint,
  );
  expect(resp.ok).toBe(true);
  const data = (await resp.json()) as Record<string, unknown>;

  // MCP-level error (tool not registered, invalid params, etc.)
  if (data.error) {
    return { _mcp_error: true, error: (data.error as Record<string, unknown>).message ?? data.error };
  }

  const result = data.result as {
    content: Array<{ type: string; text: string }>;
  };
  return JSON.parse(result.content[0].text);
}

async function loginAgent(
  sessionId: string,
  endpoint = "/mcp",
): Promise<Record<string, unknown>> {
  return callTool(
    sessionId,
    "login",
    { username: TEST_AGENT, password: "test-pass" },
    2,
    endpoint,
  );
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Gantry Smoke Tests", () => {
  beforeAll(async () => {
    const canBind = await canBindLocalhost();
    if (!canBind) {
      console.warn("Cannot bind localhost — skipping smoke tests");
      return;
    }

    // Fresh database for this test file — avoid conflicts with other test files
    createDatabase(":memory:");
    invalidateSchemaCache();

    // Temporarily override global.fetch for createMcpServer() schema resolution.
    // Test helpers use node:http directly, so this mock is only active during setup.
    const originalFetch = global.fetch;
    global.fetch = (async (url: string | URL | Request, opts?: any) => {
      const urlStr =
        typeof url === "string"
          ? url
          : url instanceof URL
            ? url.toString()
            : url.url;
      if (urlStr.includes("game.spacemolt.com")) {
        if (opts?.body) {
          const body = JSON.parse(opts.body);
          if (body.method === "initialize") {
            return {
              ok: true,
              headers: new Headers({ "mcp-session-id": "test-session" }),
              json: () =>
                Promise.resolve({
                  result: { protocolVersion: "2025-03-26" },
                }),
            };
          }
          if (body.method === "notifications/initialized") {
            return { ok: true, json: () => Promise.resolve({}) };
          }
          if (body.method === "tools/list") {
            const toolsBody = JSON.stringify({ result: { tools: GAME_TOOLS } });
            return {
              ok: true,
              text: () => Promise.resolve(toolsBody),
              json: () => Promise.resolve(JSON.parse(toolsBody)),
            };
          }
        }
        // Health endpoint, market, map, etc. — return empty/ok
        return {
          ok: false,
          status: 503,
          text: () => Promise.resolve("mocked"),
          json: () => Promise.resolve({}),
        };
      }
      return originalFetch(url, opts);
    }) as typeof fetch;

    const result = await createMcpServer(testConfig);
    dispose = result.dispose;
    global.fetch = originalFetch;

    const app = express();
    app.use(express.json());
    app.use("/", result.router);

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

  afterAll(async () => {
    await dispose?.();
    server?.close();
    invalidateSchemaCache();
    closeDb();
  });

  // -------------------------------------------------------------------------
  // (a) Login round-trip
  // -------------------------------------------------------------------------

  it("login round-trip: initializes session and returns game state", async () => {
    if (!baseUrl) throw new Error("beforeAll did not set baseUrl — server may have failed to start");
    const sessionId = await initSession();
    expect(sessionId).toBeTruthy();

    const loginResult = await loginAgent(sessionId);

    // Login via MockGameClient should return status: ok with game state
    expect(loginResult.status).toBe("ok");
    expect(loginResult.credits).toBeDefined();
    expect(loginResult.location).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // (b) Tool call passthrough — mine
  // -------------------------------------------------------------------------

  it("tool call passthrough: mine returns game server data", async () => {
    const sessionId = await initSession();
    await loginAgent(sessionId);

    const result = await callTool(sessionId, "mine", {}, 3);

    // For state-changing tools, the passthrough handler wraps the result as
    // { status: "completed", result: <game server response> }
    expect(result.status).toBe("completed");
    const inner = result.result as Record<string, unknown>;
    expect(inner).toBeDefined();
    expect(inner.item_id).toBe("iron_ore");
  });

  // -------------------------------------------------------------------------
  // (c) Tool call passthrough — get_status via cached query
  // -------------------------------------------------------------------------

  it("cached query: get_credits returns credits from status cache", async () => {
    const sessionId = await initSession();
    await loginAgent(sessionId);

    const result = await callTool(sessionId, "get_credits", {}, 4);

    // Cached query extracts credits from the status cache primed during login
    expect(result.credits).toBeDefined();
    expect(typeof result.credits).toBe("number");
  });

  // -------------------------------------------------------------------------
  // (d) Guardrail enforcement — globally denied tool
  // -------------------------------------------------------------------------

  it("guardrail: blocks globally denied tool (self_destruct)", async () => {
    const sessionId = await initSession();
    await loginAgent(sessionId);

    const result = await callTool(sessionId, "self_destruct", {}, 5);

    // Pipeline should block this — either via denied-tool guardrail ("not available")
    // or via transit guard ("BLOCKED") depending on status cache state
    expect(result.error).toBeDefined();
    expect(
      result.error.includes("not available") || result.error.includes("BLOCKED"),
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // (e) Guardrail enforcement — agent-specific denied tool
  // -------------------------------------------------------------------------

  it("guardrail: blocks agent-specific denied tool (jettison)", async () => {
    const sessionId = await initSession();
    await loginAgent(sessionId);

    const result = await callTool(sessionId, "jettison", {}, 6);

    expect(result.error).toBeDefined();
    expect(result.error).toContain("not available");
  });

  // -------------------------------------------------------------------------
  // (f) Duplicate detection — same tool+args called twice
  // -------------------------------------------------------------------------

  it("duplicate detection: blocks identical consecutive calls", async () => {
    const sessionId = await initSession();
    await loginAgent(sessionId);

    // First call should succeed
    const first = await callTool(sessionId, "get_missions", {}, 7);
    expect(first.error).toBeUndefined();

    // Second identical call should be blocked as duplicate
    const second = await callTool(sessionId, "get_missions", {}, 8);
    expect(second.error).toBeDefined();
    expect(second.error).toContain("Duplicate");
  });

  // -------------------------------------------------------------------------
  // (g) Unauthenticated tool call — should fail gracefully
  // -------------------------------------------------------------------------

  it("unauthenticated: tool call without login returns error", async () => {
    const sessionId = await initSession();

    // Call mine without logging in first
    const result = await callTool(sessionId, "mine", {}, 9);

    // Passthrough handler should detect no session and return error
    expect(result.error).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // (h) Compound tool — batch_mine
  // -------------------------------------------------------------------------

  it("compound tool: batch_mine executes multiple mines", async () => {
    const sessionId = await initSession();
    await loginAgent(sessionId);

    const result = await callTool(
      sessionId,
      "batch_mine",
      { count: 3 },
      11,
    );

    // batch_mine aggregates mine results (MockGameClient returns flat status
    // without player nesting, so the docked prerequisite check is skipped)
    expect(result.error).toBeUndefined();
    expect(result.mines_completed).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // (i) Session info — works without login
  // -------------------------------------------------------------------------

  it("session info: returns agent status without login", async () => {
    const sessionId = await initSession();

    const result = await callTool(sessionId, "get_session_info", {}, 12);

    expect(result.agent).toBe("not logged in");
  });

  // -------------------------------------------------------------------------
  // (j) Session info — returns agent name after login
  // -------------------------------------------------------------------------

  it("session info: returns agent name after login", async () => {
    const sessionId = await initSession();
    await loginAgent(sessionId);

    const result = await callTool(sessionId, "get_session_info", {}, 13);

    expect(result.agent).toBe(TEST_AGENT);
  });

  // -------------------------------------------------------------------------
  // (k) Health endpoint
  // -------------------------------------------------------------------------

  it("health endpoint is reachable", async () => {
    // The health endpoint calls breakerRegistry.getAggregateStatus() which
    // requires breaker.getStatus() — MockGameClient's stub breaker lacks this.
    // We verify the endpoint is mounted and reachable; full health output
    // is tested in integration.test.ts with real CircuitBreaker instances.
    const resp = await httpGet(`${baseUrl}/health`);
    // Should be reachable (200 or 500 from mock breaker incompatibility)
    expect(resp.status).toBeLessThan(502);
  });
});
