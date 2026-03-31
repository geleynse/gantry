"use client";

import { useSSE } from './use-sse';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LatencyMetrics {
  agent: string;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  avgMs: number | null;
}

export interface ErrorRateBreakdown {
  agent: string;
  totalCalls: number;
  successRate: number;
  errorsByType: Record<string, number>;
  countRateLimit: number;
  countConnection: number;
}

export type AgentShutdownState = 'none' | 'shutdown_waiting' | 'draining' | 'stopped' | 'stop_after_turn';

export interface AgentStatus {
  name: string;
  backend: string;
  model?: string;
  role?: string;
  /** Role type from fleet-config.json (e.g. "trader", "combat", "explorer") — #213a */
  roleType?: string;
  /** Skill module names from fleet-config.json — #213a */
  skillModules?: string[];
  /** Operating zone from fleet-config.json — #213a */
  operatingZone?: string;
  /** Faction note from fleet-config.json — #213a */
  factionNote?: string;
  llmRunning: boolean;
  state: 'running' | 'backed-off' | 'stale' | 'stopped' | 'unreachable' | 'dead';
  turnCount: number;
  lastTurnAge?: string;
  lastTurnAgeSeconds?: number;
  quotaHits: number;
  authHits: number;
  shutdownPending: boolean;
  lastGameOutput: string[];
  healthScore: number;
  healthIssues: string[];
  proxy?: string;
  // Session tracking
  sessionStartedAt?: string | null;
  lastToolCallAt?: string | null;
  // Health details
  latencyMetrics?: LatencyMetrics;
  errorRate?: ErrorRateBreakdown;
  connectionStatus?: 'connected' | 'disconnected' | 'reconnecting';
  // Shutdown state tracking
  inBattle?: boolean;
  shutdownState?: AgentShutdownState;
  proxySessionActive?: boolean;
  lastActivityAt?: string | null;
}

export interface ProxyInfo {
  name: string;
  port: number;
  host: string;
  status: 'up' | 'down' | 'unknown';
  agents: string[];
}

export interface ActionProxyStatus {
  processRunning: boolean;
  healthy: boolean;
  activeAgents: string[];
  toolCount: number;
}

export interface FleetStatus {
  agents: AgentStatus[];
  proxies: ProxyInfo[];
  actionProxy: ActionProxyStatus;
  turnSleepMs: number;
  timestamp: string;
  fleetName?: string;
}

export interface ToolCallEvent {
  agent: string;
  tool: string;
  /** Epoch ms */
  ts: number;
  success: boolean;
  /** Optional brief summary from the proxy */
  summary?: string;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Subscribes to the fleet-wide status SSE stream and returns typed
 * FleetStatus data, connection state, and any error message.
 */
export function useFleetStatus() {
  return useSSE<FleetStatus>('/api/status/stream', 'status');
}

/**
 * Subscribes to the same SSE stream but filters for `toolCall` events,
 * providing a real-time feed of the most recent tool invocation.
 */
export function useToolCallStream() {
  return useSSE<ToolCallEvent>('/api/status/stream', 'toolCall');
}
