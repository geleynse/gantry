/**
 * Tests for test factory functions in helpers.ts.
 */
import { describe, it, expect } from "bun:test";
import {
  createMockConfig,
  createMockSharedState,
  createMockGameClient,
  createMockRequest,
} from "./helpers.js";

describe("createMockConfig", () => {
  it("returns a valid GantryConfig with required fields", () => {
    const config = createMockConfig();
    expect(config.agents).toHaveLength(1);
    expect(config.agents[0].name).toBe("test-agent");
    expect(config.gameUrl).toContain("localhost");
    expect(config.gameMcpUrl).toContain("localhost");
    expect(config.turnSleepMs).toBeGreaterThan(0);
  });

  it("applies overrides", () => {
    const config = createMockConfig({
      agents: [{ name: "agent-a" }, { name: "agent-b" }],
      turnSleepMs: 30,
    });
    expect(config.agents).toHaveLength(2);
    expect(config.agents[0].name).toBe("agent-a");
    expect(config.turnSleepMs).toBe(30);
  });
});

describe("createMockSharedState", () => {
  it("returns an object with all SharedState keys", () => {
    const state = createMockSharedState();
    expect(state.cache.status).toBeDefined();
    expect(state.cache.battle).toBeDefined();
    expect(state.cache.events).toBeDefined();
    expect(state.proxy.callTrackers).toBeDefined();
    expect(state.proxy.gameHealthRef).toBeDefined();
    expect(state.proxy.gameHealthRef.current).toBeNull();
  });

  it("applies overrides", () => {
    const customCache = new Map([["agent-a", { data: { credits: 500 }, fetchedAt: 0 }]]);
    const state = createMockSharedState({
      cache: { status: customCache, battle: new Map(), market: {} as any, events: new Map() },
    });
    expect(state.cache.status.size).toBe(1);
    expect(state.cache.status.get("agent-a")?.data.credits).toBe(500);
  });
});

describe("createMockGameClient", () => {
  it("returns a client with default implementations", async () => {
    const client = createMockGameClient();
    expect(client.label).toBe("test-agent");
    expect(client.isConnected()).toBe(true);
    const result = await client.execute("get_status");
    expect(result.result).toBeDefined();
  });

  it("applies overrides", async () => {
    const client = createMockGameClient({
      label: "custom-agent",
      execute: async () => ({ error: { code: "fail", message: "nope" } }),
    });
    expect(client.label).toBe("custom-agent");
    const result = await client.execute("anything");
    expect(result.error).toBeDefined();
  });
});

describe("createMockRequest", () => {
  it("returns a request with defaults", () => {
    const req = createMockRequest();
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/");
    expect(req.params).toEqual({});
  });

  it("applies overrides and get() works on headers", () => {
    const req = createMockRequest({
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(req.method).toBe("POST");
    expect(req.get("content-type")).toBe("application/json");
    expect(req.get("missing")).toBeUndefined();
  });
});
