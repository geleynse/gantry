/**
 * Shared test factory functions.
 * Produces minimal valid instances of common types used across the test suite.
 * Use overrides to customize specific fields per test.
 */
import type { GantryConfig } from "../config.js";
import type { SharedState } from "../proxy/server.js";
import { MarketReservationCache } from "../proxy/market-reservations.js";
import { AnalyzeMarketCache } from "../proxy/analyze-market-cache.js";

// ---------------------------------------------------------------------------
// GantryConfig factory
// ---------------------------------------------------------------------------

export function createMockConfig(overrides: Partial<GantryConfig> = {}): GantryConfig {
  return {
    agents: [{ name: "test-agent" }],
    gameUrl: "http://localhost:3000/mcp",
    gameApiUrl: "http://localhost:3000/api/v1",
    gameMcpUrl: "http://localhost:3000/mcp",
    agentDeniedTools: {},
    callLimits: {},
    turnSleepMs: 90,
    staggerDelay: 5,
    maxIterationsPerSession: 200,
    maxTurnDurationMs: 300_000,
    idleTimeoutMs: 120_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// SharedState factory
// ---------------------------------------------------------------------------

export function createMockSharedState(overrides: Partial<SharedState> = {}): SharedState {
  return {
    sessions: {
      active: {} as SharedState["sessions"]["active"],
      store: {} as SharedState["sessions"]["store"],
      agentMap: new Map(),
    },
    cache: {
      status: new Map(),
      battle: new Map(),
      market: {} as SharedState["cache"]["market"],
      events: new Map(),
    },
    proxy: {
      gameTools: [],
      serverDescriptions: new Map(),
      gameHealthRef: { current: null },
      callTrackers: new Map(),
      breakerRegistry: {} as SharedState["proxy"]["breakerRegistry"],
      serverMetrics: {} as SharedState["proxy"]["serverMetrics"],
    },
    fleet: {
      galaxyGraphRef: { current: {} as SharedState["fleet"]["galaxyGraphRef"]["current"] },
      sellLog: {} as SharedState["fleet"]["sellLog"],
      arbitrageAnalyzer: {} as SharedState["fleet"]["arbitrageAnalyzer"],
      coordinator: null,
      marketReservations: new MarketReservationCache({ pruneIntervalMs: 999_999_999 }),
      analyzeMarketCache: new AnalyzeMarketCache(),
    },
    ...overrides,
  } as SharedState;
}

// ---------------------------------------------------------------------------
// Mock GameClient factory
// ---------------------------------------------------------------------------

export interface MockGameClient {
  label: string;
  onEvent: ((event: unknown) => void) | null;
  onStateUpdate: ((data: Record<string, unknown>) => void) | null;
  onReconnect: (() => void) | null;
  lastArrivalTick: number | null;
  execute: (tool: string, args?: unknown) => Promise<{ result?: unknown; error?: unknown }>;
  login: (username: string, password: string) => Promise<{ result?: unknown; error?: unknown }>;
  logout: () => Promise<void>;
  waitForTick: (ms?: number) => Promise<void>;
  refreshStatus: () => Promise<Record<string, unknown> | null>;
  getCredentials: () => { username: string; password: string } | null;
  isConnected: () => boolean;
}

export function createMockGameClient(overrides: Partial<MockGameClient> = {}): MockGameClient {
  return {
    label: "test-agent",
    onEvent: null,
    onStateUpdate: null,
    onReconnect: null,
    lastArrivalTick: null,
    execute: async () => ({ result: { status: "ok" } }),
    login: async () => ({ result: { status: "ok" } }),
    logout: async () => {},
    waitForTick: async () => {},
    refreshStatus: async () => ({ player: { credits: 1000, current_system: "Sol" } }),
    getCredentials: () => ({ username: "test-agent", password: "password" }),
    isConnected: () => true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock Express Request factory
// ---------------------------------------------------------------------------

export interface MockRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
  get: (header: string) => string | undefined;
}

export function createMockRequest(overrides: Partial<MockRequest> = {}): MockRequest {
  const headers: Record<string, string> = overrides.headers ?? {};
  return {
    method: "GET",
    path: "/",
    params: {},
    query: {},
    body: {},
    headers,
    get: (header: string) => headers[header.toLowerCase()],
    ...overrides,
  };
}
