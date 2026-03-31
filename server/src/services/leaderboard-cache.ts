/**
 * In-memory cache for the SpaceMolt game leaderboard.
 * TTL: 55 minutes. Stampede protection via in-flight promise reuse.
 */

const LEADERBOARD_URL = "https://game.spacemolt.com/api/leaderboard";
const TTL_MS = 55 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

export interface LeaderboardEntry {
  rank: number;
  username?: string;
  name?: string;
  tag?: string;
  empire?: string;
  value: number;
}

/** Each category maps stat keys to ranked entry arrays */
export type LeaderboardCategory = Record<string, LeaderboardEntry[]>;

export interface LeaderboardData {
  generated_at?: string;
  players?: LeaderboardCategory;
  factions?: LeaderboardCategory;
  exchanges?: LeaderboardCategory;
}

interface CacheEntry {
  data: LeaderboardData;
  fetchedAt: string;
}

let cache: CacheEntry | null = null;
let inFlight: Promise<CacheEntry> | null = null;

/** Fetch fresh data from upstream with 10s timeout. */
async function fetchFromUpstream(): Promise<CacheEntry> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const res = await fetch(LEADERBOARD_URL, { signal });
  if (!res.ok) {
    throw new Error(`Upstream returned ${res.status}`);
  }
  const raw = (await res.json()) as Record<string, unknown>;
  // Upstream uses "exchange" (singular) — normalize to "exchanges"
  const data: LeaderboardData = {
    generated_at: raw.generated_at as string | undefined,
    players: raw.players as LeaderboardCategory | undefined,
    factions: raw.factions as LeaderboardCategory | undefined,
    exchanges: (raw.exchanges ?? raw.exchange) as LeaderboardCategory | undefined,
  };
  return { data, fetchedAt: new Date().toISOString() };
}

/** Returns cached leaderboard data, fetching if stale or missing. Stampede-safe. */
export async function getLeaderboard(): Promise<CacheEntry & { fromCache: boolean }> {
  // Cache hit
  if (cache) {
    const age = Date.now() - new Date(cache.fetchedAt).getTime();
    if (age < TTL_MS) {
      return { ...cache, fromCache: true };
    }
  }

  // Dedup in-flight requests
  if (inFlight) {
    const entry = await inFlight;
    return { ...entry, fromCache: false };
  }

  inFlight = fetchFromUpstream();
  try {
    const entry = await inFlight;
    cache = entry;
    return { ...entry, fromCache: false };
  } finally {
    inFlight = null;
  }
}

/** Returns cache metadata without triggering a fetch. */
export function getCacheStatus(): {
  cached: boolean;
  fetchedAt: string | null;
  ageMs: number | null;
  ttlMs: number;
} {
  if (!cache) {
    return { cached: false, fetchedAt: null, ageMs: null, ttlMs: TTL_MS };
  }
  const ageMs = Date.now() - new Date(cache.fetchedAt).getTime();
  return { cached: true, fetchedAt: cache.fetchedAt, ageMs, ttlMs: TTL_MS };
}

/** Clears the cache (for testing). */
export function clearCacheForTesting(): void {
  cache = null;
  inFlight = null;
}
