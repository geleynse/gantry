/**
 * Tests for the leaderboard API routes.
 * Uses node:http for test server calls to avoid global.fetch mock interference.
 *
 * GET /api/leaderboard         — proxies upstream, returns { data, fetchedAt, fromCache }
 * GET /api/leaderboard/status  — cache health, no fetch triggered
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, mock } from "bun:test";
import express from "express";
import { request as httpRequest } from "node:http";
import leaderboardRoutes from "./leaderboard.js";
import { clearCacheForTesting } from "../../services/leaderboard-cache.js";
import { startTestServer, canBindLocalhost } from "../../test/http-test-server.js";
import type { StartedTestServer } from "../../test/http-test-server.js";

const SAMPLE_DATA = {
  generated_at: "2026-03-20T00:00:00Z",
  players: {
    total_wealth: [{ rank: 1, username: "Drifter Gale", empire: "solarian", value: 1000000 }],
  },
  factions: {
    total_wealth: [{ rank: 1, name: "Rocinante", tag: "ROCI", value: 500000 }],
  },
  exchange: {
    items_listed: [{ rank: 1, username: "Drifter Gale", empire: "solarian", value: 100 }],
  },
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/leaderboard", leaderboardRoutes);
  return app;
}

/** HTTP GET using node:http (avoids global.fetch mock interference). */
function httpGet(baseUrl: string, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: parseInt(url.port),
        path: url.pathname + url.search,
        method: "GET",
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: data });
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

let testServer: StartedTestServer;
let canBind = false;

beforeAll(async () => {
  canBind = await canBindLocalhost();
  if (!canBind) return;
  testServer = await startTestServer(buildApp(), { host: "127.0.0.1" });
});

afterAll(async () => {
  await testServer?.close();
});

beforeEach(() => {
  clearCacheForTesting();
});

afterEach(() => {
  clearCacheForTesting();
});

describe("GET /api/leaderboard", () => {
  it("returns 200 with data, fetchedAt, fromCache on success", async () => {
    if (!canBind) return;

    global.fetch = mock(async () =>
      new Response(JSON.stringify(SAMPLE_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    ) as unknown as typeof global.fetch;

    const { status, body } = await httpGet(testServer.baseUrl, "/api/leaderboard");
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b).toHaveProperty("data");
    expect(b).toHaveProperty("fetchedAt");
    expect(b).toHaveProperty("fromCache");
    const d = b.data as Record<string, unknown>;
    expect(d.players).toBeDefined();
    // Verify exchange → exchanges normalization
    expect(d.exchanges).toBeDefined();
  });

  it("returns fromCache=false on first fetch", async () => {
    if (!canBind) return;

    global.fetch = mock(async () =>
      new Response(JSON.stringify(SAMPLE_DATA), { status: 200 })
    ) as unknown as typeof global.fetch;

    const { body } = await httpGet(testServer.baseUrl, "/api/leaderboard");
    const b = body as Record<string, unknown>;
    expect(b.fromCache).toBe(false);
  });

  it("returns fromCache=true on second call (cache hit)", async () => {
    if (!canBind) return;

    let callCount = 0;
    global.fetch = mock(async () => {
      callCount++;
      return new Response(JSON.stringify(SAMPLE_DATA), { status: 200 });
    }) as unknown as typeof global.fetch;

    await httpGet(testServer.baseUrl, "/api/leaderboard");
    const { body } = await httpGet(testServer.baseUrl, "/api/leaderboard");
    const b = body as Record<string, unknown>;
    expect(callCount).toBe(1);
    expect(b.fromCache).toBe(true);
  });

  it("returns 502 when upstream returns non-OK status", async () => {
    if (!canBind) return;

    global.fetch = mock(async () =>
      new Response("Bad Gateway", { status: 502 })
    ) as unknown as typeof global.fetch;

    const { status, body } = await httpGet(testServer.baseUrl, "/api/leaderboard");
    expect(status).toBe(502);
    const b = body as Record<string, unknown>;
    expect(typeof b.error).toBe("string");
    expect(b.error as string).toMatch(/502/);
  });

  it("returns 502 when upstream throws a network error", async () => {
    if (!canBind) return;

    global.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof global.fetch;

    const { status, body } = await httpGet(testServer.baseUrl, "/api/leaderboard");
    expect(status).toBe(502);
    const b = body as Record<string, unknown>;
    expect(b.error as string).toContain("ECONNREFUSED");
  });
});

describe("GET /api/leaderboard/status", () => {
  it("returns cache status without triggering an upstream fetch", async () => {
    if (!canBind) return;

    let fetchCount = 0;
    global.fetch = mock(async () => {
      fetchCount++;
      return new Response(JSON.stringify(SAMPLE_DATA), { status: 200 });
    }) as unknown as typeof global.fetch;

    const { status, body } = await httpGet(testServer.baseUrl, "/api/leaderboard/status");
    expect(status).toBe(200);
    expect(fetchCount).toBe(0);
    const b = body as Record<string, unknown>;
    expect(b).toHaveProperty("cached");
    expect(b).toHaveProperty("ttlMs");
    expect(b.cached).toBe(false);
    expect(b.fetchedAt).toBeNull();
  });

  it("returns cached=true after a leaderboard fetch", async () => {
    if (!canBind) return;

    global.fetch = mock(async () =>
      new Response(JSON.stringify(SAMPLE_DATA), { status: 200 })
    ) as unknown as typeof global.fetch;

    // Populate the cache
    await httpGet(testServer.baseUrl, "/api/leaderboard");

    const { body } = await httpGet(testServer.baseUrl, "/api/leaderboard/status");
    const b = body as Record<string, unknown>;
    expect(b.cached).toBe(true);
    expect(b.fetchedAt).toBeDefined();
    expect(typeof b.ageMs).toBe("number");
  });
});
