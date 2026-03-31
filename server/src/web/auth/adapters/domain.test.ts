import { describe, it, expect } from "bun:test";
import { createDomainAdapter } from "./domain.js";

function fakeReq(host: string, cfJwt?: string): any {
  return {
    get(name: string) {
      if (name.toLowerCase() === "host") return host;
      return undefined;
    },
    headers: {
      ...(cfJwt !== undefined ? { "cf-access-jwt-assertion": cfJwt } : {}),
    },
  };
}

describe("domain adapter", () => {
  // --- Core security requirement: CF JWT header must be present ---

  it("grants admin when Host matches and CF JWT header is present", async () => {
    const adapter = createDomainAdapter({ adminDomains: ["admin.example.com"] });
    const result = await adapter.authenticate(fakeReq("admin.example.com", "valid.jwt.token"));
    expect(result?.role).toBe("admin");
    expect(result?.identity).toBe("domain:admin.example.com");
  });

  it("denies when Host matches but CF JWT header is missing", async () => {
    // Host spoofing prevention: LAN attacker sends Host: admin.example.com but
    // the request never passed through Cloudflare Access, so no JWT header.
    const adapter = createDomainAdapter({ adminDomains: ["admin.example.com"] });
    const result = await adapter.authenticate(fakeReq("admin.example.com"));
    expect(result).toBeNull();
  });

  it("denies when Host does not match but CF JWT header is present", async () => {
    const adapter = createDomainAdapter({ adminDomains: ["admin.example.com"] });
    const result = await adapter.authenticate(fakeReq("public.example.com", "valid.jwt.token"));
    expect(result).toBeNull();
  });

  it("denies when Host is empty (no Host header)", async () => {
    const adapter = createDomainAdapter({ adminDomains: ["admin.example.com"] });
    const result = await adapter.authenticate(fakeReq("", "valid.jwt.token"));
    expect(result).toBeNull();
  });

  // --- Edge cases for CF JWT header content ---

  it("denies when CF JWT header is an empty string", async () => {
    const adapter = createDomainAdapter({ adminDomains: ["admin.example.com"] });
    const result = await adapter.authenticate(fakeReq("admin.example.com", ""));
    expect(result).toBeNull();
  });

  it("denies when CF JWT header is only whitespace", async () => {
    const adapter = createDomainAdapter({ adminDomains: ["admin.example.com"] });
    const result = await adapter.authenticate(fakeReq("admin.example.com", "   "));
    expect(result).toBeNull();
  });

  // --- General behavior ---

  it("returns null when Host does not match any admin domain", async () => {
    const adapter = createDomainAdapter({ adminDomains: ["admin.example.com"] });
    const result = await adapter.authenticate(fakeReq("public.example.com"));
    expect(result).toBeNull();
  });

  it("returns null for empty Host header", async () => {
    const adapter = createDomainAdapter({ adminDomains: ["admin.example.com"] });
    const result = await adapter.authenticate(fakeReq(""));
    expect(result).toBeNull();
  });

  it("supports multiple admin domains (with CF JWT present)", async () => {
    const adapter = createDomainAdapter({
      adminDomains: ["admin.example.com", "admin.other.com"],
    });
    expect((await adapter.authenticate(fakeReq("admin.example.com", "tok")))?.role).toBe("admin");
    expect((await adapter.authenticate(fakeReq("admin.other.com", "tok")))?.role).toBe("admin");
    expect(await adapter.authenticate(fakeReq("attacker.com", "tok"))).toBeNull();
  });

  it("is case-sensitive (Host header values are lowercase in HTTP/2)", async () => {
    const adapter = createDomainAdapter({ adminDomains: ["admin.example.com"] });
    // HTTP normalizes Host to lowercase; exact match only
    expect(await adapter.authenticate(fakeReq("ADMIN.EXAMPLE.COM", "tok"))).toBeNull();
    expect((await adapter.authenticate(fakeReq("admin.example.com", "tok")))?.role).toBe("admin");
  });
});
