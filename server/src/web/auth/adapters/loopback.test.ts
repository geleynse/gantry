import { describe, it, expect } from "bun:test";
import { createLoopbackAdapter } from "./loopback.js";

describe("Loopback Auth Adapter", () => {
  const adapter = createLoopbackAdapter();

  describe("authenticate", () => {
    it("grants admin access to 127.0.0.1 (IPv4 loopback)", async () => {
      const req = {
        ip: "127.0.0.1",
        headers: {},
        socket: { remoteAddress: "127.0.0.1" },
      } as any;

      const result = await adapter.authenticate(req);
      expect(result).toBeDefined();
      expect(result?.role).toBe("admin");
      expect(result?.identity).toBe("127.0.0.1");
    });

    it("grants admin access to ::1 (IPv6 loopback)", async () => {
      const req = {
        ip: "::1",
        headers: {},
        socket: { remoteAddress: "::1" },
      } as any;

      const result = await adapter.authenticate(req);
      expect(result).toBeDefined();
      expect(result?.role).toBe("admin");
      expect(result?.identity).toBe("::1");
    });

    it("grants admin access to ::ffff:127.0.0.1 (IPv6-mapped IPv4 loopback)", async () => {
      const req = {
        ip: "::ffff:127.0.0.1",
        headers: {},
        socket: { remoteAddress: "::ffff:127.0.0.1" },
      } as any;

      const result = await adapter.authenticate(req);
      expect(result).toBeDefined();
      expect(result?.role).toBe("admin");
      expect(result?.identity).toBe("::ffff:127.0.0.1");
    });

    it("denies access to 192.168.1.1 (local network, not loopback)", async () => {
      const req = {
        ip: "192.168.1.1",
        headers: {},
        socket: { remoteAddress: "192.168.1.1" },
      } as any;

      const result = await adapter.authenticate(req);
      expect(result).toBeNull();
    });

    it("denies access to 10.0.0.1 (private network, not loopback)", async () => {
      const req = {
        ip: "10.0.0.1",
        headers: {},
        socket: { remoteAddress: "10.0.0.1" },
      } as any;

      const result = await adapter.authenticate(req);
      expect(result).toBeNull();
    });

    it("denies access to 8.8.8.8 (public IP, not loopback)", async () => {
      const req = {
        ip: "8.8.8.8",
        headers: {},
        socket: { remoteAddress: "8.8.8.8" },
      } as any;

      const result = await adapter.authenticate(req);
      expect(result).toBeNull();
    });

    it("denies access when IP is undefined (fail-closed security)", async () => {
      const req = {
        ip: undefined,
        headers: {},
        socket: { remoteAddress: undefined },
      } as any;

      const result = await adapter.authenticate(req);
      expect(result).toBeNull();
    });

    it("denies access when IP is null (fail-closed security)", async () => {
      const req = {
        ip: null,
        headers: {},
        socket: { remoteAddress: undefined },
      } as any;

      const result = await adapter.authenticate(req);
      expect(result).toBeNull();
    });

    it("denies access when IP is empty string (fail-closed security)", async () => {
      const req = {
        ip: "",
        headers: {},
        socket: { remoteAddress: undefined },
      } as any;

      const result = await adapter.authenticate(req);
      expect(result).toBeNull();
    });

    it("grants admin with loopback IP even if x-forwarded-for header exists", async () => {
      const req = {
        ip: "127.0.0.1",
        headers: { "x-forwarded-for": "8.8.8.8" },
        socket: { remoteAddress: "127.0.0.1" },
      } as any;

      const result = await adapter.authenticate(req);
      expect(result).toBeDefined();
      expect(result?.role).toBe("admin");
    });

    it("denies access to forwarded IP even if x-forwarded-for is loopback", async () => {
      const req = {
        ip: "192.168.1.1",
        headers: { "x-forwarded-for": "127.0.0.1" },
        socket: { remoteAddress: "192.168.1.1" },
      } as any;

      const result = await adapter.authenticate(req);
      expect(result).toBeNull();
    });
  });
});
