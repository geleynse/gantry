// game-transport.ts — shared interface for game client implementations
import type { CircuitBreaker } from "./circuit-breaker.js";

export interface GameResponse {
  result?: unknown;
  error?: { code: string; message: string; wait_seconds?: number; retry_after?: number } | null;
}

export interface ExecuteOpts {
  timeoutMs?: number;
  noRetry?: boolean;
  skipMetrics?: boolean;
}

export interface ConnectionHealthMetrics {
  rapidDisconnects: number;
  reconnectsPerMinute: number;
  totalReconnects: number;
  lastConnectedAt: number;
  connectionDurationMs: number | null;
  sessionExpiresAt?: number;
  pollIntervalMs?: number;
  activePollWaiters?: number;
}

export interface GameEvent {
  type: string;
  payload?: unknown;
  receivedAt: number;
}

export interface GameTransport {
  label: string;
  readonly breaker: CircuitBreaker;
  credentialsPath?: string;

  // Lifecycle
  login(username: string, password: string): Promise<GameResponse>;
  logout(): Promise<GameResponse>;
  execute(
    command: string,
    payload?: Record<string, unknown>,
    opts?: ExecuteOpts,
  ): Promise<GameResponse>;
  close(): Promise<void>;

  // State
  isAuthenticated(): boolean;
  lastArrivalTick: number | null;
  hasSocksProxy: boolean;
  getCredentials(): { username: string; password: string } | null;
  restoreCredentials(creds: { username: string; password: string }): void;

  // Tick/arrival waiting
  waitForTick(timeoutMs?: number): Promise<void>;
  waitForNextArrival(beforeTick: number | null, timeoutMs?: number): Promise<boolean>;
  waitForTickToReach(targetTick: number, timeoutMs?: number): Promise<boolean>;
  refreshStatus(): Promise<Record<string, unknown> | null>;

  // Event wiring
  onEvent: ((event: GameEvent) => void) | null;
  onStateUpdate: ((data: Record<string, unknown>) => void) | null;
  onReconnect: (() => void) | null;

  // Health
  getConnectionHealth(): ConnectionHealthMetrics;

  /**
   * Returns true if this client speaks the v2 game protocol (HttpGameClientV2).
   * Used by passthrough/compound-tool code paths that need to dispatch v2 tool
   * names + actions instead of the v1 flat tool names.
   *
   * Implemented as a method (not `instanceof`) per the migration plan §"What
   * could go wrong" #4 — `instanceof` can fail across module boundaries after
   * transpilation. Both clients ship a stable runtime check.
   */
  isV2(): boolean;
}

// Shared constants used by both WS and HTTP implementations
export const ACTION_PENDING_MAX_RETRIES = 5;
export const ACTION_PENDING_DEFAULT_WAIT_S = 12;
export const RATE_LIMITED_MAX_RETRIES = 3;
export const RATE_LIMITED_WAIT_S = 2;
export const COMMAND_TIMEOUT_MS = 90_000;

/**
 * Per-tool client timeout for the nav commands `travel` and `jump` (v0.341.1).
 *
 * The game now holds these requests OPEN until the ship arrives — "up to several
 * minutes" for slow ships / long hauls — and explicitly recommends a client
 * timeout of >=600s. The default COMMAND_TIMEOUT_MS (90s) would abort a legitimate
 * long haul and surface a spurious `timeout` error before the game returns. This
 * override is applied ONLY to travel/jump (see compound-tools/travel-to.ts and the
 * passthrough nav path) — a blanket 600s would hide real hangs on every other tool.
 */
export const NAV_COMMAND_TIMEOUT_MS = 600_000;
