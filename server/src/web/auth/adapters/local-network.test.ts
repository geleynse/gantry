import { describe, it, expect } from "bun:test";
import { createLocalNetworkAdapter } from "./local-network.js";

describe("local-network adapter", () => {
  it("grants admin access to allowed IP ranges", async () => {
    const adapter = createLocalNetworkAdapter({
      allowedIpRanges: ["192.168.0.0/16"],
    });

    const mockReq = {
      ip: "192.168.1.100",
    } as any;

    const result = await adapter.authenticate(mockReq);
    expect(result?.role).toBe("admin");
    expect(result?.identity).toBe("192.168.1.100");
  });

  it("denies access to IPs outside allowed ranges", async () => {
    const adapter = createLocalNetworkAdapter({
      allowedIpRanges: ["192.168.0.0/16"],
    });

    const mockReq = {
      ip: "8.8.8.8",
    } as any;

    const result = await adapter.authenticate(mockReq);
    expect(result).toBeNull();
  });

  it("supports wildcard patterns", async () => {
    const adapter = createLocalNetworkAdapter({
      allowedIpRanges: ["192.168.*"],
    });

    const mockReq = {
      ip: "192.168.1.100",
    } as any;

    const result = await adapter.authenticate(mockReq);
    expect(result?.role).toBe("admin");
  });

  it("supports multiple ranges", async () => {
    const adapter = createLocalNetworkAdapter({
      allowedIpRanges: ["192.168.0.0/16", "10.0.0.0/8"],
    });

    const req1 = { ip: "192.168.1.100" } as any;
    const req2 = { ip: "10.0.0.100" } as any;
    const req3 = { ip: "8.8.8.8" } as any;

    expect((await adapter.authenticate(req1))?.role).toBe("admin");
    expect((await adapter.authenticate(req2))?.role).toBe("admin");
    expect(await adapter.authenticate(req3)).toBeNull();
  });

  it("handles IPv6 mapped IPv4 addresses", async () => {
    const adapter = createLocalNetworkAdapter({
      allowedIpRanges: ["192.168.0.0/16"],
    });

    const mockReq = {
      ip: "::ffff:192.168.1.100",
    } as any;

    const result = await adapter.authenticate(mockReq);
    expect(result?.role).toBe("admin");
  });

  it("defaults to common private ranges", async () => {
    const adapter = createLocalNetworkAdapter();

    const testCases = [
      { ip: "127.0.0.1", shouldAllow: true },
      { ip: "192.168.1.1", shouldAllow: true },
      { ip: "10.0.0.1", shouldAllow: true },
      { ip: "172.16.0.1", shouldAllow: true },
      { ip: "8.8.8.8", shouldAllow: false },
    ];

    for (const { ip, shouldAllow } of testCases) {
      const result = await adapter.authenticate({ ip } as any);
      if (shouldAllow) {
        expect(result?.role).toBe("admin");
      } else {
        expect(result).toBeNull();
      }
    }
  });

  it("returns null when no IP is present", async () => {
    const adapter = createLocalNetworkAdapter({
      allowedIpRanges: ["192.168.0.0/16"],
    });

    const result = await adapter.authenticate({ headers: {} } as any);
    expect(result).toBeNull();
  });

  it("handles /32 (single IP) ranges", async () => {
    const adapter = createLocalNetworkAdapter({
      allowedIpRanges: ["192.168.1.100/32"],
    });

    const req1 = { ip: "192.168.1.100" } as any;
    const req2 = { ip: "192.168.1.101" } as any;

    expect((await adapter.authenticate(req1))?.role).toBe("admin");
    expect(await adapter.authenticate(req2)).toBeNull();
  });

  it("handles single IP without CIDR notation", async () => {
    const adapter = createLocalNetworkAdapter({
      allowedIpRanges: ["192.168.1.100"],
    });

    const req1 = { ip: "192.168.1.100" } as any;
    const req2 = { ip: "192.168.1.101" } as any;

    expect((await adapter.authenticate(req1))?.role).toBe("admin");
    expect(await adapter.authenticate(req2)).toBeNull();
  });
});
