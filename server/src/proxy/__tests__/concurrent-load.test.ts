/**
 * Concurrent load tests for the Gantry proxy.
 *
 * Exercises simultaneous multi-agent activity to catch shared-state bugs:
 * - Rate-limit cascade (one agent's error blocks others via serverMetrics)
 * - Cross-session guardrail contamination
 * - Duplicate detection isolation (per-session, not global)
 *
 * MANUAL — not part of the standard `bun test` suite due to timing sensitivity.
 * Run with: bun test --grep "Concurrent Load"
 *
 * Covers concurrent load handling.
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
// Test config — 5 agents, mockMode for deterministic in-process testing
// ---------------------------------------------------------------------------

const AGENT_NAMES = [
  "load-agent-1",
  "load-agent-2",
  "load-agent-3",
  "load-agent-4",
  "load-agent-5",
];

// agent-3 has an extra denied tool to test guardrail isolation
const testConfig: GantryConfig = {
  agents: AGENT_NAMES.map((name) => ({ name })),
  gameUrl: "https://game.spacemolt.com/mcp",
  gameApiUrl: "https://game.spacemolt.com/api/v1",
  gameMcpUrl: "https://game.spacemolt.com/mcp",
  agentDeniedTools: {
    "*": {
      self_destruct: "Self destruct disabled in load tests.",
    },
    "load-agent-3": {
      jettison: "Jettison disabled for agent-3.",
    },
  },
  callLimits: {},
  turnSleepMs: 90,
  staggerDelay: 0,
  mockMode: {
    enabled: true,
    tickIntervalMs: 0,
    initialState: {
      credits: 5000,
      fuel: 80,
      location: "nexus_core",
      dockedAt: "nexus_station",
      cargo: [{ item_id: "iron_ore", quantity: 5 }],
    },
  },
};

// Game tools for mock schema
const GAME_TOOLS = [
  { name: "mine", description: "Mine ore", inputSchema: { type: "object", properties: {} } },
  { name: "travel", description: "Travel", inputSchema: { type: "object", properties: { target_poi: { type: "string" } } } },
  { name: "dock", description: "Dock", inputSchema: { type: "object", properties: {} } },
  { name: "undock", description: "Undock", inputSchema: { type: "object", properties: {} } },
  { name: "get_cargo", description: "Get cargo", inputSchema: { type: "object", properties: {} } },
  { name: "sell", description: "Sell", inputSchema: { type: "object", properties: { item: { type: "string" } } } },
  { name: "login", description: "Login", inputSchema: { type: "object", properties: { username: { type: "string" }, password: { type: "string" } } } },
  { name: "logout", description: "Logout", inputSchema: { type: "object", properties: {} } },
  { name: "get_status", description: "Status", inputSchema: { type: "object", properties: {} } },
  { name: "get_missions", description: "Get missions", inputSchema: { type: "object", properties: {} } },
  { name: "self_destruct", description: "Self destruct", inputSchema: { type: "object", properties: {} } },
  { name: "jettison", description: "Jettison cargo", inputSchema: { type: "object", properties: {} } },
  { name: "refuel", description: "Refuel", inputSchema: { type: "object", properties: {} } },
];

// ---------------------------------------------------------------------------
// HTTP helpers (same pattern as smoke.test.ts)
// ---------------------------------------------------------------------------

const MCP_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

let server: Server;
let baseUrl: string;
let dispose: (() => Promise<void>) | undefined;
let canBind: boolean;

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
        clientInfo: { name: "load-test", version: "1.0.0" },
      },
    },
    undefined,
    endpoint,
  );
  expect(resp.ok).toBe(true);
  return resp.headers.get("mcp-session-id")!;
}

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

  if (data.error) {
    return { _mcp_error: true, error: (data.error as Record<string, unknown>).message ?? data.error };
  }

  const result = data.result as {
    content: Array<{ type: string; text: string }>;
  };
  return JSON.parse(result.content[0].text);
}

async function loginAgent(sessionId: string, agentName: string) {
  return callTool(
    sessionId,
    "login",
    { username: agentName, password: "test-pass" },
    2,
  );
}

/** Initialize a session and log in, returning { sessionId } */
async function spawnAgent(agentName: string): Promise<{ sessionId: string; name: string }> {
  const sessionId = await initSession();
  const loginResult = await loginAgent(sessionId, agentName);
  expect(loginResult.status).toBe("ok");
  return { sessionId, name: agentName };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  canBind = await canBindLocalhost();
  if (!canBind) {
    console.warn("Cannot bind localhost — skipping concurrent load tests");
    return;
  }

  createDatabase(":memory:");
  invalidateSchemaCache();

  const originalFetch = global.fetch;
  global.fetch = (async (url: string | URL | Request, opts?: RequestInit) => {
    const urlStr =
      typeof url === "string"
        ? url
        : url instanceof URL
          ? url.toString()
          : (url as Request).url;
    if (urlStr.includes("game.spacemolt.com")) {
      if (opts?.body) {
        const body = JSON.parse(opts.body as string) as { method: string };
        if (body.method === "initialize") {
          return {
            ok: true,
            headers: new Headers({ "mcp-session-id": "test-session" }),
            json: () => Promise.resolve({ result: { protocolVersion: "2025-03-26" } }),
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
      return { ok: false, status: 503, text: () => Promise.resolve("mocked"), json: () => Promise.resolve({}) };
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

// ---------------------------------------------------------------------------
// Concurrent load tests
// ---------------------------------------------------------------------------

describe("Concurrent Load", () => {
  it("5 agents can initialize sessions simultaneously", async () => {
    if (!canBind) return;

    const sessionIds = await Promise.all(
      AGENT_NAMES.map(() => initSession()),
    );

    // All 5 sessions should have distinct IDs
    expect(sessionIds).toHaveLength(5);
    expect(new Set(sessionIds).size).toBe(5);
    for (const id of sessionIds) {
      expect(id).toBeTruthy();
    }
  });

  it("5 agents can log in simultaneously", async () => {
    if (!canBind) return;

    const results = await Promise.all(
      AGENT_NAMES.map(async (name) => {
        const sessionId = await initSession();
        return loginAgent(sessionId, name);
      }),
    );

    for (const result of results) {
      expect(result.status).toBe("ok");
      expect(result.credits).toBeDefined();
      expect(result.location).toBeDefined();
    }
  });

  it("5 agents calling mine simultaneously all get responses", async () => {
    if (!canBind) return;

    const agents = await Promise.all(
      AGENT_NAMES.map((name) => spawnAgent(name)),
    );

    const results = await Promise.all(
      agents.map(({ sessionId }) => callTool(sessionId, "mine", {}, 10)),
    );

    for (const result of results) {
      expect(result.error).toBeUndefined();
      expect(result.status).toBe("completed");
    }
  });

  it("15 concurrent tool calls (5 agents × 3 calls each) all complete", async () => {
    if (!canBind) return;

    const agents = await Promise.all(
      AGENT_NAMES.map((name) => spawnAgent(name)),
    );

    // Each agent calls 3 different tools — batched into one Promise.all
    const allCalls = agents.flatMap(({ sessionId }, i) => [
      callTool(sessionId, "mine", {}, 10 + i * 10),
      callTool(sessionId, "get_cargo", {}, 11 + i * 10),
      callTool(sessionId, "get_missions", {}, 12 + i * 10),
    ]);

    const results = await Promise.all(allCalls);

    expect(results).toHaveLength(15);
    for (const result of results) {
      // All should succeed (no _mcp_error, no server-level error)
      expect(result._mcp_error).toBeUndefined();
    }
  });

  it("agent-specific denied tool blocks only that agent, not others", async () => {
    if (!canBind) return;

    const agents = await Promise.all(
      AGENT_NAMES.map((name) => spawnAgent(name)),
    );

    const agent3 = agents.find((a) => a.name === "load-agent-3")!;
    const others = agents.filter((a) => a.name !== "load-agent-3");

    // agent-3 calling jettison should be blocked
    const [blockedResult, ...otherResults] = await Promise.all([
      callTool(agent3.sessionId, "jettison", {}, 20),
      ...others.map(({ sessionId }, i) =>
        callTool(sessionId, "mine", {}, 21 + i),
      ),
    ]);

    // agent-3 should be blocked
    expect(blockedResult.error).toBeDefined();
    expect(blockedResult.error).toContain("not available");

    // Others should still work
    for (const result of otherResults) {
      expect(result.error).toBeUndefined();
      expect(result.status).toBe("completed");
    }
  });

  it("globally denied tool blocks all agents without cross-contamination", async () => {
    if (!canBind) return;

    const agents = await Promise.all(
      AGENT_NAMES.map((name) => spawnAgent(name)),
    );

    // All 5 agents try self_destruct (globally denied) simultaneously
    const blockedResults = await Promise.all(
      agents.map(({ sessionId }, i) =>
        callTool(sessionId, "self_destruct", {}, 30 + i),
      ),
    );

    // All should be blocked — either by denied-tool guardrail or transit guard
    for (const result of blockedResults) {
      expect(result.error).toBeDefined();
      expect(
        result.error.includes("not available") || result.error.includes("BLOCKED"),
      ).toBe(true);
    }

    // After being blocked, all agents should still function normally
    const followUpResults = await Promise.all(
      agents.map(({ sessionId }, i) =>
        callTool(sessionId, "mine", {}, 40 + i),
      ),
    );

    for (const result of followUpResults) {
      expect(result.error).toBeUndefined();
      expect(result.status).toBe("completed");
    }
  });

  it("duplicate detection is per-session (agent-1 dup doesn't affect agent-2)", async () => {
    if (!canBind) return;

    const [agent1, agent2] = await Promise.all([
      spawnAgent("load-agent-1"),
      spawnAgent("load-agent-2"),
    ]);

    // Both agents call get_missions — agent-1 calls it twice (duplicate)
    const [first1, second1, first2] = await Promise.all([
      callTool(agent1.sessionId, "get_missions", {}, 50),
      // Small delay to let first1 complete first for the duplicate check
      new Promise<Record<string, unknown>>((resolve) =>
        setTimeout(() => resolve(callTool(agent1.sessionId, "get_missions", {}, 51)), 20),
      ),
      callTool(agent2.sessionId, "get_missions", {}, 52),
    ]);

    // agent-1's first call should succeed
    expect(first1.error).toBeUndefined();

    // agent-2's call should always succeed regardless of agent-1's duplicate
    expect(first2.error).toBeUndefined();

    // agent-1's duplicate should be blocked
    expect(second1.error).toBeDefined();
    expect(second1.error).toContain("Duplicate");
  });

  it("session info returns correct agent name for each of 5 concurrent sessions", async () => {
    if (!canBind) return;

    const agents = await Promise.all(
      AGENT_NAMES.map((name) => spawnAgent(name)),
    );

    const sessionInfos = await Promise.all(
      agents.map(({ sessionId }, i) =>
        callTool(sessionId, "get_session_info", {}, 60 + i),
      ),
    );

    for (let i = 0; i < agents.length; i++) {
      expect(sessionInfos[i].agent).toBe(agents[i].name);
    }
  });
});
