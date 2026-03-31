"use client";

/**
 * useRealtimeUpdates — transport-agnostic real-time subscription hook.
 *
 * Tries WebSocket first; falls back to SSE if WS is unavailable or fails.
 * Provides the same interface regardless of transport so callers don't care.
 *
 * Auto-reconnect with exponential backoff is handled internally.
 *
 * Usage:
 *   const { data, connected, error, transport } = useRealtimeUpdates<FleetStatus>({
 *     channel: "fleet-status",      // WS channel to subscribe to
 *     sseUrl: "/api/status/stream", // SSE URL fallback
 *     sseEvent: "status",           // SSE event name fallback
 *   });
 */

import { useEffect, useRef, useState, useCallback } from "react";

export type RealtimeTransport = "websocket" | "sse" | "none";

export interface UseRealtimeUpdatesOptions {
  /** WebSocket channel name (e.g. "fleet-status") */
  channel: string;
  /** SSE URL to fall back to (e.g. "/api/status/stream") */
  sseUrl: string;
  /** SSE event name to listen for (default: "message") */
  sseEvent?: string;
  /** WS endpoint path (default: "/ws") */
  wsPath?: string;
  /** Disable WS and force SSE (useful for testing) */
  forceSSE?: boolean;
  /** Min reconnect delay in ms (default: 1000) */
  minRetryMs?: number;
  /** Max reconnect delay in ms (default: 30000) */
  maxRetryMs?: number;
}

export interface UseRealtimeUpdatesResult<T> {
  data: T | null;
  connected: boolean;
  error: string | null;
  transport: RealtimeTransport;
}

const DEFAULT_MIN_RETRY = 1000;
const DEFAULT_MAX_RETRY = 30000;

/**
 * Build the WebSocket URL from the current page origin.
 * Converts http → ws, https → wss.
 */
function buildWsUrl(path: string): string {
  if (typeof window === "undefined") return "";
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${path}`;
}

export function useRealtimeUpdates<T>(
  options: UseRealtimeUpdatesOptions
): UseRealtimeUpdatesResult<T> {
  const {
    channel,
    sseUrl,
    sseEvent = "message",
    wsPath = "/ws",
    forceSSE = false,
    minRetryMs = DEFAULT_MIN_RETRY,
    maxRetryMs = DEFAULT_MAX_RETRY,
  } = options;

  const [data, setData] = useState<T | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transport, setTransport] = useState<RealtimeTransport>("none");

  // Stable refs
  const closedRef = useRef(false);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const wsFailed = useRef(false);

  const scheduleRetry = useCallback(
    (reconnectFn: () => void) => {
      retryCountRef.current++;
      const delay = Math.min(
        minRetryMs * Math.pow(2, retryCountRef.current - 1),
        maxRetryMs
      );
      setError(`Connection lost. Retrying in ${Math.round(delay / 1000)}s\u2026`);
      retryTimerRef.current = setTimeout(() => {
        if (!closedRef.current) reconnectFn();
      }, delay);
    },
    [minRetryMs, maxRetryMs]
  );

  const connectSSE = useCallback(() => {
    if (closedRef.current) return;

    const es = new EventSource(sseUrl);
    esRef.current = es;

    es.addEventListener("open", () => {
      retryCountRef.current = 0;
      setConnected(true);
      setError(null);
      setTransport("sse");
    });

    es.addEventListener(sseEvent, (e: MessageEvent) => {
      try {
        setData(JSON.parse(e.data) as T);
      } catch {
        // ignore non-JSON
      }
    });

    es.onerror = () => {
      es.close();
      esRef.current = null;
      setConnected(false);
      if (!closedRef.current) scheduleRetry(connectSSE);
    };
  }, [sseUrl, sseEvent, scheduleRetry]);

  const connectWS = useCallback(() => {
    if (closedRef.current) return;

    let wsConnected = false;

    try {
      const ws = new WebSocket(buildWsUrl(wsPath));
      wsRef.current = ws;

      const openTimeout = setTimeout(() => {
        if (!wsConnected) {
          // WS took too long — fall back to SSE
          ws.close();
          wsRef.current = null;
          wsFailed.current = true;
          connectSSE();
        }
      }, 3000);

      ws.onopen = () => {
        clearTimeout(openTimeout);
        wsConnected = true;
        wsFailed.current = false;
        retryCountRef.current = 0;
        setConnected(true);
        setError(null);
        setTransport("websocket");

        // Subscribe to the channel
        ws.send(JSON.stringify({ type: "subscribe", channel }));
      };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data as string) as {
            type: string;
            channel?: string;
            event?: string;
            data?: unknown;
          };
          if (msg.type === "event" && msg.channel === channel && msg.data !== undefined) {
            setData(msg.data as T);
          }
        } catch {
          // ignore malformed messages
        }
      };

      ws.onclose = () => {
        clearTimeout(openTimeout);
        wsRef.current = null;
        setConnected(false);

        if (closedRef.current) return;

        if (!wsConnected) {
          // Failed to connect — fall back to SSE permanently
          wsFailed.current = true;
          connectSSE();
        } else {
          // Was connected, now dropped — retry WS first, then SSE on repeated failures
          scheduleRetry(wsFailed.current ? connectSSE : connectWS);
        }
      };

      ws.onerror = () => {
        // onclose will follow — handled there
      };
    } catch {
      // WebSocket constructor threw (e.g. in test env) — fall back to SSE
      wsFailed.current = true;
      connectSSE();
    }
  }, [wsPath, channel, connectSSE, scheduleRetry]);

  useEffect(() => {
    closedRef.current = false;
    retryCountRef.current = 0;
    wsFailed.current = false;

    if (forceSSE || typeof WebSocket === "undefined") {
      connectSSE();
    } else {
      connectWS();
    }

    return () => {
      closedRef.current = true;

      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }

      wsRef.current?.close();
      wsRef.current = null;

      esRef.current?.close();
      esRef.current = null;

      setConnected(false);
      setTransport("none");
    };
  }, [channel, sseUrl, sseEvent, wsPath, forceSSE, connectSSE, connectWS]);

  return { data, connected, error, transport };
}
