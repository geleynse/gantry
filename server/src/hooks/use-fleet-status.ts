"use client";

import { createContext, createElement, useContext, type ReactNode } from 'react';
import { useSSE, type UseSSEResult } from './use-sse';

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

export interface CredentialHealth {
  status: 'ok' | 'auth_failed' | 'unknown';
  lastFailureAt?: number;
  reason?: string;
}

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
  lastToolName?: string | null;
  // Health details
  latencyMetrics?: LatencyMetrics;
  errorRate?: ErrorRateBreakdown;
  connectionStatus?: 'connected' | 'disconnected' | 'reconnecting';
  // Shutdown state tracking
  inBattle?: boolean;
  shutdownState?: AgentShutdownState;
  proxySessionActive?: boolean;
  lastActivityAt?: string | null;
  // Credential health
  credentialHealth?: CredentialHealth;
  /** Whether PrayerLang scripting is enabled for this agent (from fleet-config.json). */
  prayEnabled?: boolean;
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
// Provider + hooks
// ---------------------------------------------------------------------------

/**
 * Context for the shared fleet-status SSE subscription. When the provider is
 * mounted, every `useFleetStatus()` call within the tree shares one EventSource
 * — preventing duplicate subscriptions racing during reconnect, which used to
 * cause Dashboard / Fleet / Agent Detail to disagree on the same agent's
 * health score.
 *
 * The default `null` value indicates no provider; consumers fall back to
 * opening their own subscription so unit tests can render hooks standalone.
 */
const FleetStatusContext = createContext<UseSSEResult<FleetStatus> | null>(null);

/**
 * Mount once at the app root (see `app/layout.tsx`). Owns the single
 * `/api/status/stream` SSE subscription for the fleet-status event so all
 * consumers see identical health-score values, including the staleness
 * adjustment computed server-side in `health-scorer.ts` (slow:* / stale:*
 * issues + score penalty).
 */
export function FleetStatusProvider({ children }: { children: ReactNode }) {
  const value = useSSE<FleetStatus>('/api/status/stream', 'status');
  return createElement(FleetStatusContext.Provider, { value }, children);
}

/**
 * Returns the shared fleet-status data published by `FleetStatusProvider`.
 *
 * If no provider is mounted (e.g. unit tests rendering the hook in
 * isolation), this opens its own subscription as a fallback so the hook
 * remains usable standalone.
 */
export function useFleetStatus(): UseSSEResult<FleetStatus> {
  const ctx = useContext(FleetStatusContext);
  // Always call the fallback hook so React's hook-call order stays stable
  // across renders, but disable its EventSource when a provider is present.
  const fallback = useSSE<FleetStatus>('/api/status/stream', 'status', {
    disabled: ctx !== null,
  });
  return ctx ?? fallback;
}

/**
 * Subscribes to the same SSE stream but filters for `toolCall` events,
 * providing a real-time feed of the most recent tool invocation.
 *
 * This is a separate subscription on the same endpoint because EventSource
 * splits handlers by event-name; the underlying browser HTTP/2 connection
 * is shared.
 */
export function useToolCallStream() {
  return useSSE<ToolCallEvent>('/api/status/stream', 'toolCall');
}
