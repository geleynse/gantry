"use client";

import { useEffect, useMemo, useState } from "react";
import { useUpstreamFetch } from "./use-upstream-fetch";

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
  /** True when a rate-limit retry is pending */
  retrying: boolean;
  refresh: () => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export type LeaderboardTimeRange = "today" | "week" | "all";

export function useLeaderboard(
  _pollIntervalMs = POLL_INTERVAL_MS,
  timeRange: LeaderboardTimeRange = "all"
): UseLeaderboardResult {
  const params = timeRange !== "all" ? `?timeRange=${timeRange}` : "";
  const url = `/leaderboard${params}`;

  const { data: raw, error, retrying, loading, retry } = useUpstreamFetch<LeaderboardResponse>(url);

  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);

  useEffect(() => {
    if (raw) {
      setFetchedAt(raw.fetchedAt);
      setFromCache(raw.fromCache);
    }
  }, [raw]);

  const data = useMemo(() => raw?.data ?? null, [raw]);

  return { data, fetchedAt, fromCache, loading, error, retrying, refresh: retry };
}
