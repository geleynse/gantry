/**
 * Tests for the agent reasoning endpoint and tool-calls type filter.
 *
 * POST /api/agents/:name/reasoning — ingests Claude extended thinking blocks
 * GET /api/tool-calls?type=reasoning — filters to __reasoning records only
 *
 * Uses node:http directly to avoid global.fetch mock interference from
 * component tests (tool-call-feed.test.tsx mocks global.fetch).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import express from "express";
import { request as httpRequest } from "node:http";
import { createDatabase, closeDb } from "../../services/database.js";
import { logAgentReasoning } from "../tool-call-logger.js";
import { agentReasoningRouter } from "../../web/routes/tool-calls.js";
import toolCallsRoutes from "../../web/routes/tool-calls.js";
import { startTestServer, canBindLocalhost } from "../../test/http-test-server.js";
import type { StartedTestServer } from "../../test/http-test-server.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/agents", agentReasoningRouter);
  app.use("/api/tool-calls", toolCallsRoutes);
  return app;
}

function getRows() {
  const { getDb } = require("../../services/database.js");
  const db = getDb();
  return db.prepare(
    "SELECT id, agent, tool_name, assistant_text FROM proxy_tool_calls ORDER BY id ASC"
  ).all() as Array<{
    id: number;
    agent: string;
    tool_name: string;
    assistant_text: string | null;
  }>;
}

/** Make an HTTP request using node:http to avoid global.fetch mock interference. */
function httpPost(baseUrl: string, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const bodyStr = JSON.stringify(body);
    const req = httpRequest({
      hostname: url.hostname,
      port: parseInt(url.port),
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: data });
        }
      });
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

function httpGet(baseUrl: string, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = httpRequest({
      hostname: url.hostname,
      port: parseInt(url.port),
      path: url.pathname + url.search,
      method: "GET",
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: data });
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("POST /api/agents/:name/reasoning", () => {
  let testServer: StartedTestServer;
  let canBind = false;

  beforeAll(async () => {
    createDatabase(":memory:");
    canBind = await canBindLocalhost();
    if (!canBind) return;
    const app = buildApp();
    testServer = await startTestServer(app);
  });

  afterAll(async () => {
    await testServer?.close();
    closeDb();
  });

  it("returns 204 and stores reasoning record", async () => {
    if (!canBind) return;
    const res = await httpPost(testServer.baseUrl, "/api/agents/ember-drift/reasoning", {
      text: "I should check fuel before jumping to nexus.",
    });
    expect(res.status).toBe(204);

    const rows = getRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].tool_name).toBe("__reasoning");
    expect(rows[0].agent).toBe("ember-drift");
    expect(rows[0].assistant_text).toBe("I should check fuel before jumping to nexus.");
  });

  it("returns 400 for missing or empty text", async () => {
    if (!canBind) return;
    const res = await httpPost(testServer.baseUrl, "/api/agents/ember-drift/reasoning", { text: "" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid agent name", async () => {
    if (!canBind) return;
    const res = await httpPost(testServer.baseUrl, "/api/agents/INVALID_NAME/reasoning", {
      text: "Some reasoning.",
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/tool-calls?type=reasoning", () => {
  let testServer: StartedTestServer;
  let canBind = false;

  beforeAll(async () => {
    createDatabase(":memory:");
    canBind = await canBindLocalhost();
    if (!canBind) return;
    const app = buildApp();
    testServer = await startTestServer(app);
  });

  afterAll(async () => {
    await testServer?.close();
    closeDb();
  });

  it("filters to only __reasoning records when type=reasoning", async () => {
    if (!canBind) return;
    const { logToolCall } = require("../tool-call-logger.js");
    logToolCall("null-spark", "mine", {}, { ore: 5 }, 100);
    logAgentReasoning("null-spark", "Deciding whether to mine or sell first.");

    const res = await httpGet(testServer.baseUrl, "/api/tool-calls?agent=null-spark&type=reasoning");
    expect(res.status).toBe(200);
    const body = res.body as { tool_calls: Array<{ tool_name: string }> };
    expect(body.tool_calls).toHaveLength(1);
    expect(body.tool_calls[0].tool_name).toBe("__reasoning");
  });

  it("includes __reasoning records in default (no type filter) response", async () => {
    if (!canBind) return;
    const { logToolCall } = require("../tool-call-logger.js");
    logToolCall("null-spark", "sell", {}, { credits: 100 }, 50);
    logAgentReasoning("null-spark", "Should I mine more or dock for repairs?");

    const res = await httpGet(testServer.baseUrl, "/api/tool-calls?agent=null-spark&limit=10");
    expect(res.status).toBe(200);
    const body = res.body as { tool_calls: Array<{ tool_name: string }> };
    const toolNames = body.tool_calls.map((r) => r.tool_name);
    expect(toolNames).toContain("__reasoning");
    expect(toolNames).toContain("sell");
  });
});
