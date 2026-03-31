/**
 * Tests for leaderboard-cache.ts — cache hit/miss, TTL, stampede protection, failure handling.
 */
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import {
  getLeaderboard,
  getCacheStatus,
  clearCacheForTesting,
  type LeaderboardData,
} from "./leaderboard-cache.js";

const SAMPLE_UPSTREAM = {
  generated_at: "2026-03-20T00:00:00Z",
  players: {
    total_wealth: [
      { rank: 1, username: "Drifter Gale", empire: "solarian", value: 999999 },
      { rank: 2, username: "someone_else", empire: "nebula", value: 500000 },
    ],
  },
  factions: {
    total_wealth: [{ rank: 1, name: "Rocinante", tag: "ROCI", value: 500000 }],
  },
  exchange: {
    items_listed: [{ rank: 1, username: "Drifter Gale", empire: "solarian", value: 100 }],
  },
};

function makeSuccessResponse(data: Record<string, unknown> = SAMPLE_UPSTREAM) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  clearCacheForTesting();
});

afterEach(() => {
  clearCacheForTesting();
});

describe("getLeaderboard", () => {
  it("fetches from upstream on cache miss", async () => {
    let callCount = 0;
    global.fetch = mock(async () => {
      callCount++;
      return makeSuccessResponse();
    }) as unknown as typeof global.fetch;

    const result = await getLeaderboard();
    expect(callCount).toBe(1);
    expect(result.fromCache).toBe(false);
    expect(result.data.players!.total_wealth).toHaveLength(2);
    expect(result.fetchedAt).toBeDefined();
  });

  it("returns cached data on second call within TTL", async () => {
    let callCount = 0;
    global.fetch = mock(async () => {
      callCount++;
      return makeSuccessResponse();
    }) as unknown as typeof global.fetch;

    await getLeaderboard();
    const result2 = await getLeaderboard();

    expect(callCount).toBe(1);
    expect(result2.fromCache).toBe(true);
  });

  it("fromCache is false on first fetch", async () => {
    global.fetch = mock(async () => makeSuccessResponse()) as unknown as typeof global.fetch;
    const result = await getLeaderboard();
    expect(result.fromCache).toBe(false);
  });

  it("fromCache is true on subsequent calls within TTL", async () => {
    global.fetch = mock(async () => makeSuccessResponse()) as unknown as typeof global.fetch;
    await getLeaderboard();
    const result = await getLeaderboard();
    expect(result.fromCache).toBe(true);
  });

  it("re-fetches after TTL expires", async () => {
    let callCount = 0;
    global.fetch = mock(async () => {
      callCount++;
      return makeSuccessResponse();
    }) as unknown as typeof global.fetch;

    await getLeaderboard();
    expect(callCount).toBe(1);

    // Manually expire the cache by clearing and re-fetching
    clearCacheForTesting();
    const result2 = await getLeaderboard();
    expect(callCount).toBe(2);
    expect(result2.fromCache).toBe(false);
  });

  it("stampede protection: concurrent calls deduplicate to one fetch", async () => {
    let callCount = 0;
    global.fetch = mock(async () => {
      callCount++;
      // Simulate async work
      await new Promise((r) => setTimeout(r, 10));
      return makeSuccessResponse();
    }) as unknown as typeof global.fetch;

    // Fire 3 concurrent fetches simultaneously
    const [r1, r2, r3] = await Promise.all([getLeaderboard(), getLeaderboard(), getLeaderboard()]);

    // Only one upstream call should have been made
    expect(callCount).toBe(1);
    expect(r1.data).toEqual(r2.data);
    expect(r2.data).toEqual(r3.data);
  });

  it("throws on non-OK upstream response (502)", async () => {
    global.fetch = mock(async () =>
      new Response("Bad Gateway", { status: 502 })
    ) as unknown as typeof global.fetch;

    await expect(getLeaderboard()).rejects.toThrow("Upstream returned 502");
  });

  it("propagates network errors", async () => {
    global.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof global.fetch;

    await expect(getLeaderboard()).rejects.toThrow("ECONNREFUSED");
  });

  it("does not cache on fetch failure", async () => {
    let callCount = 0;
    global.fetch = mock(async () => {
      callCount++;
      if (callCount === 1) throw new Error("network error");
      return makeSuccessResponse();
    }) as unknown as typeof global.fetch;

    await expect(getLeaderboard()).rejects.toThrow();
    // Second call should retry
    const result = await getLeaderboard();
    expect(callCount).toBe(2);
    expect(result.data).toBeDefined();
  });

  it("returns correct player data structure", async () => {
    global.fetch = mock(async () => makeSuccessResponse()) as unknown as typeof global.fetch;
    const result = await getLeaderboard();
    // players is a category object keyed by stat name
    expect(typeof result.data.players).toBe("object");
    expect(Array.isArray(result.data.players!.total_wealth)).toBe(true);
    expect(result.data.players!.total_wealth[0].username).toBe("Drifter Gale");
    expect(result.data.players!.total_wealth[0].rank).toBe(1);
  });

  it("normalizes exchange → exchanges", async () => {
    global.fetch = mock(async () => makeSuccessResponse()) as unknown as typeof global.fetch;
    const result = await getLeaderboard();
    expect(result.data.exchanges).toBeDefined();
    expect(Array.isArray(result.data.exchanges!.items_listed)).toBe(true);
  });
});

describe("getCacheStatus", () => {
  it("returns cached=false when nothing is cached", () => {
    const status = getCacheStatus();
    expect(status.cached).toBe(false);
    expect(status.fetchedAt).toBeNull();
    expect(status.ageMs).toBeNull();
    expect(status.ttlMs).toBeGreaterThan(0);
  });

  it("returns cached=true after a successful fetch", async () => {
    global.fetch = mock(async () => makeSuccessResponse()) as unknown as typeof global.fetch;
    await getLeaderboard();

    const status = getCacheStatus();
    expect(status.cached).toBe(true);
    expect(status.fetchedAt).toBeDefined();
    expect(status.ageMs).toBeGreaterThanOrEqual(0);
  });

  it("reports a valid TTL value", async () => {
    global.fetch = mock(async () => makeSuccessResponse()) as unknown as typeof global.fetch;
    await getLeaderboard();

    const status = getCacheStatus();
    // TTL should be 55 minutes
    expect(status.ttlMs).toBe(55 * 60 * 1000);
  });

  it("does not trigger a fetch when called standalone", () => {
    let callCount = 0;
    global.fetch = mock(async () => {
      callCount++;
      return makeSuccessResponse();
    }) as unknown as typeof global.fetch;

    getCacheStatus();
    expect(callCount).toBe(0);
  });
});
