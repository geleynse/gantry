import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { HttpGameClient } from "./http-game-client.js";

// Mock fetch — track calls and return queued responses
let fetchMock: ReturnType<typeof mock>;
let fetchResponses: Array<{ status: number; body: string; headers?: Record<string, string> }>;
const originalFetch = globalThis.fetch;

function pushMcpResponse(result: unknown, id = 0, headers?: Record<string, string>) {
  fetchResponses.push({
    status: 200,
    body: JSON.stringify({ jsonrpc: "2.0", id, result }),
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function pushMcpToolResult(text: string, isError = false, id = 0) {
  pushMcpResponse({ content: [{ type: "text", text }], isError }, id);
}

function pushMcpError(code: number, message: string, id = 0) {
  fetchResponses.push({
    status: 200,
    body: JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }),
    headers: { "Content-Type": "application/json" },
  });
}

function pushSessionResponse() {
  fetchResponses.push({
    status: 200,
    body: JSON.stringify({
      result: { message: "Session created." },
      session: { id: "game-sess-1", created_at: "2026-01-01T00:00:00Z", expires_at: "2026-01-01T00:30:00Z" },
    }),
    headers: { "Content-Type": "application/json" },
  });
}

/** Push the 3 responses needed for MCP init: session + initialize + initialized notification */
function pushInitSequence() {
  // 1. Game session
  pushSessionResponse();
  // 2. MCP initialize (needs Mcp-Session-Id header)
  fetchResponses.push({
    status: 200,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } }),
    headers: { "Content-Type": "application/json", "Mcp-Session-Id": "mcp-sess-1" },
  });
  // 3. Initialized notification (empty response)
  fetchResponses.push({
    status: 200,
    body: "",
    headers: { "Content-Type": "application/json" },
  });
}

/** Push init sequence + login success */
function pushLoginSequence() {
  pushInitSequence();
  pushMcpToolResult(JSON.stringify({ message: "Welcome back!", session_id: "game-sess-1" }));
}

describe("HttpGameClient (MCP)", () => {
  let client: HttpGameClient;

  beforeEach(() => {
    fetchResponses = [];
    fetchMock = mock(async (_url: string | URL | Request, _opts?: RequestInit) => {
      const resp = fetchResponses.shift();
      if (!resp) throw new Error("No mock response queued");
      const headers = new Headers(resp.headers);
      return new Response(resp.body, { status: resp.status, headers });
    });
    globalThis.fetch = fetchMock as typeof fetch;
    client = new HttpGameClient("https://game.test/mcp");
    client.label = "test-agent";
  });

  afterEach(async () => {
    await client.close();
    globalThis.fetch = originalFetch;
  });

  it("login performs MCP handshake and authenticates", async () => {
    pushLoginSequence();
    const resp = await client.login("TestBot", "pass123");
    expect(resp.error).toBeUndefined();
    expect(client.isAuthenticated()).toBe(true);
    // Verify: session POST, initialize POST, initialized POST, login tool call
    expect(fetchMock.mock.calls.length).toBe(4);
  });

  it("login sends X-Session-Id and Mcp-Session-Id headers", async () => {
    pushLoginSequence();
    await client.login("bot", "pass");
    // The login tool call is the 4th fetch call (index 3)
    const loginCall = fetchMock.mock.calls[3];
    const headers = (loginCall[1] as RequestInit).headers as Record<string, string>;
    expect(headers["X-Session-Id"]).toBe("game-sess-1");
    expect(headers["Mcp-Session-Id"]).toBe("mcp-sess-1");
  });

  it("execute sends JSON-RPC tools/call", async () => {
    pushLoginSequence();
    await client.login("bot", "pass");

    pushMcpToolResult(JSON.stringify({ ore_type: "iron", quantity: 3 }));
    const resp = await client.execute("mine", { resource: "iron" });
    expect(resp.result).toEqual({ ore_type: "iron", quantity: 3 });

    // Verify the JSON-RPC body
    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    const body = JSON.parse((lastCall[1] as RequestInit).body as string);
    expect(body.method).toBe("tools/call");
    expect(body.params.name).toBe("mine");
    expect(body.params.arguments).toEqual({ resource: "iron" });
  });

  it("execute handles game errors (isError: true)", async () => {
    pushLoginSequence();
    await client.login("bot", "pass");

    pushMcpToolResult("Error: not_docked: You must be docked at a station.", true);
    const resp = await client.execute("refuel");
    expect(resp.error?.code).toBe("not_docked");
    expect(resp.error?.message).toBe("You must be docked at a station.");
  });

  it("execute handles JSON-RPC protocol errors", async () => {
    pushLoginSequence();
    await client.login("bot", "pass");

    pushMcpError(-32600, "Session not initialized");
    const resp = await client.execute("get_status");
    expect(resp.error?.code).toBe("-32600");
    expect(resp.error?.message).toBe("Session not initialized");
  });

  it("execute parses SSE responses", async () => {
    pushLoginSequence();
    await client.login("bot", "pass");

    // SSE-formatted response
    const sseBody = 'event: message\ndata: {"jsonrpc":"2.0","id":5,"result":{"content":[{"type":"text","text":"{\\"credits\\":1000}"}]}}\n\n';
    fetchResponses.push({
      status: 200,
      body: sseBody,
      headers: { "Content-Type": "text/event-stream" },
    });
    const resp = await client.execute("get_credits");
    expect(resp.result).toEqual({ credits: 1000 });
  });

  it("execute retries on action_pending", async () => {
    pushLoginSequence();
    await client.login("bot", "pass");

    // Use JSON error text with wait_seconds=0 so the retry doesn't sleep
    pushMcpToolResult(JSON.stringify({ code: "action_pending", message: "Action pending", wait_seconds: 0 }), true);
    pushMcpToolResult(JSON.stringify({ ore: "iron" }));
    const resp = await client.execute("mine");
    expect(resp.result).toEqual({ ore: "iron" });
  });

  it("execute retries on session_expired with re-init", async () => {
    pushLoginSequence();
    await client.login("bot", "pass");

    // Command fails
    pushMcpToolResult("Error: session_expired: Session expired", true);
    // Re-init sequence (session + init + initialized + login)
    pushInitSequence();
    pushMcpToolResult(JSON.stringify({ message: "Welcome back!" }));
    // Retry command
    pushMcpToolResult(JSON.stringify({ status: "ok" }));

    const resp = await client.execute("get_status");
    expect(resp.error).toBeUndefined();
    expect(resp.result).toEqual({ status: "ok" });
  });

  it("logout clears session state", async () => {
    pushLoginSequence();
    await client.login("bot", "pass");
    expect(client.isAuthenticated()).toBe(true);

    pushMcpToolResult(JSON.stringify({ message: "Logged out" }));
    await client.logout();
    expect(client.isAuthenticated()).toBe(false);
  });

  it("refreshStatus returns structured player data", async () => {
    pushLoginSequence();
    await client.login("bot", "pass");

    const statusData = { player: { credits: 5000, current_system: "sol" }, ship: { hull: 100 } };
    pushMcpToolResult(JSON.stringify(statusData));
    const result = await client.refreshStatus();
    expect(result).toEqual(statusData);
  });

  it("waitForTick refreshes status (no-op for timing)", async () => {
    let stateUpdateCalled = false;
    client.onStateUpdate = () => { stateUpdateCalled = true; };

    pushLoginSequence();
    await client.login("bot", "pass");

    pushMcpToolResult(JSON.stringify({ player: { credits: 100 } }));
    await client.waitForTick();
    expect(stateUpdateCalled).toBe(true);
  });

  it("getCredentials returns stored credentials", async () => {
    pushLoginSequence();
    await client.login("bot", "pass");
    expect(client.getCredentials()?.username).toBe("bot");
  });

  it("restoreCredentials sets credentials without login", () => {
    client.restoreCredentials({ username: "bot", password: "pass" });
    expect(client.getCredentials()?.username).toBe("bot");
    expect(client.isAuthenticated()).toBe(false);
  });

  it("close clears all state", async () => {
    pushLoginSequence();
    await client.login("bot", "pass");
    await client.close();
    expect(client.isAuthenticated()).toBe(false);
  });

  it("getConnectionHealth returns zeroed metrics", () => {
    const health = client.getConnectionHealth();
    expect(health.rapidDisconnects).toBe(0);
    expect(health.reconnectsPerMinute).toBe(0);
  });

  it("hasSocksProxy returns false when no socksPort", () => {
    expect(client.hasSocksProxy).toBe(false);
  });

  it("includes User-Agent header", async () => {
    pushLoginSequence();
    await client.login("bot", "pass");
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["User-Agent"]).toMatch(/^Gantry\//);
  });
});
