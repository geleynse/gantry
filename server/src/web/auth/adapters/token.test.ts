/**
 * Security-focused tests for the Bearer token auth adapter.
 */

import { describe, it, expect } from "bun:test";
import type { Request } from "express";
import { createTokenAdapter } from "./token.js";

function makeReq(authorization?: string): Request {
  return {
    headers: authorization ? { authorization } : {},
  } as unknown as Request;
}

const CONFIGURED_TOKEN = "my-super-secret-token";

describe("createTokenAdapter — configuration", () => {
  it("throws when token is an empty string", () => {
    expect(() => createTokenAdapter({ token: "" })).toThrow();
  });

  it("throw message mentions non-empty requirement", () => {
    expect(() => createTokenAdapter({ token: "" })).toThrow(/non-empty/i);
  });

  it("creates adapter with name 'token'", () => {
    const adapter = createTokenAdapter({ token: CONFIGURED_TOKEN });
    expect(adapter.name).toBe("token");
  });

  it("does not throw for a non-empty token", () => {
    expect(() => createTokenAdapter({ token: "x" })).not.toThrow();
  });
});

describe("createTokenAdapter — correct token → admin", () => {
  const adapter = createTokenAdapter({ token: CONFIGURED_TOKEN });

  it("returns admin role for exact matching token", async () => {
    const result = await adapter.authenticate(makeReq(`Bearer ${CONFIGURED_TOKEN}`));
    expect(result?.role).toBe("admin");
  });

  it("sets identity to 'token'", async () => {
    const result = await adapter.authenticate(makeReq(`Bearer ${CONFIGURED_TOKEN}`));
    expect(result?.identity).toBe("token");
  });
});

describe("createTokenAdapter — wrong token → viewer (null)", () => {
  const adapter = createTokenAdapter({ token: CONFIGURED_TOKEN });

  it("returns null for a wrong token", async () => {
    const result = await adapter.authenticate(makeReq("Bearer wrong-token"));
    expect(result).toBeNull();
  });

  it("returns null for a partial token match (prefix)", async () => {
    const result = await adapter.authenticate(makeReq(`Bearer ${CONFIGURED_TOKEN.slice(0, 5)}`));
    expect(result).toBeNull();
  });

  it("returns null for a token with trailing whitespace", async () => {
    const result = await adapter.authenticate(makeReq(`Bearer ${CONFIGURED_TOKEN} `));
    expect(result).toBeNull();
  });

  it("returns null for empty-string token after Bearer (Bearer ⎵)", async () => {
    // header.slice(7) → "" which !== CONFIGURED_TOKEN → null
    const result = await adapter.authenticate(makeReq("Bearer "));
    expect(result).toBeNull();
  });
});

describe("createTokenAdapter — missing Authorization header → viewer (null)", () => {
  const adapter = createTokenAdapter({ token: CONFIGURED_TOKEN });

  it("returns null when Authorization header is absent", async () => {
    const result = await adapter.authenticate(makeReq());
    expect(result).toBeNull();
  });

  it("returns null for empty Authorization header value", async () => {
    const result = await adapter.authenticate(makeReq(""));
    expect(result).toBeNull();
  });
});

describe("createTokenAdapter — malformed Bearer header", () => {
  const adapter = createTokenAdapter({ token: CONFIGURED_TOKEN });

  it("rejects Basic auth (not Bearer)", async () => {
    const result = await adapter.authenticate(makeReq(`Basic ${CONFIGURED_TOKEN}`));
    expect(result).toBeNull();
  });

  it("rejects token with no space after Bearer (no separator)", async () => {
    // "Bearer" + token with no space — startsWith("Bearer ") is false
    const result = await adapter.authenticate(makeReq(`Bearer${CONFIGURED_TOKEN}`));
    expect(result).toBeNull();
  });

  it("rejects 'bearer' (lowercase b) — case-sensitive", async () => {
    const result = await adapter.authenticate(makeReq(`bearer ${CONFIGURED_TOKEN}`));
    expect(result).toBeNull();
  });

  it("rejects 'BEARER' (all-caps) — case-sensitive", async () => {
    const result = await adapter.authenticate(makeReq(`BEARER ${CONFIGURED_TOKEN}`));
    expect(result).toBeNull();
  });

  it("rejects 'Token <value>' scheme", async () => {
    const result = await adapter.authenticate(makeReq(`Token ${CONFIGURED_TOKEN}`));
    expect(result).toBeNull();
  });

  it("rejects 'bearer ' (lowercase) even with correct token", async () => {
    const result = await adapter.authenticate(makeReq(`bearer ${CONFIGURED_TOKEN}`));
    expect(result).toBeNull();
  });
});

describe("createTokenAdapter — security: tokens are compared exactly", () => {
  it("is case-sensitive for the token value", async () => {
    const adapter = createTokenAdapter({ token: "SecretToken" });
    const result = await adapter.authenticate(makeReq("Bearer secrettoken"));
    expect(result).toBeNull();
  });

  it("different adapters with different tokens don't cross-authenticate", async () => {
    const adapterA = createTokenAdapter({ token: "token-a" });
    const adapterB = createTokenAdapter({ token: "token-b" });

    const resultA = await adapterA.authenticate(makeReq("Bearer token-b"));
    const resultB = await adapterB.authenticate(makeReq("Bearer token-a"));

    expect(resultA).toBeNull();
    expect(resultB).toBeNull();
  });

  it("authenticate is always async (returns a Promise)", () => {
    const adapter = createTokenAdapter({ token: CONFIGURED_TOKEN });
    const result = adapter.authenticate(makeReq(`Bearer ${CONFIGURED_TOKEN}`));
    expect(result).toBeInstanceOf(Promise);
  });
});
