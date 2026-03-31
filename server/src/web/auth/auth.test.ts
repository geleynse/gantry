import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { Request, Response, NextFunction } from "express";
import { createTokenAdapter } from "./adapters/token.js";
import { createAuthAdapter } from "./index.js";
import {
  authMiddleware,
  isPublicRoute,
  isMcpRoute,
  isLocalhost,
  isAdminRoute,
} from "./middleware.js";

// ---------------------------------------------------------------------------
// Adapter tests
// ---------------------------------------------------------------------------

describe("TokenAdapter", () => {
  const adapter = createTokenAdapter({ token: "secret-123" });

  test("returns admin for valid bearer token", async () => {
    const req = { headers: { authorization: "Bearer secret-123" } } as Request;
    const result = await adapter.authenticate(req);
    expect(result).toEqual({ role: "admin", identity: "token" });
  });

  test("returns null for wrong token", async () => {
    const req = { headers: { authorization: "Bearer wrong" } } as Request;
    const result = await adapter.authenticate(req);
    expect(result).toBeNull();
  });

  test("returns null for missing header", async () => {
    const req = { headers: {} } as Request;
    const result = await adapter.authenticate(req);
    expect(result).toBeNull();
  });

  test("returns null for non-Bearer auth", async () => {
    const req = { headers: { authorization: "Basic abc" } } as Request;
    const result = await adapter.authenticate(req);
    expect(result).toBeNull();
  });

  test("throws on empty token config", () => {
    expect(() => createTokenAdapter({ token: "" })).toThrow("non-empty");
  });
});

describe("createAuthAdapter factory", () => {
  test("returns loopback adapter by default", async () => {
    const adapter = await createAuthAdapter();
    expect(adapter.name).toBe("loopback");
  });

  test("returns token adapter", async () => {
    const adapter = await createAuthAdapter({
      adapter: "token",
      config: { token: "abc" },
    });
    expect(adapter.name).toBe("token");
  });

  test("throws for invalid custom path", async () => {
    await expect(
      createAuthAdapter({ adapter: "./nonexistent-adapter.js" }),
    ).rejects.toThrow("Failed to load custom adapter");
  });
});

// ---------------------------------------------------------------------------
// Route classification tests
// ---------------------------------------------------------------------------

describe("Route classification", () => {
  function fakeReq(overrides: Partial<Request>): Request {
    return { method: "GET", path: "/", ip: "1.2.3.4", headers: {}, ...overrides } as Request;
  }

  describe("isPublicRoute", () => {
    test("/health is public", () => {
      expect(isPublicRoute(fakeReq({ path: "/health" }))).toBe(true);
    });
    test("/health/instability is public", () => {
      expect(isPublicRoute(fakeReq({ path: "/health/instability" }))).toBe(true);
    });
    test("/api/ping is public", () => {
      expect(isPublicRoute(fakeReq({ path: "/api/ping" }))).toBe(true);
    });
    test("/api/auth/me is NOT public (auth-optional)", () => {
      expect(isPublicRoute(fakeReq({ path: "/api/auth/me" }))).toBe(false);
    });
    test("/api/status is NOT public", () => {
      expect(isPublicRoute(fakeReq({ path: "/api/status" }))).toBe(false);
    });
  });

  describe("isMcpRoute", () => {
    test("/mcp is MCP", () => {
      expect(isMcpRoute(fakeReq({ path: "/mcp" }))).toBe(true);
    });
    test("/mcp/v2 is MCP", () => {
      expect(isMcpRoute(fakeReq({ path: "/mcp/v2" }))).toBe(true);
    });
    test("/sessions is MCP", () => {
      expect(isMcpRoute(fakeReq({ path: "/sessions" }))).toBe(true);
    });
    test("/sessions/abc is MCP", () => {
      expect(isMcpRoute(fakeReq({ path: "/sessions/abc" }))).toBe(true);
    });
    test("/api/status is NOT MCP", () => {
      expect(isMcpRoute(fakeReq({ path: "/api/status" }))).toBe(false);
    });
  });

  describe("isLocalhost", () => {
    test("127.0.0.1 is localhost", () => {
      expect(isLocalhost(fakeReq({ ip: "127.0.0.1" }))).toBe(true);
    });
    test("::1 is localhost", () => {
      expect(isLocalhost(fakeReq({ ip: "::1" }))).toBe(true);
    });
    test("::ffff:127.0.0.1 is localhost", () => {
      expect(isLocalhost(fakeReq({ ip: "::ffff:127.0.0.1" }))).toBe(true);
    });
    test("1.2.3.4 is NOT localhost", () => {
      expect(isLocalhost(fakeReq({ ip: "1.2.3.4" }))).toBe(false);
    });
    test("undefined ip is NOT localhost", () => {
      expect(isLocalhost(fakeReq({ ip: undefined }))).toBe(false);
    });
  });

  describe("isAdminRoute", () => {
    test("POST is admin", () => {
      expect(isAdminRoute(fakeReq({ method: "POST", path: "/api/agents/start-all" }))).toBe(true);
    });
    test("PUT is admin", () => {
      expect(isAdminRoute(fakeReq({ method: "PUT", path: "/api/notes/x/strategy" }))).toBe(true);
    });
    test("DELETE is admin", () => {
      expect(isAdminRoute(fakeReq({ method: "DELETE", path: "/api/caches/x" }))).toBe(true);
    });
    test("GET /api/status is NOT admin", () => {
      expect(isAdminRoute(fakeReq({ method: "GET", path: "/api/status" }))).toBe(false);
    });
    test("GET /mcp is admin (MCP route)", () => {
      expect(isAdminRoute(fakeReq({ method: "GET", path: "/mcp" }))).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Middleware integration tests
// ---------------------------------------------------------------------------

describe("authMiddleware", () => {
  function fakeReq(overrides: Partial<Request> = {}): Request {
    return {
      method: "GET",
      path: "/api/status",
      ip: "1.2.3.4",
      headers: {},
      get(name: string) {
        return (this.headers as any)[name.toLowerCase()];
      },
      ...overrides,
    } as Request;
  }

  function fakeRes(): Response & { _status: number; _json: unknown } {
    const res: { _status: number; _json: unknown; status: (c: number) => typeof res; json: (b: unknown) => typeof res } = {
      _status: 0,
      _json: null as unknown,
      status(code: number) {
        res._status = code;
        return res;
      },
      json(body: unknown) {
        res._json = body;
        return res;
      },
    };
    return res as unknown as Response & { _status: number; _json: unknown };
  }

  test("public routes pass without auth", async () => {
    const adapter = createTokenAdapter({ token: "secret" });
    const mw = authMiddleware(adapter);
    const req = fakeReq({ path: "/api/ping" });
    const res = fakeRes();
    let called = false;
    await mw(req, res as unknown as Response, (() => { called = true; }) as NextFunction);
    expect(called).toBe(true);
  });

  test("MCP from localhost passes", async () => {
    const adapter = createTokenAdapter({ token: "secret" });
    const mw = authMiddleware(adapter);
    const req = fakeReq({ method: "POST", path: "/mcp", ip: "127.0.0.1" });
    const res = fakeRes();
    let called = false;
    await mw(req, res as unknown as Response, (() => { called = true; }) as NextFunction);
    expect(called).toBe(true);
    expect(req.auth?.role).toBe("admin");
  });

  test("MCP from remote without auth returns 403", async () => {
    const adapter = createTokenAdapter({ token: "secret" });
    const mw = authMiddleware(adapter);
    const req = fakeReq({ method: "POST", path: "/mcp", ip: "10.0.0.5" });
    const res = fakeRes();
    let called = false;
    await mw(req, res as unknown as Response, (() => { called = true; }) as NextFunction);
    expect(called).toBe(false);
    expect(res._status).toBe(403);
  });

  test("GET API route passes for viewer", async () => {
    const adapter = createTokenAdapter({ token: "secret" });
    const mw = authMiddleware(adapter);
    const req = fakeReq({ method: "GET", path: "/api/status" });
    const res = fakeRes();
    let called = false;
    await mw(req, res as unknown as Response, (() => { called = true; }) as NextFunction);
    expect(called).toBe(true);
    expect(req.auth?.role).toBe("viewer");
  });

  test("POST API route blocked for viewer", async () => {
    const adapter = createTokenAdapter({ token: "secret" });
    const mw = authMiddleware(adapter);
    const req = fakeReq({ method: "POST", path: "/api/agents/start-all" });
    const res = fakeRes();
    let called = false;
    await mw(req, res as unknown as Response, (() => { called = true; }) as NextFunction);
    expect(called).toBe(false);
    expect(res._status).toBe(403);
  });

  test("POST API route passes for admin with token", async () => {
    const adapter = createTokenAdapter({ token: "secret" });
    const mw = authMiddleware(adapter);
    const req = fakeReq({
      method: "POST",
      path: "/api/agents/start-all",
      headers: { authorization: "Bearer secret" },
    });
    const res = fakeRes();
    let called = false;
    await mw(req, res as unknown as Response, (() => { called = true; }) as NextFunction);
    expect(called).toBe(true);
    expect(req.auth?.role).toBe("admin");
  });

  test("adapter error returns 503 (fail-closed)", async () => {
    const brokenAdapter = {
      name: "broken",
      async authenticate() {
        throw new Error("boom");
      },
    };
    const mw = authMiddleware(brokenAdapter);
    const req = fakeReq({ method: "GET", path: "/api/status" });
    const res = fakeRes();
    let called = false;
    await mw(req, res as unknown as Response, (() => { called = true; }) as NextFunction);
    expect(called).toBe(false);
    expect(res._status).toBe(503);
  });

  test("/api/auth/me authenticates but never blocks", async () => {
    const adapter = createTokenAdapter({ token: "secret" });
    const mw = authMiddleware(adapter);
    // Without token → viewer, still passes
    const req1 = fakeReq({ path: "/api/auth/me" });
    const res1 = fakeRes();
    let called1 = false;
    await mw(req1, res1 as unknown as Response, (() => { called1 = true; }) as NextFunction);
    expect(called1).toBe(true);
    expect(req1.auth?.role).toBe("viewer");

    // With token → admin, still passes
    const req2 = fakeReq({ path: "/api/auth/me", headers: { authorization: "Bearer secret" } });
    const res2 = fakeRes();
    let called2 = false;
    await mw(req2, res2 as unknown as Response, (() => { called2 = true; }) as NextFunction);
    expect(called2).toBe(true);
    expect(req2.auth?.role).toBe("admin");
  });
});
