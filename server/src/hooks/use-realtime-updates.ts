"use client";

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
  /** How long to wait for the WS to open before falling back to SSE (default: 3000) */
  wsOpenTimeoutMs?: number;
}

export interface UseRealtimeUpdatesResult<T> {
  data: T | null;
  connected: boolean;
  error: string | null;
  transport: RealtimeTransport;
}

const DEFAULT_MIN_RETRY = 1000;
const DEFAULT_MAX_RETRY = 30000;

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
    wsOpenTimeoutMs = 3000,
  } = options;

  const [data, setData] = useState<T | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transport, setTransport] = useState<RealtimeTransport>("none");

  const closedRef = useRef(false);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const esRef = useRef<EventSource | null>(null);

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

      // On timeout, only close the socket — the close event fires ws.onclose,
      // whose !wsConnected branch does the single connectSSE(). Calling
      // connectSSE() here too would open two EventSources and leak the first
      // (esRef only tracks the latest).
      const openTimeout = setTimeout(() => {
        if (!wsConnected) {
          ws.close();
        }
      }, wsOpenTimeoutMs);

      ws.onopen = () => {
        clearTimeout(openTimeout);
        wsConnected = true;
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
          connectSSE();
        } else {
          scheduleRetry(connectWS);
        }
      };

    } catch {
      connectSSE();
    }
  }, [wsPath, channel, wsOpenTimeoutMs, connectSSE, scheduleRetry]);

  useEffect(() => {
    closedRef.current = false;
    retryCountRef.current = 0;

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
