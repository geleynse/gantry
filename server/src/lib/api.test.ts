import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { apiFetch } from "./api";

describe("apiFetch", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("prepends /api to path", async () => {
    let capturedUrl = "";
    global.fetch = (async (url: string) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    await apiFetch("/users");
    expect(capturedUrl).toBe("/api/users");
  });

  test("makes fetch request with given options", async () => {
    let capturedOptions: RequestInit | undefined;
    global.fetch = (async (_url: string, options?: RequestInit) => {
      capturedOptions = options;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    await apiFetch("/users", { method: "POST", body: "test" });
    expect(capturedOptions?.method).toBe("POST");
    expect(capturedOptions?.body).toBe("test");
  });

  test("returns parsed JSON on success", async () => {
    const mockData = { id: 1, name: "test" };
    global.fetch = (async () => {
      return new Response(JSON.stringify(mockData), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await apiFetch<typeof mockData>("/users/1");
    expect(result).toEqual(mockData);
  });

  test("throws on non-OK response with status in message", async () => {
    global.fetch = (async () => {
      return new Response("Not found", { status: 404 });
    }) as unknown as typeof fetch;

    try {
      await apiFetch("/missing");
      expect.unreachable("Should have thrown");
    } catch (e) {
      const error = e as Error;
      expect(error.message).toContain("API 404");
      expect(error.message).toContain("Not found");
    }
  });

  test("throws on 500 error", async () => {
    global.fetch = (async () => {
      return new Response("Internal error", { status: 500 });
    }) as unknown as typeof fetch;

    try {
      await apiFetch("/error");
      expect.unreachable("Should have thrown");
    } catch (e) {
      const error = e as Error;
      expect(error.message).toContain("API 500");
    }
  });

  test("uses statusText fallback if response.text() fails", async () => {
    global.fetch = (async () => {
      const response = new Response(null, { status: 400, statusText: "Bad Request" });
      // Override text() to throw
      response.text = async () => {
        throw new Error("Cannot read body");
      };
      return response;
    }) as unknown as typeof fetch;

    try {
      await apiFetch("/bad");
      expect.unreachable("Should have thrown");
    } catch (e) {
      const error = e as Error;
      expect(error.message).toContain("API 400");
    }
  });
});
