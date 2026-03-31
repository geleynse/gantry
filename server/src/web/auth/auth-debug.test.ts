/**
 * Tests for the auth debug endpoint and auth fallback behavior.
 */

import { describe, test, expect } from "bun:test";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import type { AuthAdapter, AuthResult } from "./types.js";
import { authMiddleware } from "./middleware.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeReq(overrides: Partial<Request> = {}): Request {
  const headers: Record<string, string> = {};
  const req = {
    method: "GET",
    path: "/api/status",
    ip: "1.2.3.4",
    headers,
    get(name: string) {
      return headers[name.toLowerCase()];
    },
    ...overrides,
  } as unknown as Request;
  return req;
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

// ---------------------------------------------------------------------------
// Auth fallback behavior: CF failure → viewer
// ---------------------------------------------------------------------------

describe("Auth fallback: CF failure → viewer", () => {
  function makeThrowingCfAdapter(): AuthAdapter {
    return {
      name: "cloudflare-access",
      async authenticate() {
        throw new Error("cert fetch failed: network unreachable");
      },
    };
  }

  test("adapter error on auth-optional route falls back to viewer", async () => {
    const adapter = makeThrowingCfAdapter();
    const mw = authMiddleware(adapter);
    const req = fakeReq({ path: "/api/auth/me" });
    const res = fakeRes();
    let called = false;

    await mw(req, res as unknown as Response, (() => { called = true; }) as NextFunction);

    expect(called).toBe(true);
    expect(req.auth?.role).toBe("viewer");
  });

  test("adapter returning null → viewer role on read-only route", async () => {
    const adapter: AuthAdapter = {
      name: "cloudflare-access",
      async authenticate() {
        return null; // JWT invalid but no throw
      },
    };
    const mw = authMiddleware(adapter);
    const req = fakeReq({ path: "/api/status" });
    const res = fakeRes();
    let called = false;

    await mw(req, res as unknown as Response, (() => { called = true; }) as NextFunction);

    expect(called).toBe(true);
    expect(req.auth?.role).toBe("viewer");
  });

  test("adapter error on non-optional route fails closed (503)", async () => {
    const adapter = makeThrowingCfAdapter();
    const mw = authMiddleware(adapter);
    const req = fakeReq({ path: "/api/status" });
    const res = fakeRes();
    let called = false;

    await mw(req, res as unknown as Response, (() => { called = true; }) as NextFunction);

    expect(called).toBe(false);
    expect(res._status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// Auth debug endpoint behavior
// ---------------------------------------------------------------------------

describe("GET /api/auth/debug", () => {
  function buildApp(authResult: AuthResult | null, adapterName = "layered") {
    const adapter: AuthAdapter = {
      name: adapterName,
      async authenticate() {
        return authResult;
      },
    };

    const app = express();
    app.use(express.json());
    app.use(authMiddleware(adapter));

    // Replicate what app.ts does for the debug endpoint
    app.get("/api/auth/debug", (req: Request, res: Response) => {
      if (req.auth?.role !== "admin") {
        res.status(403).json({ error: "Admin access required" });
        return;
      }
      const headers = req.headers;
      const cfJwt = headers["cf-access-jwt-assertion"] as string | undefined;
      res.json({
        adapter: adapter.name,
        auth_result: {
          role: req.auth?.role ?? "viewer",
          identity: req.auth?.identity ?? null,
        },
        cf_jwt: cfJwt ? "present" : "missing",
        host: req.get("host") ?? null,
        ip: req.ip,
      });
    });

    return app;
  }

  test("returns 403 for viewer (non-admin)", async () => {
    const app = buildApp(null); // null → viewer
    const supertest = (await import("supertest")).default;
    const res = await supertest(app).get("/api/auth/debug");
    expect(res.status).toBe(403);
    expect((res.body as Record<string, unknown>).error).toBe("Admin access required");
  });

  test("returns adapter info for admin", async () => {
    const app = buildApp({ role: "admin", identity: "test@example.com" }, "layered");
    const supertest = (await import("supertest")).default;
    const res = await supertest(app)
      .get("/api/auth/debug")
      .set("host", "admin.example.com");
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.adapter).toBe("layered");
    const authResult = body.auth_result as Record<string, unknown>;
    expect(authResult.role).toBe("admin");
    expect(authResult.identity).toBe("test@example.com");
  });

  test("reports CF JWT as missing when not in headers", async () => {
    const app = buildApp({ role: "admin", identity: "local" }, "loopback");
    const supertest = (await import("supertest")).default;
    const res = await supertest(app).get("/api/auth/debug");
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.cf_jwt).toBe("missing");
  });

  test("reports CF JWT as present when header included", async () => {
    const app = buildApp({ role: "admin", identity: "jwt@example.com" }, "cloudflare-access");
    const supertest = (await import("supertest")).default;
    const res = await supertest(app)
      .get("/api/auth/debug")
      .set("cf-access-jwt-assertion", "eyJhbGc.payload.sig");
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.cf_jwt).toBe("present");
  });
});
