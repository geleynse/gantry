// http-game-client-v2.test.ts — unit tests for HttpGameClientV2.
//
// Mocks `globalThis.fetch` and queues responses, mirroring the v1 client tests.
// Covers the four contract obligations the migration plan calls out:
//   1. refreshStatus() parses the get_status text dashboard correctly
//   2. login() parses the greeting Session ID and captures it
//   3. login() falls back to mcpSessionId when greeting has no Session ID line
//   4. execute() injects session_id for spacemolt/spacemolt_battle but not spacemolt_catalog
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { HttpGameClientV2, parseGetStatusText, SessionCreateSpacing } from "./http-game-client-v2.js";

let fetchMock: ReturnType<typeof mock>;
let fetchResponses: Array<{ status: number; body: string; headers?: Record<string, string> }>;
const originalFetch = globalThis.fetch;

function pushMcpToolResult(text: string, isError = false, id = 0) {
  fetchResponses.push({
    status: 200,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text }], isError },
    }),
    headers: { "Content-Type": "application/json" },
  });
}

function pushSessionResponse() {
  fetchResponses.push({
    status: 200,
    body: JSON.stringify({
      result: { message: "Session created." },
      session: {
        id: "game-sess-1",
        created_at: "2026-01-01T00:00:00Z",
        expires_at: "2026-01-01T00:30:00Z",
      },
    }),
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Push a /api/v1/session response whose `expires_at` is `msFromNow`
 * milliseconds in the future, for testing proactive refresh timing.
 */
function pushSessionResponseExpiringIn(msFromNow: number) {
  fetchResponses.push({
    status: 200,
    body: JSON.stringify({
      result: { message: "Session created." },
      session: {
        id: "game-sess-1",
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + msFromNow).toISOString(),
      },
    }),
    headers: { "Content-Type": "application/json" },
  });
}

/** Push the 3 responses needed for MCP init: session + initialize + initialized */
function pushInitSequence(mcpSessionId = "mcp-sess-aaaa") {
  pushSessionResponse();
  fetchResponses.push({
    status: 200,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } }),
    headers: { "Content-Type": "application/json", "Mcp-Session-Id": mcpSessionId },
  });
  fetchResponses.push({
    status: 200,
    body: "",
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Like pushInitSequence but the session expires `msFromNow` ms from now.
 * Used by proactive-refresh tests.
 */
function pushInitSequenceExpiringIn(msFromNow: number, mcpSessionId = "mcp-sess-aaaa") {
  pushSessionResponseExpiringIn(msFromNow);
  fetchResponses.push({
    status: 200,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } }),
    headers: { "Content-Type": "application/json", "Mcp-Session-Id": mcpSessionId },
  });
  fetchResponses.push({
    status: 200,
    body: "",
    headers: { "Content-Type": "application/json" },
  });
}

/** Push init (with near-term expiry) + login-tool response. */
function pushLoginSequenceExpiringIn(
  msFromNow: number,
  greetingText = "Welcome back, Drifter Gale! Session ID: 2f09d1e3e76b2bef88bd037470c09e4a",
  mcpSessionId = "2f09d1e3e76b2bef88bd037470c09e4a",
) {
  pushInitSequenceExpiringIn(msFromNow, mcpSessionId);
  pushMcpToolResult(greetingText);
}

/** Push a tool-call error response (JSON-RPC level isError with structured code). */
function pushMcpToolError(code: string, message: string) {
  pushMcpToolResult(JSON.stringify({ code, message }), true);
}

/** Small helper to await N event-loop turns / real timers. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Push init + a login-tool response with the supplied greeting text. */
function pushLoginSequence(
  greetingText = "Welcome back, Drifter Gale! Session ID: 2f09d1e3e76b2bef88bd037470c09e4a",
  mcpSessionId = "2f09d1e3e76b2bef88bd037470c09e4a",
) {
  pushInitSequence(mcpSessionId);
  pushMcpToolResult(greetingText);
}

const SAMPLE_GET_STATUS = [
  "Drifter Gale [Drifter] | 12,345cr | Sol System",
  "",
  "Ship: Wanderer-class",
  "Hull: 95/100   Shield: 50/50   Armor: 25   Speed: 18",
  "Fuel: 80/120   Cargo: 14/40   CPU: 9/12   Power: 7/10",
  "",
  "Modules:",
  "id\tclass_id\tslot\tsize\twear",
  "mod-1\tlaser_mk2\tweapon_1\tmedium\t0%",
  "mod-2\tshield_booster\tutility_1\tsmall\t5%",
  "",
].join("\n");

describe("parseGetStatusText (parser)", () => {
  it("parses header into username/empire/credits/system", () => {
    const p = parseGetStatusText(SAMPLE_GET_STATUS);
    expect(p.username).toBe("Drifter Gale");
    expect(p.empire).toBe("Drifter");
    expect(p.credits).toBe(12345);
    expect(p.systemDisplayName).toBe("Sol System");
  });

  it("parses hull/shield/armor/speed", () => {
    const p = parseGetStatusText(SAMPLE_GET_STATUS);
    expect(p.hull).toBe(95);
    expect(p.maxHull).toBe(100);
    expect(p.shield).toBe(50);
    expect(p.maxShield).toBe(50);
    expect(p.armor).toBe(25);
    expect(p.speed).toBe(18);
  });

  it("parses fuel/cargo/cpu/power", () => {
    const p = parseGetStatusText(SAMPLE_GET_STATUS);
    expect(p.fuel).toBe(80);
    expect(p.maxFuel).toBe(120);
    expect(p.cargoUsed).toBe(14);
    expect(p.cargoCapacity).toBe(40);
    expect(p.cpuUsed).toBe(9);
    expect(p.cpuCapacity).toBe(12);
    expect(p.powerUsed).toBe(7);
    expect(p.powerCapacity).toBe(10);
  });

  it("parses module rows (skipping header)", () => {
    const p = parseGetStatusText(SAMPLE_GET_STATUS);
    expect(p.modules).toHaveLength(2);
    expect(p.modules[0]).toEqual({
      id: "mod-1",
      class_id: "laser_mk2",
      slot: "weapon_1",
      size: "medium",
      wear: "0%",
    });
    expect(p.modules[1].id).toBe("mod-2");
  });

  it("returns empty modules array when section absent", () => {
    const noMods = "Drifter Gale [Drifter] | 100cr | Sol\nHull: 10/10\nFuel: 5/10\nCargo: 0/10\n";
    const p = parseGetStatusText(noMods);
    expect(p.modules).toEqual([]);
  });

  it("does NOT leak skill rows into modules when sections are not blank-separated", () => {
    // Real production format uses single newlines between sections, with each
    // section terminated by the next "Word (N):" header. Earlier regex
    // (`(?:\\n\\n|$)`) consumed the entire rest of the text and parsed Skills
    // rows like `mining\\t13\\t478\\t6885` as modules with slot="478", item_name="Mining".
    const realFmt = [
      "Drifter Gale [Drifter] | 12,345cr | Sol System",
      "Ship: Prospect (prospect) | Hull: 95/95 | Shield: 75/75 (+1/tick) | Armor: 4 | Speed: 1",
      "Fuel: 41/130 | Cargo: 75/100 | CPU: 8/13 | Power: 19/26",
      "Modules (2):",
      "id\ttype\tslot\tsize\twear\tstats",
      "abc123\tmining_laser_i\tutility\t10\tPristine\tmining_power:5",
      "def456\tpulse_laser_i\tweapon\t10\tPristine\tdamage:10",
      "Cargo (1 items):",
      "item\tqty\tsize",
      "Gold Ore\t14\t1",
      "Skills (3):",
      "skill\tlevel\txp\tnext_level",
      "mining\t13\t478\t6885",
      "exploration\t12\t4810\t5940",
      "trading\t17\t1118\t11365",
    ].join("\n");
    const p = parseGetStatusText(realFmt);
    expect(p.modules).toHaveLength(2);
    expect(p.modules.map((m) => m.id)).toEqual(["abc123", "def456"]);
  });

  it("parses cargo items from the Cargo section", () => {
    const text = [
      "Drifter Gale [Drifter] | 12,345cr | Sol System",
      "Fuel: 41/130 | Cargo: 75/100",
      "Modules (1):",
      "id\ttype\tslot\tsize\twear",
      "abc123\tmining_laser_i\tutility\t10\tPristine",
      "Cargo (2 items):",
      "item\tqty\tsize",
      "Gold Ore\t14\t1",
      "Iron Ore\t61\t1",
      "Skills (1):",
      "skill\tlevel\txp\tnext_level",
      "mining\t13\t478\t6885",
    ].join("\n");
    const p = parseGetStatusText(text);
    expect(p.cargo).toHaveLength(2);
    expect(p.cargo[0]).toEqual({ name: "Gold Ore", quantity: 14 });
    expect(p.cargo[1]).toEqual({ name: "Iron Ore", quantity: 61 });
  });

  it("returns empty cargo array when no Cargo section", () => {
    const text = "Drifter Gale [Drifter] | 100cr | Sol\nHull: 10/10\nFuel: 5/10\nCargo: 0/10\n";
    const p = parseGetStatusText(text);
    expect(p.cargo).toEqual([]);
  });

  it("parses skills from the Skills section", () => {
    const text = [
      "Drifter Gale [Drifter] | 12,345cr | Sol System",
      "Fuel: 41/130 | Cargo: 75/100",
      "Skills (3):",
      "skill\tlevel\txp\tnext_level",
      "mining\t13\t478\t6885",
      "exploration\t12\t4810\t5940",
      "trading\t17\t1118\t11365",
    ].join("\n");
    const p = parseGetStatusText(text);
    expect(p.skills).toHaveLength(3);
    expect(p.skills[0]).toEqual({ name: "mining", level: 13, xp: 478, xpToNext: 6885 });
    expect(p.skills[1]).toEqual({ name: "exploration", level: 12, xp: 4810, xpToNext: 5940 });
    expect(p.skills[2]).toEqual({ name: "trading", level: 17, xp: 1118, xpToNext: 11365 });
  });

  it("returns empty skills array when no Skills section", () => {
    const text = "Drifter Gale [Drifter] | 100cr | Sol\nHull: 10/10\nFuel: 5/10\nCargo: 0/10\n";
    const p = parseGetStatusText(text);
    expect(p.skills).toEqual([]);
  });
});

describe("HttpGameClientV2", () => {
  let client: HttpGameClientV2;

  beforeEach(() => {
    fetchResponses = [];
    // Disable cross-instance spacing during fast unit tests so they don't sleep.
    // Specific spacing tests re-enable it explicitly.
    SessionCreateSpacing.enabled = false;
    fetchMock = mock(async (_url: string | URL | Request, _opts?: RequestInit) => {
      const resp = fetchResponses.shift();
      if (!resp) throw new Error("No mock response queued");
      const headers = new Headers(resp.headers);
      return new Response(resp.body, { status: resp.status, headers });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    client = new HttpGameClientV2(
      "https://game.test/mcp",
      undefined,
      "test-agent",
      "standard",
    );
  });

  afterEach(async () => {
    await client.close();
    globalThis.fetch = originalFetch;
    SessionCreateSpacing.enabled = true;
  });

  // -------------------------------------------------------------------------
  // login()
  // -------------------------------------------------------------------------

  it("login posts to /mcp/v2?preset=standard and authenticates", async () => {
    pushLoginSequence();
    const resp = await client.login("DrifterBot", "pw");
    expect(resp.error).toBeUndefined();
    expect(client.isAuthenticated()).toBe(true);

    // Init sequence (session + init + initialized) + login tool call = 4 fetches.
    expect(fetchMock.mock.calls.length).toBe(4);
    // The MCP-bound fetches all hit the v2 URL with the preset query string.
    const initCall = fetchMock.mock.calls[1];
    expect(String(initCall[0])).toBe("https://game.test/mcp/v2?preset=standard");
  });

  it("login parses Session ID from greeting text and uses it as gameSessionId", async () => {
    // mcpSessionId from the initialize header is "mcp-sess-aaaa", but the
    // greeting carries a different (canonical) game session id.
    pushLoginSequence(
      "Welcome back, Drifter Gale! Session ID: 2f09d1e3e76b2bef88bd037470c09e4a\nGood luck out there.",
      "mcp-sess-aaaa",
    );
    await client.login("bot", "pw");

    // Issue a follow-up call and verify it carries the parsed session_id, not
    // the mcpSessionId.
    pushMcpToolResult(JSON.stringify({ ok: true }));
    await client.execute("spacemolt", { action: "get_player" });
    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    const body = JSON.parse((lastCall[1] as RequestInit).body as string);
    expect(body.params.arguments.session_id).toBe("2f09d1e3e76b2bef88bd037470c09e4a");
  });

  it("login falls back to mcpSessionId when greeting has no 'Session ID:' line", async () => {
    pushLoginSequence("Welcome back, Drifter Gale! Have fun.", "mcp-sess-fallback");
    const resp = await client.login("bot", "pw");
    expect(resp.error).toBeUndefined();

    pushMcpToolResult(JSON.stringify({ ok: true }));
    await client.execute("spacemolt", { action: "get_player" });
    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    const body = JSON.parse((lastCall[1] as RequestInit).body as string);
    expect(body.params.arguments.session_id).toBe("mcp-sess-fallback");
  });

  it("login uses spacemolt_auth(action=login) tool", async () => {
    pushLoginSequence();
    await client.login("bot", "pw");
    // Login tool call is the 4th fetch. Body must be tools/call name=spacemolt_auth.
    const loginCall = fetchMock.mock.calls[3];
    const body = JSON.parse((loginCall[1] as RequestInit).body as string);
    expect(body.method).toBe("tools/call");
    expect(body.params.name).toBe("spacemolt_auth");
    expect(body.params.arguments.action).toBe("login");
    expect(body.params.arguments.username).toBe("bot");
    expect(body.params.arguments.password).toBe("pw");
  });

  // -------------------------------------------------------------------------
  // execute()
  // -------------------------------------------------------------------------

  it("execute injects session_id for spacemolt", async () => {
    pushLoginSequence();
    await client.login("bot", "pw");
    pushMcpToolResult(JSON.stringify({ ok: 1 }));
    await client.execute("spacemolt", { action: "get_player" });
    const body = JSON.parse((fetchMock.mock.calls[4][1] as RequestInit).body as string);
    expect(body.params.name).toBe("spacemolt");
    expect(body.params.arguments.session_id).toBeDefined();
    expect(body.params.arguments.action).toBe("get_player");
  });

  it("execute injects session_id for spacemolt_battle", async () => {
    pushLoginSequence();
    await client.login("bot", "pw");
    pushMcpToolResult(JSON.stringify({ ok: 1 }));
    await client.execute("spacemolt_battle", { action: "status" });
    const body = JSON.parse((fetchMock.mock.calls[4][1] as RequestInit).body as string);
    expect(body.params.name).toBe("spacemolt_battle");
    expect(body.params.arguments.session_id).toBeDefined();
  });

  it("execute injects session_id for spacemolt_storage", async () => {
    pushLoginSequence();
    await client.login("bot", "pw");
    pushMcpToolResult(JSON.stringify({ ok: 1 }));
    await client.execute("spacemolt_storage", { action: "view" });
    const body = JSON.parse((fetchMock.mock.calls[4][1] as RequestInit).body as string);
    expect(body.params.arguments.session_id).toBeDefined();
  });

  it("execute does NOT inject session_id for spacemolt_catalog", async () => {
    pushLoginSequence();
    await client.login("bot", "pw");
    pushMcpToolResult(JSON.stringify({ ok: 1 }));
    await client.execute("spacemolt_catalog", { type: "ships" });
    const body = JSON.parse((fetchMock.mock.calls[4][1] as RequestInit).body as string);
    expect(body.params.name).toBe("spacemolt_catalog");
    expect(body.params.arguments.session_id).toBeUndefined();
    expect(body.params.arguments.type).toBe("ships");
  });

  it("execute respects caller-provided session_id (does not overwrite)", async () => {
    pushLoginSequence();
    await client.login("bot", "pw");
    pushMcpToolResult(JSON.stringify({ ok: 1 }));
    await client.execute("spacemolt", { action: "get_player", session_id: "explicit-id" });
    const body = JSON.parse((fetchMock.mock.calls[4][1] as RequestInit).body as string);
    expect(body.params.arguments.session_id).toBe("explicit-id");
  });

  // -------------------------------------------------------------------------
  // refreshStatus()
  // -------------------------------------------------------------------------

  it("refreshStatus stitches get_status text + get_location JSON into v1-shape", async () => {
    pushLoginSequence();
    await client.login("bot", "pw");

    // refreshStatus fans out two execute() calls in parallel.
    pushMcpToolResult(SAMPLE_GET_STATUS);
    pushMcpToolResult(JSON.stringify({
      location: { system_id: "sol", poi_id: "earth-station", docked_at: "earth-station" },
    }));

    const status = await client.refreshStatus();
    expect(status).not.toBeNull();
    const player = status!.player as Record<string, unknown>;
    const ship = status!.ship as Record<string, unknown>;

    // 8 critical fields the plan calls out.
    expect(player.username).toBe("Drifter Gale");
    expect(player.empire).toBe("Drifter");
    expect(player.credits).toBe(12345);
    expect(player.current_system).toBe("sol");
    expect(player.current_poi).toBe("earth-station");
    expect(player.docked_at_base).toBe("earth-station");
    expect(ship.hull).toBe(95);
    expect(ship.max_hull).toBe(100);
    expect(ship.fuel).toBe(80);
    expect(ship.max_fuel).toBe(120);
    expect(ship.cargo_used).toBe(14);
    expect(ship.cargo_capacity).toBe(40);

    // Pre-existing-bug fix: BOTH max_fuel/fuel_max and max_hull/hull_max emitted.
    expect(ship.fuel_max).toBe(120);
    expect(ship.hull_max).toBe(100);

    // Modules carried over for reload auto-fill.
    expect(Array.isArray(ship.modules)).toBe(true);
    expect((ship.modules as Array<unknown>).length).toBe(2);

    // Hardcoded synthesized field — no v2 equivalent.
    expect(status!.is_cloaked).toBe(false);
  });

  it("refreshStatus accepts a bare-shape get_location (no 'location' wrapper)", async () => {
    pushLoginSequence();
    await client.login("bot", "pw");

    pushMcpToolResult(SAMPLE_GET_STATUS);
    pushMcpToolResult(JSON.stringify({ system_id: "sol", poi_id: "luna", docked_at: null }));

    const status = await client.refreshStatus();
    expect(status).not.toBeNull();
    const player = status!.player as Record<string, unknown>;
    expect(player.current_system).toBe("sol");
    expect(player.current_poi).toBe("luna");
    expect(player.docked_at_base).toBeNull();
  });

  it("refreshStatus returns null when get_status is missing critical fields", async () => {
    pushLoginSequence();
    await client.login("bot", "pw");

    // Header but no Hull/Fuel/Cargo lines.
    pushMcpToolResult("Drifter Gale [Drifter] | 100cr | Sol\n");
    pushMcpToolResult(JSON.stringify({
      location: { system_id: "sol", poi_id: "earth", docked_at: "earth" },
    }));

    const status = await client.refreshStatus();
    expect(status).toBeNull();
  });

  it("refreshStatus returns null when get_location errors", async () => {
    pushLoginSequence();
    await client.login("bot", "pw");

    pushMcpToolResult(SAMPLE_GET_STATUS);
    pushMcpToolResult("Error: not_logged_in: ohno", true);

    const status = await client.refreshStatus();
    expect(status).toBeNull();
  });

  // -------------------------------------------------------------------------
  // logout()
  // -------------------------------------------------------------------------

  it("logout calls spacemolt_auth(action=logout) and clears state", async () => {
    pushLoginSequence();
    await client.login("bot", "pw");
    expect(client.isAuthenticated()).toBe(true);

    pushMcpToolResult(JSON.stringify({ message: "bye" }));
    await client.logout();
    expect(client.isAuthenticated()).toBe(false);

    // Inspect the logout call args.
    const logoutCall = fetchMock.mock.calls[4];
    const body = JSON.parse((logoutCall[1] as RequestInit).body as string);
    expect(body.params.name).toBe("spacemolt_auth");
    expect(body.params.arguments.action).toBe("logout");
  });

  // -------------------------------------------------------------------------
  // misc
  // -------------------------------------------------------------------------

  it("constructor builds full preset URL when preset='full'", () => {
    const fullClient = new HttpGameClientV2(
      "https://game.test/mcp",
      undefined,
      "sable-thorn",
      "full",
    );
    // Indirect verification: trigger an initialize and inspect URL.
    fetchResponses = [];
    pushInitSequence();
    pushMcpToolResult("Welcome back! Session ID: deadbeef");
    return fullClient.login("bot", "pw").then(() => {
      const initCall = fetchMock.mock.calls[1];
      expect(String(initCall[0])).toBe("https://game.test/mcp/v2?preset=full");
    }).finally(() => fullClient.close());
  });

  it("hasSocksProxy returns false when no socksPort given", () => {
    expect(client.hasSocksProxy).toBe(false);
  });

  it("getCredentials returns stored credentials after login", async () => {
    pushLoginSequence();
    await client.login("bot", "pw");
    expect(client.getCredentials()?.username).toBe("bot");
  });

  it("restoreCredentials sets credentials without authenticating", () => {
    client.restoreCredentials({ username: "bot", password: "pw" });
    expect(client.getCredentials()?.username).toBe("bot");
    expect(client.isAuthenticated()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Session creation: rate-limit retry + cross-instance spacing
  // -------------------------------------------------------------------------

  it("mcpInitialize retries when /api/v1/session returns rate_limited", async () => {
    // First /api/v1/session response: rate_limited with retry_after=0 so the
    // test doesn't sleep. Second: a normal session response. Then the rest of
    // the init sequence + login tool.
    fetchResponses.push({
      status: 429,
      body: JSON.stringify({ error: { code: "rate_limited", retry_after: 0, message: "Too many session/auth requests from your IP." } }),
      headers: { "Content-Type": "application/json" },
    });
    pushLoginSequence();

    const resp = await client.login("bot", "pw");
    expect(resp.error).toBeUndefined();
    // 1 rate-limited session call + 1 successful session call + initialize + initialized + login tool = 5
    expect(fetchMock.mock.calls.length).toBe(5);
  });

  it("mcpInitialize gives up and throws after MAX rate-limited retries", async () => {
    // Three consecutive rate_limited responses (the limit is 2 retries → 3
    // total attempts).
    for (let i = 0; i < 3; i++) {
      fetchResponses.push({
        status: 429,
        body: JSON.stringify({ error: { code: "rate_limited", retry_after: 0, message: "Too many session/auth requests" } }),
        headers: { "Content-Type": "application/json" },
      });
    }

    const resp = await client.login("bot", "pw");
    // After exhausting retries, mcpInitialize throws → login() returns connection_failed.
    expect(resp.error?.code).toBe("connection_failed");
  });

  it("awaitSessionCreateSlot enforces minimum spacing between concurrent session creations", async () => {
    // Re-enable spacing for this specific test. Use tight bounds so the test
    // is fast but the spacing effect is measurable.
    SessionCreateSpacing.enabled = true;
    const savedMin = SessionCreateSpacing.minSpacingMs;
    const savedJitter = SessionCreateSpacing.jitterMs;
    SessionCreateSpacing.minSpacingMs = 50;
    SessionCreateSpacing.jitterMs = 0;
    SessionCreateSpacing.lastCreateAtMs = 0;

    try {
      pushLoginSequence();
      pushLoginSequence();
      const client2 = new HttpGameClientV2("https://game.test/mcp", undefined, "test-agent-2", "standard");

      const t0 = Date.now();
      await client.login("bot1", "pw");
      const after1 = Date.now();
      await client2.login("bot2", "pw");
      const after2 = Date.now();
      await client2.close();

      // First login should not be artificially delayed; second login must
      // wait at least the min-spacing window after the first.
      expect(after1 - t0).toBeLessThan(50);
      expect(after2 - after1).toBeGreaterThanOrEqual(45); // allow ~5ms slop
    } finally {
      SessionCreateSpacing.minSpacingMs = savedMin;
      SessionCreateSpacing.jitterMs = savedJitter;
    }
  });

  // -------------------------------------------------------------------------
  // Session renewal: single-flight lock, proactive refresh, suppressed errors
  // -------------------------------------------------------------------------

  it("concurrent session expiry: a second renewSession awaits the first (exactly ONE re-auth)", async () => {
    pushLoginSequence();
    await client.login("bot", "pw");
    // login() did 4 fetches (session, init, initialized, login tool).
    const callsAfterLogin = fetchMock.mock.calls.length;

    // Two concurrent execute() calls both get session_expired. Then ONE renewal
    // sequence (init=3 fetches + login tool) should run, after which both retries
    // succeed. We queue the responses in the order the mock will consume them:
    //   call A -> session_expired
    //   call B -> session_expired
    //   renewal -> init(3) + login(1)
    //   retry A -> ok
    //   retry B -> ok
    // If the lock is broken, a SECOND renewal sequence would fire and exhaust the
    // queue early ("No mock response queued") OR consume extra init calls.
    pushMcpToolError("session_expired", "Session expired");
    pushMcpToolError("session_expired", "Session expired");
    pushInitSequence("mcp-sess-renew"); // single renewal init (3 fetches)
    pushMcpToolResult("Welcome back! Session ID: renewedsession00"); // renewal login tool
    pushMcpToolResult(JSON.stringify({ ok: "A" })); // retry of call A
    pushMcpToolResult(JSON.stringify({ ok: "B" })); // retry of call B

    const [a, b] = await Promise.all([
      client.execute("spacemolt", { action: "get_status" }, { skipMetrics: true }),
      client.execute("spacemolt", { action: "get_location" }, { skipMetrics: true }),
    ]);

    expect(a.error).toBeUndefined();
    expect(b.error).toBeUndefined();

    // Exactly ONE renewal init ran. Count session-create POSTs to /api/v1/session
    // that happened after login.
    const sessionCreatePosts = fetchMock.mock.calls
      .slice(callsAfterLogin)
      .filter((c) => String(c[0]).endsWith("/api/v1/session"));
    expect(sessionCreatePosts.length).toBe(1);

    // reconnectCount incremented exactly once (single renewal).
    expect(client.getConnectionHealth().totalReconnects).toBe(1);
  });

  it("failed renewal clears the single-flight lock so a later call can retry", async () => {
    pushLoginSequence();
    await client.login("bot", "pw");

    // First execute: session_expired, then a renewal that FAILS (session create
    // returns malformed body → mcpInitialize throws → renewSession returns false).
    pushMcpToolError("session_expired", "Session expired");
    fetchResponses.push({
      status: 500,
      body: "not json at all",
      headers: { "Content-Type": "text/plain" },
    });
    const first = await client.execute("spacemolt", { action: "get_status" }, { skipMetrics: true });
    expect(first.error?.code).toBe("session_renewal_failed");

    // The lock must be cleared. A SECOND attempt should be able to renew cleanly.
    pushMcpToolError("session_expired", "Session expired");
    pushInitSequence("mcp-sess-recover");
    pushMcpToolResult("Welcome back! Session ID: recovered0000000");
    pushMcpToolResult(JSON.stringify({ ok: true }));
    const second = await client.execute("spacemolt", { action: "get_status" }, { skipMetrics: true });
    expect(second.error).toBeUndefined();
  });

  it("scheduleSessionRefresh: proactively renews shortly before expiry", async () => {
    // Expiry is 90_000 + ~120ms out, so the refresh fires ~120ms from now.
    pushLoginSequenceExpiringIn(90_000 + 120);
    await client.login("bot", "pw");
    expect(client.getConnectionHealth().totalReconnects).toBe(0);

    // Queue the proactive renewal sequence (init + login tool). No expiry trigger
    // needed for the retry — proactive refresh just renews, it doesn't retry a tool.
    pushInitSequence("mcp-sess-proactive");
    pushMcpToolResult("Welcome back! Session ID: proactive0000000");

    // Wait past the refresh point.
    await delay(220);

    // Proactive refresh should have fired exactly once.
    expect(client.getConnectionHealth().totalReconnects).toBe(1);
  });

  it("scheduleSessionRefresh: does NOT fire when expiry is far out", async () => {
    // Session expires 30min out → refresh point is ~28.5min away, so nothing
    // should fire within the short test window.
    pushLoginSequenceExpiringIn(30 * 60_000);
    await client.login("bot", "pw");

    await delay(120);
    expect(client.getConnectionHealth().totalReconnects).toBe(0);

    // ...but a timer IS armed for the far-future refresh.
    const timer = (client as unknown as { sessionRefreshTimer: unknown }).sessionRefreshTimer;
    expect(timer).not.toBeNull();
  });

  it("execute: returns session_renewal_exhausted after MAX_RECONNECTS reached (no further re-auth)", async () => {
    pushLoginSequence();
    await client.login("bot", "pw");
    const callsAfterLogin = fetchMock.mock.calls.length;

    // Force the circuit-breaker: pretend we've already reconnected 5 times.
    (client as unknown as { reconnectCount: number }).reconnectCount = 5;

    pushMcpToolError("session_expired", "Session expired");
    const resp = await client.execute("spacemolt", { action: "get_status" }, { skipMetrics: true });
    expect(resp.error?.code).toBe("session_renewal_exhausted");
    expect(resp.error?.message).toMatch(/Do NOT call logout or login/);

    // No renewal init happened — only the single failing tool call.
    const sessionCreatePosts = fetchMock.mock.calls
      .slice(callsAfterLogin)
      .filter((c) => String(c[0]).endsWith("/api/v1/session"));
    expect(sessionCreatePosts.length).toBe(0);
  });

  it("execute: returns session_renewal_failed (not session_expired) when renewal fails", async () => {
    pushLoginSequence();
    await client.login("bot", "pw");

    pushMcpToolError("session_expired", "Session expired");
    // Renewal attempt: session creation returns non-JSON → mcpInitialize throws.
    fetchResponses.push({
      status: 500,
      body: "upstream exploded",
      headers: { "Content-Type": "text/plain" },
    });

    const resp = await client.execute("spacemolt", { action: "get_status" }, { skipMetrics: true });
    expect(resp.error?.code).toBe("session_renewal_failed");
    expect(resp.error?.code).not.toBe("session_expired");
    expect(resp.error?.message).toMatch(/Do NOT call logout or login/);
  });

  it("renewSession: re-arms the proactive refresh timer after a successful renewal", async () => {
    pushLoginSequence();
    await client.login("bot", "pw");

    // Trigger a reactive renewal whose new session expires comfortably in the
    // future (REFRESH_LEAD_MS + 5min), so scheduleSessionRefresh arms a live timer.
    pushMcpToolError("session_expired", "Session expired");
    pushInitSequenceExpiringIn(90_000 + 5 * 60_000, "mcp-sess-rearm");
    pushMcpToolResult("Welcome back! Session ID: rearmed000000000");
    pushMcpToolResult(JSON.stringify({ ok: true }));

    const resp = await client.execute("spacemolt", { action: "get_status" }, { skipMetrics: true });
    expect(resp.error).toBeUndefined();

    // The refresh timer is non-null after a successful renewal (far-out expiry).
    const timer = (client as unknown as { sessionRefreshTimer: unknown }).sessionRefreshTimer;
    expect(timer).not.toBeNull();
  });

  it("close: clears the proactive refresh timer (no fetches after close)", async () => {
    // Near-term expiry so a timer is armed.
    pushLoginSequenceExpiringIn(90_000 + 120);
    await client.login("bot", "pw");

    const callsAtClose = fetchMock.mock.calls.length;
    await client.close();

    // Timer must be cleared.
    const timer = (client as unknown as { sessionRefreshTimer: unknown }).sessionRefreshTimer;
    expect(timer).toBeNull();

    // Wait past the would-be refresh point; no new fetches should occur.
    await delay(220);
    expect(fetchMock.mock.calls.length).toBe(callsAtClose);
  });

  // -------------------------------------------------------------------------
  // Turn-1 pre-warm: -32001 recognised as session-expiry + prewarmSession()
  // -------------------------------------------------------------------------

  it("execute: -32001 JSON-RPC error triggers session renewal (turn-1 stale-session fix)", async () => {
    // Turn-1 scenario: login succeeds, but the game server's MCP session is
    // already stale. The first execute() call returns -32001 as a JSON-RPC
    // level error (not a tool isError), which lands as code="-32001".
    // Before the fix, SESSION_EXPIRED_CODES didn't include "-32001", so
    // isNotLoggedInError returned false and no renewal was attempted.
    pushLoginSequence();
    await client.login("bot", "pw");
    const callsAfterLogin = fetchMock.mock.calls.length;

    // Queue a JSON-RPC -32001 error response (as the game server returns it
    // when the MCP session is expired/gone).
    fetchResponses.push({
      status: 200,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32001, message: "Session expired (server may have restarted)" },
      }),
      headers: { "Content-Type": "application/json" },
    });
    // Renewal sequence: init(3) + login tool
    pushInitSequence("mcp-sess-renew-32001");
    pushMcpToolResult("Welcome back! Session ID: renewed32001000000");
    // The retry after renewal
    pushMcpToolResult(JSON.stringify({ system_id: "sol", poi_id: "earth" }));

    const resp = await client.execute("spacemolt", { action: "get_location" }, { skipMetrics: true });

    // execute() should have renewed and returned the retry result.
    expect(resp.error).toBeUndefined();

    // Exactly ONE renewal init (3 session-create calls) happened.
    const sessionPosts = fetchMock.mock.calls
      .slice(callsAfterLogin)
      .filter((c) => String(c[0]).endsWith("/api/v1/session"));
    expect(sessionPosts.length).toBe(1);
    expect(client.getConnectionHealth().totalReconnects).toBe(1);
  });

  it("execute: 'session expired' in message triggers renewal even with non-standard code", async () => {
    // Some game-server variants return session expiry with a string code instead of
    // the numeric -32001. The message-based fallback in isNotLoggedInError must
    // catch these so renewal still fires.
    pushLoginSequence();
    await client.login("bot", "pw");

    // Error with a non-standard code but session-expired message text.
    pushMcpToolError("game_error", "Session expired — please re-authenticate");
    pushInitSequence("mcp-sess-msg-renew");
    pushMcpToolResult("Welcome back! Session ID: msgrenewal0000000");
    pushMcpToolResult(JSON.stringify({ ok: true }));

    const resp = await client.execute("spacemolt", { action: "get_status" }, { skipMetrics: true });
    expect(resp.error).toBeUndefined();
    expect(client.getConnectionHealth().totalReconnects).toBe(1);
  });

  it("prewarmSession: returns true and does not renew when session is live", async () => {
    pushLoginSequence();
    await client.login("bot", "pw");
    const callsAfterLogin = fetchMock.mock.calls.length;

    // Queue a successful get_location response for the prewarm probe.
    pushMcpToolResult(JSON.stringify({ system_id: "sol", poi_id: "earth" }));

    const ok = await client.prewarmSession();

    expect(ok).toBe(true);
    expect(client.getConnectionHealth().totalReconnects).toBe(0);
    // Only one extra fetch (the probe itself) should have happened.
    expect(fetchMock.mock.calls.length).toBe(callsAfterLogin + 1);
  });

  it("prewarmSession: renews on -32001 and returns false (renewal failure path)", async () => {
    // prewarmSession calls execute(get_location). If that returns -32001,
    // execute() fires renewal. If renewal fails (e.g. server still down),
    // execute() returns session_renewal_failed — prewarmSession returns false.
    pushLoginSequence();
    await client.login("bot", "pw");

    // Probe returns -32001; renewal fails (non-JSON 500).
    fetchResponses.push({
      status: 200,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32001, message: "Session expired (server may have restarted)" },
      }),
      headers: { "Content-Type": "application/json" },
    });
    fetchResponses.push({
      status: 500,
      body: "upstream down",
      headers: { "Content-Type": "text/plain" },
    });

    const ok = await client.prewarmSession();

    // Renewal attempted but failed → prewarmSession returns false.
    expect(ok).toBe(false);
  });

  it("prewarmSession: renews on -32001 and returns true when renewal succeeds", async () => {
    pushLoginSequence();
    await client.login("bot", "pw");
    const callsAfterLogin = fetchMock.mock.calls.length;

    // Probe returns -32001.
    fetchResponses.push({
      status: 200,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32001, message: "Session expired (server may have restarted)" },
      }),
      headers: { "Content-Type": "application/json" },
    });
    // Renewal sequence: init(3) + login tool
    pushInitSequence("mcp-sess-prewarm-ok");
    pushMcpToolResult("Welcome back! Session ID: prewarm0000000000");
    // Probe retry after renewal
    pushMcpToolResult(JSON.stringify({ system_id: "sol", poi_id: "earth" }));

    const ok = await client.prewarmSession();

    expect(ok).toBe(true);
    expect(client.getConnectionHealth().totalReconnects).toBe(1);
    // The renewed session should be usable.
    expect(client.isAuthenticated()).toBe(true);

    // Verify session was actually renewed (new session-create POST happened).
    const sessionPosts = fetchMock.mock.calls
      .slice(callsAfterLogin)
      .filter((c) => String(c[0]).endsWith("/api/v1/session"));
    expect(sessionPosts.length).toBe(1);
  });

  it("prewarmSession: returns false when not authenticated", async () => {
    // No login — prewarmSession should be a no-op.
    const ok = await client.prewarmSession();
    expect(ok).toBe(false);
    // No fetches.
    expect(fetchMock.mock.calls.length).toBe(0);
  });
});
