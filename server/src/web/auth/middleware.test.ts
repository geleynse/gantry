/**
 * Security-focused tests for auth middleware.
 * Covers the access-control perimeter: viewer/admin roles, MCP bypass, error handling.
 */

import { describe, it, expect } from "bun:test";
import type { Request, Response, NextFunction } from "express";
import {
  authMiddleware,
  localhostOnlyMiddleware,
  isPublicRoute,
  isMcpRoute,
  isLocalhost,
  isAdminRoute,
} from "./middleware.js";
import { createTokenAdapter } from "./adapters/token.js";
import type { AuthAdapter, AuthResult } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<Request> = {}): Request {
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

function makeRes() {
  let statusCode = 0;
  let body: unknown = null;
  const res = {
    get _status() { return statusCode; },
    get _body() { return body; },
    status(code: number) { statusCode = code; return res; },
    json(b: unknown) { body = b; return res; },
  };
  return res as unknown as Response & { _status: number; _body: unknown };
}

function makeNext(): [NextFunction, () => boolean] {
  let called = false;
  const fn: NextFunction = () => { called = true; };
  return [fn, () => called];
}

function viewerAdapter(): AuthAdapter {
  return {
    name: "viewer-only",
    async authenticate() { return { role: "viewer" }; },
  };
}

function adminAdapter(): AuthAdapter {
  return {
    name: "admin-always",
    async authenticate() { return { role: "admin", identity: "test" }; },
  };
}

function throwingAdapter(): AuthAdapter {
  return {
    name: "broken",
    async authenticate(): Promise<AuthResult> { throw new Error("adapter exploded"); },
  };
}

function nullAdapter(): AuthAdapter {
  return {
    name: "null-returns",
    async authenticate() { return null; },
  };
}

// ---------------------------------------------------------------------------
// Route classification helpers
// ---------------------------------------------------------------------------

describe("isPublicRoute", () => {
  it("recognises /health", () => {
    expect(isPublicRoute(makeReq({ path: "/health" }))).toBe(true);
  });
  it("recognises /health/instability", () => {
    expect(isPublicRoute(makeReq({ path: "/health/instability" }))).toBe(true);
  });
  it("recognises /api/ping", () => {
    expect(isPublicRoute(makeReq({ path: "/api/ping" }))).toBe(true);
  });
  it("does NOT treat /api/status as public", () => {
    expect(isPublicRoute(makeReq({ path: "/api/status" }))).toBe(false);
  });
  it("does NOT treat /api/auth/me as public (it is auth-optional, not public)", () => {
    expect(isPublicRoute(makeReq({ path: "/api/auth/me" }))).toBe(false);
  });
  it("does NOT treat /mcp as public", () => {
    expect(isPublicRoute(makeReq({ path: "/mcp" }))).toBe(false);
  });
});

describe("isMcpRoute", () => {
  it("matches /mcp exactly", () => {
    expect(isMcpRoute(makeReq({ path: "/mcp" }))).toBe(true);
  });
  it("matches /mcp/v2 (child path)", () => {
    expect(isMcpRoute(makeReq({ path: "/mcp/v2" }))).toBe(true);
  });
  it("matches /sessions exactly", () => {
    expect(isMcpRoute(makeReq({ path: "/sessions" }))).toBe(true);
  });
  it("matches /sessions/<id>", () => {
    expect(isMcpRoute(makeReq({ path: "/sessions/abc-123" }))).toBe(true);
  });
  it("does NOT match /mcpx (prefix collision guard)", () => {
    expect(isMcpRoute(makeReq({ path: "/mcpx" }))).toBe(false);
  });
  it("does NOT match /sessionstore", () => {
    expect(isMcpRoute(makeReq({ path: "/sessionstore" }))).toBe(false);
  });
  it("does NOT match /api/status", () => {
    expect(isMcpRoute(makeReq({ path: "/api/status" }))).toBe(false);
  });
});

describe("isLocalhost", () => {
  it("accepts 127.0.0.1", () => {
    expect(isLocalhost(makeReq({ ip: "127.0.0.1" }))).toBe(true);
  });
  it("accepts ::1 (IPv6 loopback)", () => {
    expect(isLocalhost(makeReq({ ip: "::1" }))).toBe(true);
  });
  it("accepts ::ffff:127.0.0.1 (IPv4-mapped)", () => {
    expect(isLocalhost(makeReq({ ip: "::ffff:127.0.0.1" }))).toBe(true);
  });
  it("rejects external IP", () => {
    expect(isLocalhost(makeReq({ ip: "10.0.0.5" }))).toBe(false);
  });
  it("rejects undefined ip", () => {
    expect(isLocalhost(makeReq({ ip: undefined }))).toBe(false);
  });
});

describe("isAdminRoute", () => {
  it("POST is admin regardless of path", () => {
    expect(isAdminRoute(makeReq({ method: "POST", path: "/api/status" }))).toBe(true);
  });
  it("PUT is admin", () => {
    expect(isAdminRoute(makeReq({ method: "PUT", path: "/api/notes/x" }))).toBe(true);
  });
  it("DELETE is admin", () => {
    expect(isAdminRoute(makeReq({ method: "DELETE", path: "/api/agents/x" }))).toBe(true);
  });
  it("PATCH is admin", () => {
    expect(isAdminRoute(makeReq({ method: "PATCH", path: "/api/config" }))).toBe(true);
  });
  it("GET /api/status is NOT admin", () => {
    expect(isAdminRoute(makeReq({ method: "GET", path: "/api/status" }))).toBe(false);
  });
  it("GET /mcp IS admin (MCP routes are always admin)", () => {
    expect(isAdminRoute(makeReq({ method: "GET", path: "/mcp" }))).toBe(true);
  });
  it("GET /sessions IS admin", () => {
    expect(isAdminRoute(makeReq({ method: "GET", path: "/sessions" }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Middleware integration — role assignment
// ---------------------------------------------------------------------------

describe("authMiddleware — viewer access (unauthenticated GET)", () => {
  it("sets req.auth.role = viewer on unauthenticated GET", async () => {
    const mw = authMiddleware(nullAdapter());
    const req = makeReq({ method: "GET", path: "/api/status" });
    const res = makeRes();
    const [next, wasCalled] = makeNext();
    await mw(req, res, next);
    expect(wasCalled()).toBe(true);
    expect(req.auth?.role).toBe("viewer");
  });

  it("viewer can access GET /api/status", async () => {
    const mw = authMiddleware(viewerAdapter());
    const req = makeReq({ method: "GET", path: "/api/status" });
    const res = makeRes();
    const [next, wasCalled] = makeNext();
    await mw(req, res, next);
    expect(wasCalled()).toBe(true);
    expect(req.auth?.role).toBe("viewer");
  });

  it("viewer can access GET /api/agents", async () => {
    const mw = authMiddleware(viewerAdapter());
    const req = makeReq({ method: "GET", path: "/api/agents" });
    const res = makeRes();
    const [next, wasCalled] = makeNext();
    await mw(req, res, next);
    expect(wasCalled()).toBe(true);
  });
});

describe("authMiddleware — admin access (authenticated requests)", () => {
  it("admin can POST to admin routes", async () => {
    const mw = authMiddleware(adminAdapter());
    const req = makeReq({ method: "POST", path: "/api/agents/start-all" });
    const res = makeRes();
    const [next, wasCalled] = makeNext();
    await mw(req, res, next);
    expect(wasCalled()).toBe(true);
    expect(req.auth?.role).toBe("admin");
  });

  it("admin identity is preserved on req.auth", async () => {
    const mw = authMiddleware(adminAdapter());
    const req = makeReq({ method: "GET", path: "/api/status" });
    const res = makeRes();
    const [next] = makeNext();
    await mw(req, res, next);
    expect(req.auth?.role).toBe("admin");
    expect(req.auth?.identity).toBe("test");
  });

  it("token adapter: correct token grants admin on POST", async () => {
    const adapter = createTokenAdapter({ token: "super-secret" });
    const mw = authMiddleware(adapter);
    const req = makeReq({
      method: "POST",
      path: "/api/agents/start-all",
      headers: { authorization: "Bearer super-secret" },
    });
    const res = makeRes();
    const [next, wasCalled] = makeNext();
    await mw(req, res, next);
    expect(wasCalled()).toBe(true);
    expect(req.auth?.role).toBe("admin");
  });
});

describe("authMiddleware — admin blocked (unauthenticated admin routes)", () => {
  it("unauthenticated POST is rejected with 403", async () => {
    const mw = authMiddleware(nullAdapter());
    const req = makeReq({ method: "POST", path: "/api/agents/start-all" });
    const res = makeRes();
    const [next, wasCalled] = makeNext();
    await mw(req, res, next);
    expect(wasCalled()).toBe(false);
    expect(res._status).toBe(403);
  });

  it("unauthenticated DELETE is rejected with 403", async () => {
    const mw = authMiddleware(nullAdapter());
    const req = makeReq({ method: "DELETE", path: "/api/agents/x" });
    const res = makeRes();
    const [next, wasCalled] = makeNext();
    await mw(req, res, next);
    expect(wasCalled()).toBe(false);
    expect(res._status).toBe(403);
  });

  it("viewer POST is rejected with 403", async () => {
    const mw = authMiddleware(viewerAdapter());
    const req = makeReq({ method: "POST", path: "/api/agents/start-all" });
    const res = makeRes();
    const [next, wasCalled] = makeNext();
    await mw(req, res, next);
    expect(wasCalled()).toBe(false);
    expect(res._status).toBe(403);
  });

  it("wrong token viewer is rejected on POST", async () => {
    const adapter = createTokenAdapter({ token: "real-secret" });
    const mw = authMiddleware(adapter);
    const req = makeReq({
      method: "POST",
      path: "/api/agents/start-all",
      headers: { authorization: "Bearer wrong-token" },
    });
    const res = makeRes();
    const [next, wasCalled] = makeNext();
    await mw(req, res, next);
    expect(wasCalled()).toBe(false);
    expect(res._status).toBe(403);
  });

  it("response body identifies admin requirement", async () => {
    const mw = authMiddleware(nullAdapter());
    const req = makeReq({ method: "POST", path: "/api/agents/start-all" });
    const res = makeRes();
    const [next] = makeNext();
    await mw(req, res, next);
    expect((res._body as { error: string }).error).toMatch(/admin/i);
  });
});

describe("authMiddleware — MCP localhost bypass", () => {
  it("GET /mcp from 127.0.0.1 is granted admin without auth", async () => {
    const adapter = createTokenAdapter({ token: "secret" });
    const mw = authMiddleware(adapter);
    const req = makeReq({ method: "GET", path: "/mcp", ip: "127.0.0.1" });
    const res = makeRes();
    const [next, wasCalled] = makeNext();
    await mw(req, res, next);
    expect(wasCalled()).toBe(true);
    expect(req.auth?.role).toBe("admin");
    expect(req.auth?.identity).toBe("localhost");
  });

  it("POST /mcp from 127.0.0.1 bypasses token check", async () => {
    const adapter = createTokenAdapter({ token: "secret" });
    const mw = authMiddleware(adapter);
    const req = makeReq({ method: "POST", path: "/mcp", ip: "127.0.0.1" });
    const res = makeRes();
    const [next, wasCalled] = makeNext();
    await mw(req, res, next);
    expect(wasCalled()).toBe(true);
    expect(req.auth?.role).toBe("admin");
  });

  it("GET /sessions from ::1 (IPv6 loopback) gets bypass", async () => {
    const adapter = createTokenAdapter({ token: "secret" });
    const mw = authMiddleware(adapter);
    const req = makeReq({ method: "GET", path: "/sessions/xyz", ip: "::1" });
    const res = makeRes();
    const [next, wasCalled] = makeNext();
    await mw(req, res, next);
    expect(wasCalled()).toBe(true);
    expect(req.auth?.role).toBe("admin");
  });

  it("GET /mcp from remote IP is rejected (no bypass)", async () => {
    const adapter = createTokenAdapter({ token: "secret" });
    const mw = authMiddleware(adapter);
    const req = makeReq({ method: "GET", path: "/mcp", ip: "10.0.0.5" });
    const res = makeRes();
    const [next, wasCalled] = makeNext();
    await mw(req, res, next);
    // MCP is admin-only; viewer from remote gets 403
    expect(wasCalled()).toBe(false);
    expect(res._status).toBe(403);
  });
});

describe("authMiddleware — adapter error handling", () => {
  it("adapter throw returns 503 (fail-closed)", async () => {
    const mw = authMiddleware(throwingAdapter());
    const req = makeReq({ method: "GET", path: "/api/status" });
    const res = makeRes();
    const [next, wasCalled] = makeNext();
    await mw(req, res, next);
    expect(wasCalled()).toBe(false);
    expect(res._status).toBe(503);
  });

  it("adapter error on admin route returns 503 (not 403 or fallback)", async () => {
    const mw = authMiddleware(throwingAdapter());
    const req = makeReq({ method: "POST", path: "/api/agents/start-all" });
    const res = makeRes();
    const [next, wasCalled] = makeNext();
    await mw(req, res, next);
    expect(wasCalled()).toBe(false);
    expect(res._status).toBe(503);
  });

  it("adapter returning null defaults to viewer", async () => {
    const mw = authMiddleware(nullAdapter());
    const req = makeReq({ method: "GET", path: "/api/status" });
    const res = makeRes();
    const [next, wasCalled] = makeNext();
    await mw(req, res, next);
    expect(wasCalled()).toBe(true);
    expect(req.auth?.role).toBe("viewer");
  });
});

describe("authMiddleware — public routes bypass auth entirely", () => {
  it("/health passes without any authentication", async () => {
    const mw = authMiddleware(throwingAdapter()); // even broken adapter is fine
    const req = makeReq({ path: "/health" });
    const res = makeRes();
    const [next, wasCalled] = makeNext();
    await mw(req, res, next);
    expect(wasCalled()).toBe(true);
    expect(req.auth).toBeUndefined();
  });

  it("/api/ping passes without authentication", async () => {
    const mw = authMiddleware(throwingAdapter());
    const req = makeReq({ path: "/api/ping" });
    const res = makeRes();
    const [next, wasCalled] = makeNext();
    await mw(req, res, next);
    expect(wasCalled()).toBe(true);
  });
});

describe("authMiddleware — auth-optional route (/api/auth/me)", () => {
  it("viewer can access /api/auth/me", async () => {
    const mw = authMiddleware(nullAdapter());
    const req = makeReq({ path: "/api/auth/me" });
    const res = makeRes();
    const [next, wasCalled] = makeNext();
    await mw(req, res, next);
    expect(wasCalled()).toBe(true);
    expect(req.auth?.role).toBe("viewer");
  });

  it("admin gets admin role on /api/auth/me", async () => {
    const adapter = createTokenAdapter({ token: "secret" });
    const mw = authMiddleware(adapter);
    const req = makeReq({
      path: "/api/auth/me",
      headers: { authorization: "Bearer secret" },
    });
    const res = makeRes();
    const [next, wasCalled] = makeNext();
    await mw(req, res, next);
    expect(wasCalled()).toBe(true);
    expect(req.auth?.role).toBe("admin");
  });
});

// ---------------------------------------------------------------------------
// localhostOnlyMiddleware
// ---------------------------------------------------------------------------

describe("localhostOnlyMiddleware", () => {
  it("allows 127.0.0.1", () => {
    const req = makeReq({ ip: "127.0.0.1" });
    const res = makeRes();
    const [next, wasCalled] = makeNext();
    localhostOnlyMiddleware(req, res, next);
    expect(wasCalled()).toBe(true);
  });

  it("allows ::1", () => {
    const req = makeReq({ ip: "::1" });
    const res = makeRes();
    const [next, wasCalled] = makeNext();
    localhostOnlyMiddleware(req, res, next);
    expect(wasCalled()).toBe(true);
  });

  it("blocks external IP with 403", () => {
    const req = makeReq({ ip: "192.168.1.100" });
    const res = makeRes();
    const [next, wasCalled] = makeNext();
    localhostOnlyMiddleware(req, res, next);
    expect(wasCalled()).toBe(false);
    expect(res._status).toBe(403);
  });

  it("block response identifies localhost requirement", () => {
    const req = makeReq({ ip: "8.8.8.8" });
    const res = makeRes();
    const [next] = makeNext();
    localhostOnlyMiddleware(req, res, next);
    expect((res._body as { error: string }).error).toMatch(/localhost/i);
  });
});
