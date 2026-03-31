"use client";

import { useSSE } from "./use-sse";

export interface ServerStatusData {
  status: "up" | "degraded" | "down";
  version: string | null;
  timestamp: string;
  latency_ms: number | null;
  circuit_breaker: {
    state: "closed" | "open" | "half-open";
    consecutive_failures: number;
    cooldown_remaining_ms?: number;
  };
  last_health_check: string | null;
  check_interval_seconds: number;
  notes: string;
}

/**
 * Subscribes to the game server status SSE stream.
 * Updates every 10s with UP / DEGRADED / DOWN status.
 */
export function useServerStatus() {
  return useSSE<ServerStatusData>("/api/server-status/stream", "server-status");
}
