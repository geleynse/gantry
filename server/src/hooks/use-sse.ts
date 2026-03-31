"use client";

import { useEffect, useRef, useState } from 'react';

const MIN_RETRY_MS = 1000;
const MAX_RETRY_MS = 30000;

export interface UseSSEResult<T> {
  data: T | null;
  connected: boolean;
  error: string | null;
}

export interface UseSSEOptions {
  minRetryMs?: number;
  maxRetryMs?: number;
}

/**
 * Generic SSE hook with auto-reconnect and exponential backoff.
 *
 * @param url       The SSE endpoint URL.
 * @param eventName Named event type to listen for. Defaults to "message".
 * @param options   Optional timing overrides (useful for testing).
 */
export function useSSE<T>(url: string, eventName?: string, options?: UseSSEOptions): UseSSEResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stable refs so the connect closure captures up-to-date values without
  // needing to re-register the effect when state changes.
  const retryCountRef = useRef(0);
  const closedRef = useRef(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    closedRef.current = false;
    retryCountRef.current = 0;

    function connect() {
      if (closedRef.current) return;

      const es = new EventSource(url);
      esRef.current = es;

      es.addEventListener('open', () => {
        retryCountRef.current = 0;
        setConnected(true);
        setError(null);
      });

      const targetEvent = eventName ?? 'message';
      es.addEventListener(targetEvent, (e: MessageEvent) => {
        try {
          const parsed = JSON.parse(e.data) as T;
          setData(parsed);
        } catch {
          // Non-JSON messages are silently ignored.
        }
      });

      es.onerror = () => {
        es.close();
        esRef.current = null;
        setConnected(false);

        if (closedRef.current) return;

        retryCountRef.current++;
        const minRetry = options?.minRetryMs ?? MIN_RETRY_MS;
        const maxRetry = options?.maxRetryMs ?? MAX_RETRY_MS;
        const delay = Math.min(
          minRetry * Math.pow(2, retryCountRef.current - 1),
          maxRetry,
        );
        setError(`Connection lost. Retrying in ${Math.round(delay / 1000)}s…`);
        retryTimerRef.current = setTimeout(connect, delay);
      };
    }

    connect();

    return () => {
      closedRef.current = true;
      esRef.current?.close();
      esRef.current = null;
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      setConnected(false);
    };
    // url and eventName are treated as stable after mount; if they change the
    // effect reruns because they are listed as dependencies.
  }, [url, eventName]);

  return { data, connected, error };
}
