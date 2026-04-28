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
    globalThis.fetch = fetchMock as unknown as typeof fetch;
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

  it("execute returns a structured timeout error instead of throwing on abort", async () => {
    pushLoginSequence();
    await client.login("bot", "pass");

    // Swap fetch with one that honors the AbortSignal — fires as soon as the
    // caller triggers the timeout. mcpToolCall should catch the AbortError,
    // log a warning, and surface a { error: { code: "timeout", ... } } response.
    globalThis.fetch = mock(async (_url: string | URL | Request, opts?: RequestInit) => {
      return new Promise((_, reject) => {
        const signal = opts?.signal;
        if (signal) {
          const onAbort = () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort);
        }
        // never resolve
      });
    }) as unknown as typeof fetch;

    const resp = await client.execute("jump", { target_system: "sirius" }, { timeoutMs: 50 });
    expect(resp.error).toBeDefined();
    expect(resp.error?.code).toBe("timeout");
    expect(String(resp.error?.message)).toContain("jump");
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

describe("HttpGameClient - auto-re-login on not_logged_in", () => {
  let client: HttpGameClient;

  beforeEach(() => {
    fetchResponses = [];
    fetchMock = mock((..._args: unknown[]) => {
      const queued = fetchResponses.shift();
      if (!queued) return Promise.resolve(new Response("", { status: 500 }));
      const headers = new Headers(queued.headers ?? {});
      if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
      return Promise.resolve(new Response(queued.body, { status: queued.status, headers }));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    client = new HttpGameClient("https://game.example.com/mcp", undefined);
    client.label = "test-agent";
  });

  afterEach(async () => {
    await client.close();
    globalThis.fetch = originalFetch;
  });

  it("auto-re-login on not_logged_in error code", async () => {
    pushLoginSequence();
    await client.login("bot", "pass");

    // Command returns not_logged_in
    pushMcpToolResult(JSON.stringify({ code: "not_logged_in", message: "Not logged in" }), true);
    // Re-init sequence (session + init + initialized + login)
    pushInitSequence();
    pushMcpToolResult(JSON.stringify({ message: "Welcome back!" }));
    // Retry command
    pushMcpToolResult(JSON.stringify({ status: "ok" }));

    const resp = await client.execute("get_status");
    expect(resp.error).toBeUndefined();
    expect(resp.result).toEqual({ status: "ok" });
  });

  it("auto-re-login on game_error with 'not logged in' message", async () => {
    pushLoginSequence();
    await client.login("bot", "pass");

    // Command returns game_error with "not logged in" in the message
    pushMcpToolResult("Error: game_error: Player is not logged in", true);
    // Re-init sequence + login
    pushInitSequence();
    pushMcpToolResult(JSON.stringify({ message: "Welcome back!" }));
    // Retry command
    pushMcpToolResult(JSON.stringify({ minerals: ["iron"] }));

    const resp = await client.execute("mine");
    expect(resp.error).toBeUndefined();
    expect(resp.result).toEqual({ minerals: ["iron"] });
  });

  it("auto-re-login on 'Error: not_logged_in: ...' format", async () => {
    pushLoginSequence();
    await client.login("bot", "pass");

    // Command returns Error: not_logged_in: message format
    pushMcpToolResult("Error: not_logged_in: Session expired, please log in again", true);
    // Re-init sequence + login
    pushInitSequence();
    pushMcpToolResult(JSON.stringify({ message: "Welcome back!" }));
    // Retry command
    pushMcpToolResult(JSON.stringify({ status: "docked" }));

    const resp = await client.execute("dock");
    expect(resp.error).toBeUndefined();
    expect(resp.result).toEqual({ status: "docked" });
  });

  it("does not loop — returns error if re-login fails", async () => {
    pushLoginSequence();
    await client.login("bot", "pass");

    // Command returns not_logged_in
    pushMcpToolResult(JSON.stringify({ code: "not_logged_in", message: "Not logged in" }), true);
    // Re-init fails (session creation returns error)
    fetchResponses.push({
      status: 500,
      body: JSON.stringify({ error: "server error" }),
      headers: { "Content-Type": "application/json" },
    });

    const resp = await client.execute("get_status");
    // Should return the original error, not loop
    expect(resp.error).toBeDefined();
    expect(resp.error!.code).toBe("not_logged_in");
  });

  it("max 1 re-login attempt per request (no infinite loops)", async () => {
    pushLoginSequence();
    await client.login("bot", "pass");

    // Command returns not_logged_in
    pushMcpToolResult(JSON.stringify({ code: "not_logged_in", message: "Not logged in" }), true);
    // Re-init succeeds
    pushInitSequence();
    pushMcpToolResult(JSON.stringify({ message: "Welcome back!" }));
    // But retry ALSO returns not_logged_in (weird edge case)
    pushMcpToolResult(JSON.stringify({ code: "not_logged_in", message: "Still not logged in" }), true);

    const resp = await client.execute("get_status");
    // Should return the second error without trying to re-login again
    expect(resp.error).toBeDefined();
    expect(resp.error!.code).toBe("not_logged_in");
  });

  it("increments reconnectCount on successful auto-re-login", async () => {
    pushLoginSequence();
    await client.login("bot", "pass");
    expect(client.getConnectionHealth().totalReconnects).toBe(0);

    // Command returns not_logged_in
    pushMcpToolResult(JSON.stringify({ code: "not_logged_in", message: "Not logged in" }), true);
    // Re-init + login
    pushInitSequence();
    pushMcpToolResult(JSON.stringify({ message: "Welcome back!" }));
    // Retry command
    pushMcpToolResult(JSON.stringify({ status: "ok" }));

    const resp = await client.execute("get_status");
    expect(resp.error).toBeUndefined();
    expect(client.getConnectionHealth().totalReconnects).toBe(1);
  });

  it("does not increment reconnectCount when re-login fails", async () => {
    pushLoginSequence();
    await client.login("bot", "pass");

    // Command returns not_logged_in
    pushMcpToolResult(JSON.stringify({ code: "not_logged_in", message: "Not logged in" }), true);
    // Re-init fails
    fetchResponses.push({
      status: 500,
      body: JSON.stringify({ error: "server error" }),
      headers: { "Content-Type": "application/json" },
    });

    const resp = await client.execute("get_status");
    expect(resp.error).toBeDefined();
    expect(client.getConnectionHealth().totalReconnects).toBe(0);
  });
});
