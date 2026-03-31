/**
 * Tests for the layered auth adapter, with emphasis on the Host-header
 * spoofing security fix: domain admin MUST require a validated CF JWT.
 */
import { describe, it, expect } from "bun:test";
import { createLayeredAdapter } from "./layered.js";
import type { AuthAdapter } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeReq(opts: {
  ip?: string;
  host?: string;
  cfJwt?: string;  // raw header value
  cfCookie?: string; // CF_Authorization cookie value
  headers?: Record<string, string>;
}): any {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.cfJwt) headers["cf-access-jwt-assertion"] = opts.cfJwt;
  if (opts.cfCookie) headers["cookie"] = `CF_Authorization=${opts.cfCookie}`;

  return {
    ip: opts.ip ?? "1.2.3.4",
    headers,
    get(name: string) {
      if (name.toLowerCase() === "host") return opts.host ?? "";
      return headers[name.toLowerCase()];
    },
  };
}

/** A CF adapter stub that accepts a specific token value */
function stubCfAdapter(validToken: string): AuthAdapter {
  return {
    name: "cloudflare-access",
    async authenticate(req: any) {
      const jwt = req.headers["cf-access-jwt-assertion"] ??
        req.headers["cookie"]?.match(/CF_Authorization=([^;]+)/)?.[1];
      if (jwt === validToken) {
        return { role: "admin" as const, identity: `cf:${jwt}` };
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// Security: spoofed Host header must NOT grant admin
// ---------------------------------------------------------------------------

describe("layered adapter — Host spoofing protection", () => {
  it("spoofed Host header alone does NOT grant admin (no CF JWT)", async () => {
    const adapter = createLayeredAdapter({
      // No localNetworkRanges → remote IP won't match
      localNetworkRanges: [],
      adminDomains: ["admin.example.com"],
      // No CF adapter configured
    });

    // Remote IP, no CF JWT, but Host header set to admin domain
    const req = fakeReq({ ip: "8.8.8.8", host: "admin.example.com" });
    const result = await adapter.authenticate(req);

    // Must not be admin — Host alone is not trusted
    expect(result).toBeNull(); // falls through to viewer in middleware
  });

  it("spoofed Host from LAN IP does NOT grant admin (no CF JWT, LAN not in allowed ranges)", async () => {
    const adapter = createLayeredAdapter({
      localNetworkRanges: ["10.0.0.0/8"], // only 10.x allowed
      adminDomains: ["admin.example.com"],
    });

    // LAN request from 192.168.x.x (not in allowed range), spoofed Host
    const req = fakeReq({ ip: "192.168.1.50", host: "admin.example.com" });
    const result = await adapter.authenticate(req);

    expect(result).toBeNull();
  });

  it("spoofed Host with invalid CF JWT does NOT grant admin", async () => {
    const adapter = createLayeredAdapter({
      localNetworkRanges: [],
      cloudflareTeamDomain: "test.cloudflareaccess.com",
      cloudflareAudience: "aud",
      adminDomains: ["admin.example.com"],
    });

    // JWT present but invalid (will fail validation), Host matches admin domain
    const req = fakeReq({
      ip: "8.8.8.8",
      host: "admin.example.com",
      cfJwt: "invalid.jwt.token",
    });
    const result = await adapter.authenticate(req);

    // CF validation failed, domain must not be a fallback
    expect(result).toBeNull();
  });

  it("spoofed Host with CF JWT header present but no CF adapter configured does NOT grant admin", async () => {
    const adapter = createLayeredAdapter({
      localNetworkRanges: [],
      // No cloudflareTeamDomain → no CF adapter
      adminDomains: ["admin.example.com"],
    });

    // Attacker sends a CF-looking header + spoofed Host (no CF adapter to validate it)
    const req = fakeReq({
      ip: "8.8.8.8",
      host: "admin.example.com",
      cfJwt: "fake.jwt.header",
    });
    const result = await adapter.authenticate(req);

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Correct behavior: local-network still works
// ---------------------------------------------------------------------------

describe("layered adapter — local network auth", () => {
  it("LAN IP from allowed range gets admin regardless of domain", async () => {
    const adapter = createLayeredAdapter({
      localNetworkRanges: ["192.168.0.0/16"],
      adminDomains: ["admin.example.com"],
    });

    const req = fakeReq({ ip: "192.168.1.100", host: "gantry.local" });
    const result = await adapter.authenticate(req);

    expect(result?.role).toBe("admin");
  });

  it("remote IP without CF JWT falls back to viewer", async () => {
    const adapter = createLayeredAdapter({
      localNetworkRanges: ["192.168.0.0/16"],
      adminDomains: ["admin.example.com"],
    });

    const req = fakeReq({ ip: "8.8.8.8", host: "gantry.example.com" });
    const result = await adapter.authenticate(req);

    expect(result).toBeNull(); // middleware converts null → viewer
  });
});

// ---------------------------------------------------------------------------
// Correct behavior: CF JWT validated → admin granted
// ---------------------------------------------------------------------------

describe("layered adapter — CF JWT auth", () => {
  /**
   * We can't easily inject a pre-validated CF adapter into createLayeredAdapter()
   * (it constructs the CF adapter internally). We test the logic path by verifying
   * that when NO CF adapter is configured and NO local-network match, result is null.
   * The CF validation path with a real adapter is tested in cloudflare-access.test.ts.
   */
  it("with no CF adapter and no local match → null (viewer)", async () => {
    const adapter = createLayeredAdapter({
      localNetworkRanges: [],
    });

    const req = fakeReq({ ip: "8.8.8.8", cfJwt: "some.jwt.token" });
    const result = await adapter.authenticate(req);

    // CF JWT present but no adapter to validate it → falls through
    expect(result).toBeNull();
  });

  it("with no CF adapter and matching local IP → admin", async () => {
    const adapter = createLayeredAdapter({
      localNetworkRanges: ["192.168.0.0/16"],
    });

    const req = fakeReq({ ip: "192.168.1.1" });
    const result = await adapter.authenticate(req);

    expect(result?.role).toBe("admin");
  });
});

// ---------------------------------------------------------------------------
// No config → defaults
// ---------------------------------------------------------------------------

describe("layered adapter — default config", () => {
  it("creates adapter with no config", () => {
    expect(() => createLayeredAdapter()).not.toThrow();
  });

  it("with no config, LAN IPs get admin (default private ranges)", async () => {
    const adapter = createLayeredAdapter();
    const req = fakeReq({ ip: "192.168.1.50" });
    const result = await adapter.authenticate(req);
    expect(result?.role).toBe("admin");
  });

  it("with no config, external IPs get null (viewer)", async () => {
    const adapter = createLayeredAdapter();
    const req = fakeReq({ ip: "8.8.8.8" });
    const result = await adapter.authenticate(req);
    expect(result).toBeNull();
  });
});
