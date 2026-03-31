import { describe, it, expect, mock, afterEach } from "bun:test";
import { MarketCache, abortSignalAny, type MarketData } from "./market-cache.js";

const MOCK_MARKET: MarketData = {
  categories: ["ore", "component", "refined"],
  empires: [
    { id: "solarian", name: "Solarian" },
    { id: "voidborn", name: "Voidborn" },
  ],
  items: [
    {
      item_id: "iron_ore",
      item_name: "Iron Ore",
      category: "ore",
      base_value: 10,
      empire: "solarian",
      best_bid: 15,
      best_ask: 8,
      bid_quantity: 500,
      ask_quantity: 200,
      spread: 7,
      spread_pct: 46.7,
    },
    {
      item_id: "copper_ore",
      item_name: "Copper Ore",
      category: "ore",
      base_value: 15,
      empire: "voidborn",
      best_bid: 20,
      best_ask: 12,
      bid_quantity: 300,
      ask_quantity: 100,
      spread: 8,
      spread_pct: 40,
    },
    {
      item_id: "armor_plate",
      item_name: "Armor Plate",
      category: "component",
      base_value: 250,
      empire: "solarian",
      best_bid: 500,
      best_ask: 400,
      bid_quantity: 100,
      ask_quantity: 50,
      spread: 100,
      spread_pct: 20,
    },
  ],
};

function mockFetch(responses: Array<{ body: unknown; status: number } | Error>) {
  let callIdx = 0;
  global.fetch = mock(async () => {
    const resp = responses[callIdx++];
    if (!resp) throw new Error("unexpected fetch call");
    if (resp instanceof Error) throw resp;
    return new Response(JSON.stringify(resp.body), { status: resp.status });
  }) as any;
}

describe("abortSignalAny", () => {
  it("returns an already-aborted signal when any input is already aborted", () => {
    const alreadyAborted = AbortSignal.abort();
    const fresh = new AbortController().signal;
    const combined = abortSignalAny([fresh, alreadyAborted]);
    expect(combined.aborted).toBe(true);
  });

  it("aborts when the first input signal fires", () => {
    const ctrl1 = new AbortController();
    const ctrl2 = new AbortController();
    const combined = abortSignalAny([ctrl1.signal, ctrl2.signal]);
    expect(combined.aborted).toBe(false);
    ctrl1.abort();
    expect(combined.aborted).toBe(true);
  });

  it("aborts when the second input signal fires", () => {
    const ctrl1 = new AbortController();
    const ctrl2 = new AbortController();
    const combined = abortSignalAny([ctrl1.signal, ctrl2.signal]);
    ctrl2.abort();
    expect(combined.aborted).toBe(true);
  });

  it("does not abort when no input signals fire", () => {
    const ctrl1 = new AbortController();
    const ctrl2 = new AbortController();
    const combined = abortSignalAny([ctrl1.signal, ctrl2.signal]);
    expect(combined.aborted).toBe(false);
  });

  it("works with a single signal", () => {
    const ctrl = new AbortController();
    const combined = abortSignalAny([ctrl.signal]);
    expect(combined.aborted).toBe(false);
    ctrl.abort();
    expect(combined.aborted).toBe(true);
  });

  it("works with an empty array", () => {
    const combined = abortSignalAny([]);
    expect(combined.aborted).toBe(false);
  });
});

describe("MarketCache", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns null when no data has been fetched", () => {
    const cache = new MarketCache("http://localhost/api/market", 60_000, [0]);
    const result = cache.get();
    expect(result.data).toBeNull();
    expect(result.age_seconds).toBe(-1);
  });

  it("fetches and caches market data", async () => {
    mockFetch([{ body: MOCK_MARKET, status: 200 }]);

    const cache = new MarketCache("http://localhost/api/market", 60_000, [0]);
    const ok = await cache.refresh();

    expect(ok).toBe(true);
    expect(cache.hasData).toBe(true);

    const result = cache.get();
    expect(result.data).not.toBeNull();
    expect(result.data!.items).toHaveLength(3);
    expect(result.stale).toBe(false);
    expect(result.age_seconds).toBeGreaterThanOrEqual(0);
  });

  it("returns cached data within TTL without re-fetching", async () => {
    mockFetch([{ body: MOCK_MARKET, status: 200 }]);

    const cache = new MarketCache("http://localhost/api/market", 60_000, [0]);
    await cache.refresh();

    const result = cache.get();
    expect(result.data!.items).toHaveLength(3);
    expect(result.stale).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("marks data as stale after TTL expires", async () => {
    mockFetch([{ body: MOCK_MARKET, status: 200 }]);

    const cache = new MarketCache("http://localhost/api/market", 1, [0]); // 1ms TTL
    await cache.refresh();

    await new Promise((r) => setTimeout(r, 10));

    const result = cache.get();
    expect(result.data).not.toBeNull();
    expect(result.stale).toBe(true);
  });

  it("returns stale data on fetch failure", async () => {
    mockFetch([
      { body: MOCK_MARKET, status: 200 },
      { body: "Server Error", status: 500 },
    ]);

    const cache = new MarketCache("http://localhost/api/market", 1, [0]);
    await cache.refresh();

    await new Promise((r) => setTimeout(r, 10));

    const ok = await cache.refresh();
    expect(ok).toBe(false);

    const result = cache.get();
    expect(result.data).not.toBeNull();
    expect(result.data!.items).toHaveLength(3);
  });

  it("returns stale data on network error", async () => {
    mockFetch([
      { body: MOCK_MARKET, status: 200 },
      new Error("network error"),
    ]);

    const cache = new MarketCache("http://localhost/api/market", 1, [0]);
    await cache.refresh();

    await new Promise((r) => setTimeout(r, 10));

    const ok = await cache.refresh();
    expect(ok).toBe(false);

    const result = cache.get();
    expect(result.data).not.toBeNull();
  });

  it("filters items by item_name (case-insensitive)", async () => {
    mockFetch([{ body: MOCK_MARKET, status: 200 }]);
    const cache = new MarketCache("http://localhost/api/market", 60_000, [0]);
    await cache.refresh();

    const result = cache.get("iron");
    expect(result.data!.items).toHaveLength(1);
    expect(result.data!.items[0].item_id).toBe("iron_ore");
  });

  it("filters items by item_id (case-insensitive)", async () => {
    mockFetch([{ body: MOCK_MARKET, status: 200 }]);
    const cache = new MarketCache("http://localhost/api/market", 60_000, [0]);
    await cache.refresh();

    const result = cache.get("armor");
    expect(result.data!.items).toHaveLength(1);
    expect(result.data!.items[0].item_name).toBe("Armor Plate");
  });

  it("returns empty items when filter matches nothing", async () => {
    mockFetch([{ body: MOCK_MARKET, status: 200 }]);
    const cache = new MarketCache("http://localhost/api/market", 60_000, [0]);
    await cache.refresh();

    const result = cache.get("nonexistent_item");
    expect(result.data!.items).toHaveLength(0);
    expect(result.data!.categories).toEqual(MOCK_MARKET.categories);
  });

  it("rejects invalid response shape", async () => {
    mockFetch([{ body: { foo: "bar" }, status: 200 }]);
    const cache = new MarketCache("http://localhost/api/market", 60_000, [0]);
    const ok = await cache.refresh();
    expect(ok).toBe(false);
    expect(cache.hasData).toBe(false);
  });

  it("records success on breaker after successful fetch", async () => {
    mockFetch([{ body: MOCK_MARKET, status: 200 }]);
    const cache = new MarketCache("http://localhost/api/market", 60_000, [0]);
    await cache.refresh();
    expect(cache.getBreaker().getState()).toBe("closed");
    expect(cache.getBreaker().getFailures()).toBe(0);
  });

  it("records failure on breaker after all retries exhausted", async () => {
    mockFetch([
      { body: "err", status: 500 },
    ]);
    const cache = new MarketCache("http://localhost/api/market", 60_000, [0]);
    await cache.refresh();
    expect(cache.getBreaker().getFailures()).toBe(1);
  });

  it("opens breaker after consecutive failures and skips fetch", async () => {
    const failures = Array.from({ length: 4 }, () => ({ body: "err", status: 500 }));
    mockFetch(failures);

    const cache = new MarketCache("http://localhost/api/market", 60_000, [0], {
      failureThreshold: 3,
      cooldownMs: 60_000,
    });

    // Exhaust retries 3 times to trip the breaker
    await cache.refresh(); // failure 1
    await cache.refresh(); // failure 2
    await cache.refresh(); // failure 3 — breaker opens

    expect(cache.getBreaker().getState()).toBe("open");

    // Next refresh should be short-circuited — no fetch call
    const fetchBefore = (global.fetch as any).mock.calls.length;
    const ok = await cache.refresh();
    expect(ok).toBe(false);
    expect((global.fetch as any).mock.calls.length).toBe(fetchBefore); // no new fetch
  });

  it("records failure on 429 rate limit", async () => {
    mockFetch([{ body: "", status: 429 }]);
    const cache = new MarketCache("http://localhost/api/market", 60_000, [0]);
    await cache.refresh();
    expect(cache.getBreaker().getFailures()).toBe(1);
  });

  it("resets breaker after successful fetch following failures", async () => {
    mockFetch([
      { body: "err", status: 500 },
      { body: MOCK_MARKET, status: 200 },
    ]);
    const cache = new MarketCache("http://localhost/api/market", 60_000, [0]);
    await cache.refresh(); // failure
    expect(cache.getBreaker().getFailures()).toBe(1);

    await cache.refresh(); // success
    expect(cache.getBreaker().getFailures()).toBe(0);
    expect(cache.getBreaker().getState()).toBe("closed");
  });
});
