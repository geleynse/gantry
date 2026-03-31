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
}

// Shared constants used by both WS and HTTP implementations
export const ACTION_PENDING_MAX_RETRIES = 5;
export const ACTION_PENDING_DEFAULT_WAIT_S = 12;
export const RATE_LIMITED_MAX_RETRIES = 3;
export const RATE_LIMITED_WAIT_S = 2;
export const COMMAND_TIMEOUT_MS = 90_000;
