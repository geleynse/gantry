/**
 * Tests for EmpireInfoCache.
 * Mocks global fetch; does not touch the DB (persistEmpireInfoCache is mocked).
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { EmpireInfoCache, type EmpireInfo, EMPIRE_INFO_TTL_MS } from "./empire-info-cache.js";

// Mock cache-persistence so tests don't need a real DB
mock.module("./cache-persistence.js", () => ({
  persistEmpireInfoCache: mock(() => undefined),
}));

const MOCK_EMPIRE_1: EmpireInfo = {
  id: "solarian",
  name: "Solarian Empire",
  tax_rate_income: 0.1,
  tax_rate_sales: 0.05,
  tax_collection_active: false,
  citizenship_open: false,
  citizenship_requirements: "500 rep",
  fuel_surcharge: 0.02,
  repair_cost_modifier: 1.0,
  customs_fine_rate: 0.1,
  bounty_multiplier: 1.0,
  starting_credits: 1000,
  contraband: ["stims"],
};

const MOCK_EMPIRE_2: EmpireInfo = {
  id: "voidborn",
  name: "Voidborn",
  tax_rate_income: 0.15,
  tax_rate_sales: 0.08,
  tax_collection_active: false,
  citizenship_open: true,
  citizenship_requirements: "none",
  fuel_surcharge: 0.0,
  repair_cost_modifier: 1.2,
  customs_fine_rate: 0.0,
  bounty_multiplier: 0.5,
  starting_credits: 500,
  contraband: [],
};

const MOCK_RESPONSE = { empires: [MOCK_EMPIRE_1, MOCK_EMPIRE_2] };

function makeFetchMock(responses: Array<{ status: number; body: unknown } | Error>) {
  let idx = 0;
  const origFetch = global.fetch;
  global.fetch = mock(async () => {
    const r = responses[idx++];
    if (!r) {
      // Default: successful response
      return new Response(JSON.stringify({ result: { content: [{ text: JSON.stringify(MOCK_RESPONSE) }] } }), { status: 200 });
    }
    if (r instanceof Error) throw r;
    const resp = r as { status: number; body: unknown };
    if (resp.body && typeof resp.body === "object" && "headers" in resp) {
      return resp.body as Response;
    }
    return new Response(JSON.stringify(resp.body), {
      status: resp.status,
      headers: resp.status < 400 && idx <= 2 ? { "mcp-session-id": `session-${idx}` } : {},
    });
  }) as unknown as typeof global.fetch;
  return origFetch;
}

// Build a proper 3-step MCP response sequence
function makeMcpFetchMock(): typeof global.fetch {
  const origFetch = global.fetch;
  let callIdx = 0;
  global.fetch = mock(async (_url: string, opts?: RequestInit) => {
    callIdx++;
    const body = opts?.body ? JSON.parse(opts.body as string) : {};
    if (body.method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: {}, capabilities: {} } }), {
        status: 200,
        headers: { "mcp-session-id": "test-session-id" },
      });
    }
    if (body.method === "notifications/initialized") {
      return new Response("", { status: 200 });
    }
    if (body.method === "tools/call") {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [{ text: JSON.stringify(MOCK_RESPONSE) }],
        },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "unexpected method" }), { status: 400 });
  }) as unknown as typeof global.fetch;
  return origFetch;
}

describe("EmpireInfoCache", () => {
  let origFetch: typeof global.fetch;

  beforeEach(() => {
    origFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = origFetch;
  });

  it("returns { data: null } before first fetch", () => {
    const cache = new EmpireInfoCache("https://game.spacemolt.com/mcp");
    const result = cache.get();
    expect(result.data).toBeNull();
    expect(result.stale).toBe(false);
    expect(result.age_seconds).toBe(-1);
  });

  it("hasData is false before first fetch", () => {
    const cache = new EmpireInfoCache("https://game.spacemolt.com/mcp");
    expect(cache.hasData).toBe(false);
  });

  it("restore() populates cache without a network fetch", () => {
    const cache = new EmpireInfoCache("https://game.spacemolt.com/mcp");
    const fetchedAt = Date.now() - 1000;
    cache.restore([MOCK_EMPIRE_1], fetchedAt);

    const result = cache.get();
    expect(result.data).toHaveLength(1);
    expect(result.data![0].id).toBe("solarian");
    expect(result.age_seconds).toBeGreaterThanOrEqual(1);
    expect(result.stale).toBe(false);
    expect(cache.hasData).toBe(true);
  });

  it("marks stale when fetchedAt is older than TTL", () => {
    const cache = new EmpireInfoCache("https://game.spacemolt.com/mcp");
    const oldFetchedAt = Date.now() - EMPIRE_INFO_TTL_MS - 5000;
    cache.restore([MOCK_EMPIRE_1], oldFetchedAt);

    const result = cache.get();
    expect(result.stale).toBe(true);
  });

  it("refresh() parses MCP response and populates cache", async () => {
    const savedFetch = makeMcpFetchMock();
    try {
      const cache = new EmpireInfoCache("https://game.spacemolt.com/mcp");
      const ok = await cache.refresh();
      expect(ok).toBe(true);
      const result = cache.get();
      expect(result.data).toHaveLength(2);
      expect(result.data![0].id).toBe("solarian");
      expect(result.data![1].id).toBe("voidborn");
      expect(result.stale).toBe(false);
    } finally {
      global.fetch = savedFetch;
    }
  });

  it("get() filters by empire_id", async () => {
    const savedFetch = makeMcpFetchMock();
    try {
      const cache = new EmpireInfoCache("https://game.spacemolt.com/mcp");
      await cache.refresh();

      const result = cache.get("solarian");
      expect(result.data).toHaveLength(1);
      expect(result.data![0].id).toBe("solarian");
    } finally {
      global.fetch = savedFetch;
    }
  });

  it("get() returns empty array for unknown empire_id", async () => {
    const savedFetch = makeMcpFetchMock();
    try {
      const cache = new EmpireInfoCache("https://game.spacemolt.com/mcp");
      await cache.refresh();

      const result = cache.get("nonexistent");
      expect(result.data).toHaveLength(0);
    } finally {
      global.fetch = savedFetch;
    }
  });

  it("refresh() returns false on network error, preserves existing data", async () => {
    const cache = new EmpireInfoCache("https://game.spacemolt.com/mcp");
    cache.restore([MOCK_EMPIRE_1], Date.now());

    const savedFetch = global.fetch;
    global.fetch = mock(async () => { throw new Error("network error"); }) as unknown as typeof global.fetch;
    try {
      const ok = await cache.refresh();
      expect(ok).toBe(false);
      // Existing data preserved
      const result = cache.get();
      expect(result.data).toHaveLength(1);
    } finally {
      global.fetch = savedFetch;
    }
  });

  it("refresh() returns false when init returns non-OK status", async () => {
    const cache = new EmpireInfoCache("https://game.spacemolt.com/mcp");
    const savedFetch = global.fetch;
    global.fetch = mock(async () => new Response("", { status: 503 })) as unknown as typeof global.fetch;
    try {
      const ok = await cache.refresh();
      expect(ok).toBe(false);
    } finally {
      global.fetch = savedFetch;
    }
  });

  it("setOnRefresh callback is called on successful refresh", async () => {
    const savedFetch = makeMcpFetchMock();
    try {
      const cache = new EmpireInfoCache("https://game.spacemolt.com/mcp");
      let callbackEmpires: EmpireInfo[] | null = null;
      cache.setOnRefresh((empires) => { callbackEmpires = empires; });

      await cache.refresh();
      expect(callbackEmpires).not.toBeNull();
      expect(callbackEmpires!.length).toBe(2);
    } finally {
      global.fetch = savedFetch;
    }
  });

  it("accepts raw array response in addition to { empires: [...] }", async () => {
    const savedFetch = global.fetch;
    let callIdx = 0;
    global.fetch = mock(async (_url: string, opts?: RequestInit) => {
      callIdx++;
      const body = opts?.body ? JSON.parse(opts.body as string) : {};
      if (body.method === "initialize") {
        return new Response("{}", {
          status: 200,
          headers: { "mcp-session-id": "test-sid" },
        });
      }
      if (body.method === "notifications/initialized") return new Response("", { status: 200 });
      if (body.method === "tools/call") {
        // Return raw array (not wrapped in { empires: [...] })
        return new Response(JSON.stringify({
          jsonrpc: "2.0", id: 2,
          result: { content: [{ text: JSON.stringify([MOCK_EMPIRE_1]) }] },
        }), { status: 200 });
      }
      return new Response("{}", { status: 400 });
    }) as unknown as typeof global.fetch;

    try {
      const cache = new EmpireInfoCache("https://game.spacemolt.com/mcp");
      const ok = await cache.refresh();
      expect(ok).toBe(true);
      expect(cache.get().data).toHaveLength(1);
    } finally {
      global.fetch = savedFetch;
    }
  });
});
