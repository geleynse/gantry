"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LeaderboardEntry {
  rank: number;
  username?: string;
  name?: string;
  tag?: string;
  empire?: string;
  value?: number;
  // Categories store the stat under its own key (e.g. total_wealth) in
  // addition to or instead of `value`. The table component reads
  // entry[statKey] dynamically.
  [statKey: string]: string | number | undefined;
}

/** Each category maps stat keys to ranked entry arrays */
export type LeaderboardCategory = Record<string, LeaderboardEntry[]>;

export interface LeaderboardData {
  generated_at?: string;
  players?: LeaderboardCategory;
  factions?: LeaderboardCategory;
  exchanges?: LeaderboardCategory;
}

export interface LeaderboardResponse {
  data: LeaderboardData;
  fetchedAt: string;
  fromCache: boolean;
}

export interface UseLeaderboardResult {
  data: LeaderboardData | null;
  fetchedAt: string | null;
  fromCache: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export type LeaderboardTimeRange = "today" | "week" | "all";

export function useLeaderboard(
  pollIntervalMs = POLL_INTERVAL_MS,
  timeRange: LeaderboardTimeRange = "all"
): UseLeaderboardResult {
  const [data, setData] = useState<LeaderboardData | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const params = timeRange !== "all" ? `?timeRange=${timeRange}` : "";
      const result = await apiFetch<LeaderboardResponse>(`/leaderboard${params}`);
      setData(result.data);
      setFetchedAt(result.fetchedAt);
      setFromCache(result.fromCache);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch leaderboard");
    } finally {
      setLoading(false);
    }
  }, [timeRange]);

  useEffect(() => {
    setLoading(true);
    fetchData();
    const id = setInterval(fetchData, pollIntervalMs);
    return () => clearInterval(id);
  }, [fetchData, pollIntervalMs, timeRange]);

  return { data, fetchedAt, fromCache, loading, error, refresh: fetchData };
}
