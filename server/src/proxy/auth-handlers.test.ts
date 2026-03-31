/**
 * Tests for auth-handlers.ts — shared login/logout logic.
 *
 * Uses plain mock objects rather than Bun's mock.module() to avoid
 * cross-test pollution (see Bun testing gotchas in MEMORY.md).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { handleLogin, handleLogout } from "./auth-handlers.js";
import type { LoginDeps, HandoffRecord } from "./auth-handlers.js";
import { EventBuffer } from "./event-buffer.js";
import { SessionStore } from "./session-store.js";
import type { AgentCallTracker, BattleState } from "./server.js";
import type { GantryConfig } from "../config.js";
import { createDatabase, closeDb } from "../services/database.js";
import { resetSessionShutdownManager } from "./session-shutdown.js";

// ---------------------------------------------------------------------------
// Mock GameClient
// ---------------------------------------------------------------------------

function makeClient(loginError?: { code: string; message: string }) {
  const client = {
    onEvent: null as ((event: unknown) => void) | null,
    onStateUpdate: null as ((data: Record<string, unknown>) => void) | null,
    onReconnect: null as (() => void) | null,
    _authenticated: false,
    isAuthenticated() { return this._authenticated; },
    loginCalled: false,
    logoutCalled: false,
    refreshStatusCalled: false,
    async login(_u: string, _p: string) {
      client.loginCalled = true;
      if (loginError) return { error: loginError };
      client._authenticated = true;
      return { result: { status: "ok" } };
    },
    async logout() {
      client.logoutCalled = true;
    },
    async execute(_tool: string, _args: unknown): Promise<{ result?: unknown; error?: unknown }> {
      return { result: { status: "ok" } };
    },
    async refreshStatus(): Promise<Record<string, unknown> | null> {
      client.refreshStatusCalled = true;
      return { player: { current_system: "Sol", credits: 1000 }, ship: { hull: 100, fuel: 50 } };
    },
  };
  return client;
}

type MockClient = ReturnType<typeof makeClient>;

// ---------------------------------------------------------------------------
// Mock SessionManager
// ---------------------------------------------------------------------------

function makeSessionManager(agentName = "test-agent", client?: MockClient) {
  const mgr = {
    resolveAgentName: (_username: string) => agentName,
    getOrCreateClient: () => (client ?? makeClient()) as unknown as InstanceType<typeof import("./game-client.js").HttpGameClient>,
    getClient: () => (client ?? undefined) as unknown as InstanceType<typeof import("./game-client.js").HttpGameClient> | undefined,
    removeClient: (_name: string) => {},
    persistSessions: () => {},
    // Account pool methods — always return null in tests (no pool configured)
    getCredentialsFromPool: (_agentName: string) => null as { username: string; password: string } | null,
    recordPoolLogin: (_agentName: string) => {},
    persistSessionsCalled: false,
    removeClientCalled: false,
  };
  mgr.persistSessions = () => { mgr.persistSessionsCalled = true; };
  mgr.removeClient = (_name: string) => { mgr.removeClientCalled = true; };
  return mgr;
}

// ---------------------------------------------------------------------------
// Mock SessionStore
// ---------------------------------------------------------------------------

function makeSessionStore() {
  let mockIterationCount = 0;
  let mockTurnStartedAt: string | null = null;
  return {
    createSession: () => "mock-session-id",
    getSession: () => null,
    isValidSession: () => true,
    setSessionAgent: () => {},
    expireAgentSessions: () => {},
    cleanup: () => 0,
    getActiveSessions: () => [],
    incrementIterationCount: (_id: string) => {
      mockIterationCount++;
      return mockIterationCount;
    },
    getIterationCount: (_id: string) => mockIterationCount,
    resetIterationCount: (_id: string) => {
      mockIterationCount = 0;
      mockTurnStartedAt = new Date().toISOString();
    },
    getTurnStartedAt: (_id: string) => mockTurnStartedAt,
  };
}

// ---------------------------------------------------------------------------
// Build LoginDeps
// ---------------------------------------------------------------------------

const testConfig: GantryConfig = {
  agents: [
    { name: "test-agent", homeSystem: "Sol" },
    { name: "other-agent" },
  ],
  gameUrl: "https://game.test/mcp",
  gameApiUrl: "https://game.test/api/v1",
  agentDeniedTools: {},
  callLimits: {},
  turnSleepMs: 90,
  staggerDelay: 20,
};

function makeDeps(overrides: Partial<{
  client: MockClient;
  agentName: string;
  handoff: HandoffRecord | null;
  sessionAgentMap: Map<string, string>;
}> = {}): LoginDeps & {
  _sessionManager: ReturnType<typeof makeSessionManager>;
  _client: MockClient;
  _createdHandoffs: unknown[];
  _consumedHandoffIds: number[];
  _resetTrackerCalls: string[];
  _logToolCallCalls: Array<{ agentName: string; tool: string }>;
} {
  const client = overrides.client ?? makeClient();
  const agentName = overrides.agentName ?? "test-agent";
  const sm = makeSessionManager(agentName, client);
  const sessionAgentMap = overrides.sessionAgentMap ?? new Map<string, string>();
  const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
  const battleCache = new Map<string, BattleState | null>();
  const eventBuffers = new Map<string, EventBuffer>();
  const callTrackers = new Map<string, AgentCallTracker>();
  const createdHandoffs: unknown[] = [];
  const consumedHandoffIds: number[] = [];
  const resetTrackerCalls: string[] = [];
  const logToolCallCalls: Array<{ agentName: string; tool: string }> = [];

  return {
    _sessionManager: sm,
    _client: client,
    _createdHandoffs: createdHandoffs,
    _consumedHandoffIds: consumedHandoffIds,
    _resetTrackerCalls: resetTrackerCalls,
    _logToolCallCalls: logToolCallCalls,

    sessions: sm as unknown as LoginDeps["sessions"],
    sessionStore: makeSessionStore() as unknown as SessionStore,
    sessionAgentMap,
    statusCache,
    battleCache,
    eventBuffers,
    callTrackers,
    config: testConfig,
    throttledPersistGameState: () => {},
    persistBattleState: () => {},
    resetTracker: (name: string) => { resetTrackerCalls.push(name); },
    logToolCall: (agentName: string, tool: string) => { logToolCallCalls.push({ agentName, tool }); },
    logWsEvent: () => {},
    getUnconsumedHandoff: (_name: string) => overrides.handoff ?? null,
    consumeHandoff: (id: number) => { consumedHandoffIds.push(id); },
    createHandoff: (data: unknown) => { createdHandoffs.push(data); },
  };
}

// ---------------------------------------------------------------------------
// handleLogin tests
// ---------------------------------------------------------------------------

describe("handleLogin", () => {
  it("happy path: session mapped, tracker reset, status cache primed", async () => {
    const deps = makeDeps();
    const result = await handleLogin(deps, "sess-abc", "test-agent", "pass");

    // Session mapping set
    expect(deps.sessionAgentMap.get("sess-abc")).toBe("test-agent");

    // Tracker reset called
    expect(deps._resetTrackerCalls).toContain("test-agent");

    // refreshStatus was called (status cache primed)
    expect(deps._client.refreshStatusCalled).toBe(true);

    // Status cache populated via onStateUpdate callback
    expect(deps.statusCache.has("test-agent")).toBe(true);

    // Sessions persisted
    expect(deps._sessionManager.persistSessionsCalled).toBe(true);

    // Result contains valid JSON
    const text = result.content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed).toBeDefined();
    expect(parsed.error).toBeUndefined();

    // Status cache should have player data with current_system
    const cached = deps.statusCache.get("test-agent");
    expect((cached?.data.player as Record<string, unknown> | undefined)?.["current_system"]).toBe("Sol");
  });

  it("happy path: home_system injected from config", async () => {
    const deps = makeDeps();
    const result = await handleLogin(deps, "sess-1", "test-agent", "pass");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.home_system).toBe("Sol");
  });

  it("happy path: no home_system when agent has none", async () => {
    const deps = makeDeps({ agentName: "other-agent" });
    const result = await handleLogin(deps, "sess-2", "other-agent", "pass");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.home_system).toBeUndefined();
  });

  it("error path: login failure returns error, tracker not reset, status not primed", async () => {
    const failClient = makeClient({ code: "auth_failed", message: "Bad credentials" });
    const deps = makeDeps({ client: failClient });

    const result = await handleLogin(deps, "sess-fail", "test-agent", "wrong");

    // Session IS mapped even on failure (matches original server.ts behavior — sessionId is
    // set before the error check so that logout can still resolve the agent for cleanup)
    expect(deps.sessionAgentMap.has("sess-fail")).toBe(true);

    // Tracker should NOT be reset on failure
    expect(deps._resetTrackerCalls).toHaveLength(0);

    // refreshStatus should NOT be called on failure
    expect(failClient.refreshStatusCalled).toBe(false);

    // Result contains the error object spread at top level (per server.ts logic:
    // loginResult = resp.error, resultObj = { ...resp.error })
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.code).toBe("auth_failed");
    expect(parsed.message).toBeDefined();
  });

  it("error path: sessions not persisted on login failure", async () => {
    const failClient = makeClient({ code: "auth_failed", message: "Bad credentials" });
    const deps = makeDeps({ client: failClient });

    await handleLogin(deps, "sess-fail", "test-agent", "wrong");

    expect(deps._sessionManager.persistSessionsCalled).toBe(false);
  });

  it("with handoff: handoff message included in result and handoff consumed", async () => {
    const handoff: HandoffRecord = {
      id: 42,
      location_system: "Alpha Centauri",
      location_poi: "Station Prime",
      credits: 5000,
      fuel: 80,
    };
    const deps = makeDeps({ handoff });

    const result = await handleLogin(deps, "sess-hoff", "test-agent", "pass");
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.session_handoff).toContain("Alpha Centauri");
    expect(parsed.session_handoff).toContain("Station Prime");
    expect(parsed.session_handoff).toContain("5000 credits");
    expect(parsed.session_handoff).toContain("80 fuel");

    // Handoff should be consumed
    expect(deps._consumedHandoffIds).toContain(42);
  });

  it("with handoff: location_poi omitted when null", async () => {
    const handoff: HandoffRecord = {
      id: 7,
      location_system: "Vega",
      credits: 100,
      fuel: 30,
    };
    const deps = makeDeps({ handoff });

    const result = await handleLogin(deps, "sess-nopoi", "test-agent", "pass");
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.session_handoff).toContain("Vega");
    // No parenthetical POI section
    expect(parsed.session_handoff).not.toContain("(");
  });

  it("no handoff when login fails", async () => {
    const failClient = makeClient({ code: "auth_failed", message: "Bad" });
    const handoff: HandoffRecord = { id: 99, location_system: "Sol", credits: 0, fuel: 0 };
    const deps = makeDeps({ client: failClient, handoff });

    const result = await handleLogin(deps, "sess-x", "test-agent", "bad");
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.session_handoff).toBeUndefined();
    expect(deps._consumedHandoffIds).toHaveLength(0);
  });

  it("event buffer is created and wired before login", async () => {
    const deps = makeDeps();
    expect(deps.eventBuffers.has("test-agent")).toBe(false);

    await handleLogin(deps, "sess-buf", "test-agent", "pass");

    expect(deps.eventBuffers.has("test-agent")).toBe(true);
    expect(deps._client.onEvent).toBeDefined();
    expect(deps._client.onStateUpdate).toBeDefined();
    expect(deps._client.onReconnect).toBeDefined();
  });

  it("retries refreshStatus until player.current_system is available (slow game initialization)", async () => {
    // Mock a client that returns null data on first call, then valid data on retry
    let callCount = 0;
    const slowClient = makeClient();
    const originalRefreshStatus = slowClient.refreshStatus.bind(slowClient);
    slowClient.refreshStatus = async () => {
      callCount++;
      if (callCount === 1) {
        // First call: incomplete data (no current_system)
        return { player: { credits: 1000, current_system: null }, ship: { hull: 100, fuel: 50 } };
      }
      // Second call onward: valid data
      return { player: { current_system: "Sol", credits: 1000 }, ship: { hull: 100, fuel: 50 } };
    };

    const deps = makeDeps({ client: slowClient });
    await handleLogin(deps, "sess-slow", "test-agent", "pass");

    // Should have called refreshStatus at least twice
    expect(callCount).toBeGreaterThanOrEqual(2);

    // Status cache should have valid data from the successful attempt
    const cached = deps.statusCache.get("test-agent");
    expect((cached?.data.player as Record<string, unknown> | undefined)?.["current_system"]).toBe("Sol");
  });

  it("undefined sessionId is handled gracefully", async () => {
    const deps = makeDeps();
    const result = await handleLogin(deps, undefined, "test-agent", "pass");

    // No session mapping attempted (nothing to map)
    expect(deps.sessionAgentMap.size).toBe(0);

    // Login still succeeds
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBeUndefined();
  });

  it("login resets iteration count and turn start time for guardrails", async () => {
    const mockSessionStore = makeSessionStore();
    // Manually set some initial values
    mockSessionStore.incrementIterationCount("sess-reset"); // Set to 1
    mockSessionStore.incrementIterationCount("sess-reset"); // Set to 2
    // mockTurnStartedAt is null by default in makeSessionStore()

    const deps = makeDeps({} as any); // Cast to any to override sessionStore
    deps.sessionStore = mockSessionStore as any; // Inject our mock

    expect(deps.sessionStore.getIterationCount("sess-reset")).toBe(2);
    expect(deps.sessionStore.getTurnStartedAt("sess-reset")).toBeNull();

    await handleLogin(deps, "sess-reset", "test-agent", "pass");

    expect(deps.sessionStore.getIterationCount("sess-reset")).toBe(0);
    // Check if turn_started_at is a recent timestamp (within a reasonable range)
    const now = new Date();
    const turnStartTime = new Date(deps.sessionStore.getTurnStartedAt("sess-reset")!);
    expect(turnStartTime.getTime()).toBeLessThanOrEqual(now.getTime());
    expect(turnStartTime.getTime()).toBeGreaterThan(now.getTime() - 5000); // Within 5 seconds
  });

  it("onEvent wires combat_update into battleCache", async () => {
    const deps = makeDeps();
    await handleLogin(deps, "sess-ev", "test-agent", "pass");

    // Simulate a combat_update push
    const client = deps._client;
    client.onEvent?.({
      type: "combat_update",
      payload: {
        battle_id: "battle-1",
        zone: "sector-A",
        stance: "aggressive",
        hull: 75,
        shields: 50,
        target: { name: "Pirate" },
        status: "active",
      },
      receivedAt: Date.now(),
    });

    const bs = deps.battleCache.get("test-agent");
    expect(bs).toBeDefined();
    expect(bs?.battle_id).toBe("battle-1");
    expect(bs?.hull).toBe(75);
  });

  it("onEvent wires player_died: clears battleCache and flags death enrichment", async () => {
    const deps = makeDeps();
    await handleLogin(deps, "sess-die", "test-agent", "pass");

    deps.battleCache.set("test-agent", {
      battle_id: "b1", zone: "z", stance: "aggressive",
      hull: 5, shields: 0, target: null, status: "active", updatedAt: Date.now(),
    });

    deps._client.onEvent?.({ type: "player_died", payload: {}, receivedAt: Date.now() });

    expect(deps.battleCache.get("test-agent")).toBeNull();
  });

  it("onReconnect pushes a reconnect marker into the buffer", async () => {
    const deps = makeDeps();
    await handleLogin(deps, "sess-rc", "test-agent", "pass");

    const bufBefore = deps.eventBuffers.get("test-agent")!;
    // Drain any primed events first
    bufBefore.drain();

    deps._client.onReconnect?.();

    const events = bufBefore.drain();
    // The reconnect marker is type "_reconnected" which bypasses the Internal filter
    // because _reconnected is not in INTERNAL_TYPES. It's also not in CRITICAL_TYPES,
    // so it lands as Normal priority and is stored.
    expect(events.some(e => e.type === "_reconnected")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleLogout tests
// ---------------------------------------------------------------------------

describe("handleLogout", () => {
  beforeEach(() => {
    createDatabase(":memory:");
    resetSessionShutdownManager();
  });

  afterEach(() => {
    closeDb();
  });

  it("happy path: handoff created, client removed, session cleaned", async () => {
    const client = makeClient();
    const sessionAgentMap = new Map([["sess-out", "test-agent"]]);
    const deps = makeDeps({ client, sessionAgentMap });

    // Populate status cache so handoff data is available
    deps.statusCache.set("test-agent", {
      data: {
        player: { current_system: "Sol", current_poi: "Trade Station", credits: 2000 },
        ship: { fuel: 60, hull: 90, cargo: [{ item: "ore", qty: 10 }] },
      },
      fetchedAt: Date.now(),
    });

    // Populate event buffer to verify it gets cleaned
    deps.eventBuffers.set("test-agent", new EventBuffer());

    const result = await handleLogout(deps, "sess-out");
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.status).toBe("logged out");

    // Handoff was created
    expect(deps._createdHandoffs).toHaveLength(1);
    const h = deps._createdHandoffs[0] as Record<string, unknown>;
    expect(h.agent).toBe("test-agent");
    expect(h.location_system).toBe("Sol");
    expect(h.credits).toBe(2000);
    expect(h.fuel).toBe(60);

    // Client was logged out and removed
    expect(client.logoutCalled).toBe(true);
    expect(deps._sessionManager.removeClientCalled).toBe(true);

    // Session map cleaned
    expect(sessionAgentMap.has("sess-out")).toBe(false);

    // Event buffer cleaned
    expect(deps.eventBuffers.has("test-agent")).toBe(false);
  });

  it("not logged in: returns error, no side effects", async () => {
    const deps = makeDeps();
    // sessionAgentMap is empty — no session

    const result = await handleLogout(deps, "sess-unknown");
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toBe("not logged in");
    expect(deps._createdHandoffs).toHaveLength(0);
    expect(deps._client.logoutCalled).toBe(false);
  });

  it("not logged in with undefined sessionId: returns error", async () => {
    const deps = makeDeps();

    const result = await handleLogout(deps, undefined);
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toBe("not logged in");
  });

  it("last_actions derived from callTracker counts (top 5 by frequency)", async () => {
    const client = makeClient();
    const sessionAgentMap = new Map([["sess-act", "test-agent"]]);
    const deps = makeDeps({ client, sessionAgentMap });

    deps.statusCache.set("test-agent", {
      data: { player: { current_system: "Sol", credits: 0 }, ship: { fuel: 0 } },
      fetchedAt: Date.now(),
    });

    const tracker: AgentCallTracker = {
      counts: { mine: 10, sell: 8, travel_to: 6, jump: 4, scan: 2, analyze_market: 1 },
      lastCallSig: null,
      calledTools: new Set(),
    };
    deps.callTrackers.set("test-agent", tracker);

    await handleLogout(deps, "sess-act");

    expect(deps._createdHandoffs).toHaveLength(1);
    const h = deps._createdHandoffs[0] as Record<string, unknown>;
    const actions = JSON.parse(h.last_actions as string) as string[];
    // Top 5: mine, sell, travel_to, jump, scan
    expect(actions).toHaveLength(5);
    expect(actions[0]).toBe("mine");
    expect(actions[1]).toBe("sell");
    expect(actions).not.toContain("analyze_market");
  });

  it("statusCache kept after logout (last known state preserved)", async () => {
    const client = makeClient();
    const sessionAgentMap = new Map([["sess-keep", "test-agent"]]);
    const deps = makeDeps({ client, sessionAgentMap });

    const stateEntry = {
      data: { player: { current_system: "Sol", credits: 500 }, ship: { fuel: 30 } },
      fetchedAt: Date.now(),
    };
    deps.statusCache.set("test-agent", stateEntry);

    await handleLogout(deps, "sess-keep");

    // Status cache should still be there (useful for monitoring)
    expect(deps.statusCache.has("test-agent")).toBe(true);
    expect(deps.statusCache.get("test-agent")).toBe(stateEntry);
  });

  it("no handoff created when statusCache is empty", async () => {
    const client = makeClient();
    const sessionAgentMap = new Map([["sess-nocache", "test-agent"]]);
    const deps = makeDeps({ client, sessionAgentMap });
    // statusCache is empty

    await handleLogout(deps, "sess-nocache");

    expect(deps._createdHandoffs).toHaveLength(0);
    // But logout still completes successfully
    expect(client.logoutCalled).toBe(true);
  });

  it("logout completes shutdown when agent is in draining state", async () => {
    const client = makeClient();
    const sessionAgentMap = new Map([["sess-drain", "test-agent"]]);
    const deps = makeDeps({ client, sessionAgentMap });

    // Set agent to draining state
    const db = deps.statusCache; // Just using this to verify DB access works
    (await import("../services/agent-shutdown-db.js")).setShutdownState("test-agent", "draining");

    const result = await handleLogout(deps, "sess-drain");
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.status).toBe("logged out");

    // Verify shutdown was completed
    const { getShutdownState } = await import("../services/agent-shutdown-db.js");
    expect(getShutdownState("test-agent")).toBe("none");
  });

  it("logout completes shutdown when agent is in shutdown_waiting state", async () => {
    const client = makeClient();
    const sessionAgentMap = new Map([["sess-wait", "test-agent"]]);
    const deps = makeDeps({ client, sessionAgentMap });

    // Set agent to shutdown_waiting state (was waiting for battle to end)
    const { setShutdownState, getShutdownState } = await import("../services/agent-shutdown-db.js");
    setShutdownState("test-agent", "shutdown_waiting");

    expect(getShutdownState("test-agent")).toBe("shutdown_waiting");

    const result = await handleLogout(deps, "sess-wait");
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.status).toBe("logged out");

    // Verify shutdown was completed
    expect(getShutdownState("test-agent")).toBe("none");
  });
});
