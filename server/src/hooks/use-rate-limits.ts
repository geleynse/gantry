"use client";

import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "@/lib/api";

// ---------------------------------------------------------------------------
// Types (mirror rate-limit-tracker.ts)
// ---------------------------------------------------------------------------

export interface IpStats {
  agents: string[];
  rpm: number;
  history: number[]; // last 10 minutes, oldest first
}

export interface AgentStats {
  rpm: number;
  rate_limited: number;
  last_429: string | null;
}

export interface RateLimitEvent429 {
  agent: string;
  timestamp: string;
  tool: string;
}

export interface RateLimitsData {
  limit: number;
  window_seconds: number;
  by_ip: Record<string, IpStats>;
  by_agent: Record<string, AgentStats>;
  recent_429s: RateLimitEvent429[];
}

export interface UseRateLimitsResult {
  data: RateLimitsData | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 10_000;

export function useRateLimits(): UseRateLimitsResult {
  const [data, setData] = useState<RateLimitsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await apiFetch<RateLimitsData>("/rate-limits");
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load]);

  return { data, loading, error, refresh: load };
}
