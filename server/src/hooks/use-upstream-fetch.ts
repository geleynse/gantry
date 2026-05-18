"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, isApiError } from "@/lib/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UpstreamFetchState<T> {
  data: T | null;
  error: string | null;
  /** True when a retry timer is pending */
  retrying: boolean;
  /** 0–3: how many attempts have been made (0 = not yet fetched) */
  retryCount: number;
  loading: boolean;
  /** Manually trigger a fresh fetch and reset retry state */
  retry: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RETRY_DELAYS_MS = [5_000, 15_000, 30_000];
const MAX_RETRIES = RETRY_DELAYS_MS.length;

/**
 * Returns true when the error signals an upstream 429 / rate-limit condition
 * that came through as a 502 from the Gantry proxy.
 */
export function isRateLimitError(err: unknown): boolean {
  if (isApiError(err) && err.status === 502) {
    // Check both the raw body text and the error message for rate-limit signals
    const text = (err.body ?? err.message ?? "").toLowerCase();
    return /429|rate.?limit/.test(text);
  }
  return false;
}

/**
 * Returns a user-friendly error label (no raw JSON / stack traces).
 */
export function friendlyErrorMessage(
  err: unknown,
  retryCount: number,
  retrying: boolean
): string {
  if (isRateLimitError(err)) {
    if (retrying) return "Upstream rate limited — retrying…";
    if (retryCount >= MAX_RETRIES) return "Upstream rate limited — click Refresh to retry";
    return "Upstream rate limited";
  }
  if (isApiError(err)) {
    return `Upstream error (${err.status})`;
  }
  return err instanceof Error ? err.message : "Unknown error";
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Fetches `url` via `apiFetch`, with automatic backoff on 502/rate-limit
 * responses. Up to 3 retries at 5s, 15s, 30s. After that, the user must
 * click Refresh.
 *
 * Returns `{ data, error, retrying, retryCount, loading, retry }`.
 */
export function useUpstreamFetch<T>(url: string): UpstreamFetchState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [loading, setLoading] = useState(true);

  // Stable ref so the fetch closure always sees the current retryCount
  const retryCountRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Used to cancel in-flight fetches when the hook unmounts or retry() fires
  const abortRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const doFetch = useCallback(
    async (attempt: number) => {
      abortRef.current = false;
      setLoading(true);
      setRetrying(false);

      try {
        const result = await apiFetch<T>(url);
        if (abortRef.current) return;
        setData(result);
        setError(null);
        setRetryCount(0);
        retryCountRef.current = 0;
      } catch (err) {
        if (abortRef.current) return;
        setError(err);

        const shouldRetry = isRateLimitError(err) && attempt < MAX_RETRIES;
        if (shouldRetry) {
          const delay = RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS[MAX_RETRIES - 1];
          setRetrying(true);
          setRetryCount(attempt + 1);
          retryCountRef.current = attempt + 1;
          timerRef.current = setTimeout(() => {
            timerRef.current = null;
            doFetch(attempt + 1);
          }, delay);
        } else {
          setRetrying(false);
          setRetryCount(attempt);
          retryCountRef.current = attempt;
        }
      } finally {
        if (!abortRef.current) setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [url]
  );

  // Initial fetch on mount / url change
  useEffect(() => {
    retryCountRef.current = 0;
    setRetryCount(0);
    setRetrying(false);
    setError(null);
    setData(null);
    setLoading(true);
    clearTimer();
    doFetch(0);

    return () => {
      abortRef.current = true;
      clearTimer();
    };
  }, [doFetch, clearTimer]);

  const retry = useCallback(() => {
    abortRef.current = true;
    clearTimer();
    retryCountRef.current = 0;
    setRetryCount(0);
    setRetrying(false);
    setError(null);
    // Small tick so abortRef.current is read correctly before doFetch sets it false
    setTimeout(() => doFetch(0), 0);
  }, [doFetch, clearTimer]);

  const errorMessage =
    error !== null
      ? friendlyErrorMessage(error, retryCount, retrying)
      : null;

  return { data, error: errorMessage, retrying, retryCount, loading, retry };
}
