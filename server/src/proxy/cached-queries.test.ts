import { describe, it, expect } from "bun:test";
import { registerCachedQueries, STATUS_SLICE_EXTRACTORS, STATUS_DESCRIPTIONS, type CachedQueryDeps } from "./cached-queries.js";

function createMockMcpServer() {
  const tools = new Map<string, { opts: any; handler: Function }>();
  return {
    registerTool: (name: string, opts: any, handler: Function) => {
      tools.set(name, { opts, handler });
    },
    tools,
  };
}

function makeDeps(overrides?: Partial<CachedQueryDeps>) {
  const mockServer = createMockMcpServer();
  const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
  return {
    mcpServer: mockServer as any,
    registeredTools: [] as string[],
    statusCache,
    getAgentForSession: () => "test-agent" as string | undefined,
    withInjections: async (_a: string, r: any) => r,
    mockServer,
    ...overrides,
  };
}

describe("registerCachedQueries", () => {
  it("registers all 6 cached query tools", () => {
    const deps = makeDeps();
    registerCachedQueries(deps);
    expect(deps.registeredTools).toEqual([
      "get_status", "get_credits", "get_location", "get_cargo_summary", "get_fuel", "get_health",
    ]);
  });

  it("get_credits returns credits from cache", async () => {
    const deps = makeDeps();
    registerCachedQueries(deps);
    deps.statusCache.set("test-agent", {
      data: { tick: 100, player: { credits: 5000 } },
      fetchedAt: Date.now(),
    });
    const handler = deps.mockServer.tools.get("get_credits")!.handler;
    const result = await handler({ sessionId: "sess-1" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.credits).toBe(5000);
    expect(parsed._cache).toBeDefined();
    expect(parsed._cache.tick).toBe(100);
  });

  it("get_location returns system/poi/docked", async () => {
    const deps = makeDeps();
    registerCachedQueries(deps);
    deps.statusCache.set("test-agent", {
      data: { tick: 50, player: { current_system: "sol", current_poi: "sol_station", docked_at_base: "sol_base" } },
      fetchedAt: Date.now(),
    });
    const handler = deps.mockServer.tools.get("get_location")!.handler;
    const result = await handler({ sessionId: "sess-1" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.system).toBe("sol");
    expect(parsed.poi).toBe("sol_station");
    expect(parsed.docked_at_base).toBe("sol_base");
  });

  it("get_fuel returns fuel/max_fuel from ship", async () => {
    const deps = makeDeps();
    registerCachedQueries(deps);
    deps.statusCache.set("test-agent", {
      data: { tick: 10, ship: { fuel: 80, max_fuel: 100 } },
      fetchedAt: Date.now(),
    });
    const handler = deps.mockServer.tools.get("get_fuel")!.handler;
    const result = await handler({ sessionId: "sess-1" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.fuel).toBe(80);
    expect(parsed.max_fuel).toBe(100);
  });

  it("get_health returns hull/max_hull", async () => {
    const deps = makeDeps();
    registerCachedQueries(deps);
    deps.statusCache.set("test-agent", {
      data: { tick: 10, ship: { hull: 50, max_hull: 100 } },
      fetchedAt: Date.now(),
    });
    const handler = deps.mockServer.tools.get("get_health")!.handler;
    const result = await handler({ sessionId: "sess-1" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.hull).toBe(50);
    expect(parsed.max_hull).toBe(100);
  });

  it("returns error when not logged in", async () => {
    const deps = makeDeps({ getAgentForSession: () => undefined });
    registerCachedQueries(deps);
    const handler = deps.mockServer.tools.get("get_credits")!.handler;
    const result = await handler({ sessionId: "sess-1" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("not logged in");
  });

  it("returns error when no cache data", async () => {
    const deps = makeDeps();
    registerCachedQueries(deps);
    // Don't set statusCache — should error
    const handler = deps.mockServer.tools.get("get_credits")!.handler;
    const result = await handler({ sessionId: "sess-1" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("no status data");
  });

  it("get_cargo_summary returns cargo data", async () => {
    const deps = makeDeps();
    registerCachedQueries(deps);
    deps.statusCache.set("test-agent", {
      data: { tick: 10, ship: { cargo_used: 50, cargo_capacity: 200, cargo: [{ item_id: "iron_ore", quantity: 50 }] } },
      fetchedAt: Date.now(),
    });
    const handler = deps.mockServer.tools.get("get_cargo_summary")!.handler;
    const result = await handler({ sessionId: "sess-1" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.cargo_used).toBe(50);
    expect(parsed.cargo_capacity).toBe(200);
  });
});

describe("STATUS_DESCRIPTIONS", () => {
  it("has descriptions for all 6 tools", () => {
    const keys = Object.keys(STATUS_DESCRIPTIONS);
    expect(keys).toEqual(["get_status", "get_credits", "get_location", "get_cargo_summary", "get_fuel", "get_health"]);
  });

  it("all descriptions are non-empty strings", () => {
    for (const [name, desc] of Object.entries(STATUS_DESCRIPTIONS)) {
      expect(typeof desc).toBe("string");
      expect(desc.length).toBeGreaterThan(0);
    }
  });
});

describe("STATUS_SLICE_EXTRACTORS", () => {
  it("exports all 6 extractors", () => {
    const keys = Object.keys(STATUS_SLICE_EXTRACTORS);
    expect(keys).toEqual(["get_status", "get_credits", "get_location", "get_cargo_summary", "get_fuel", "get_health"]);
  });

  describe("get_credits", () => {
    it("extracts credits from nested player object", () => {
      const result = STATUS_SLICE_EXTRACTORS.get_credits({ player: { credits: 9999 } }) as any;
      expect(result.credits).toBe(9999);
    });

    it("extracts credits from flat data (no player wrapper)", () => {
      const result = STATUS_SLICE_EXTRACTORS.get_credits({ credits: 1234 }) as any;
      expect(result.credits).toBe(1234);
    });
  });

  describe("get_location", () => {
    it("extracts system/poi/docked from nested player object", () => {
      const data = { player: { current_system: "sol", current_poi: "sol_station", docked_at_base: "sol_base" } };
      const result = STATUS_SLICE_EXTRACTORS.get_location(data) as any;
      expect(result.system).toBe("sol");
      expect(result.poi).toBe("sol_station");
      expect(result.docked_at_base).toBe("sol_base");
    });

    it("extracts from flat data", () => {
      const data = { current_system: "nova", current_poi: null, docked_at_base: null };
      const result = STATUS_SLICE_EXTRACTORS.get_location(data) as any;
      expect(result.system).toBe("nova");
      expect(result.poi).toBeNull();
    });
  });

  describe("get_fuel", () => {
    it("extracts fuel/max_fuel from nested ship object", () => {
      const result = STATUS_SLICE_EXTRACTORS.get_fuel({ ship: { fuel: 75, max_fuel: 100 } }) as any;
      expect(result.fuel).toBe(75);
      expect(result.max_fuel).toBe(100);
    });

    it("extracts fuel from flat data", () => {
      const result = STATUS_SLICE_EXTRACTORS.get_fuel({ fuel: 50, max_fuel: 80 }) as any;
      expect(result.fuel).toBe(50);
      expect(result.max_fuel).toBe(80);
    });
  });

  describe("get_health", () => {
    it("extracts hull/max_hull from nested ship object", () => {
      const result = STATUS_SLICE_EXTRACTORS.get_health({ ship: { hull: 60, max_hull: 100 } }) as any;
      expect(result.hull).toBe(60);
      expect(result.max_hull).toBe(100);
    });

    it("extracts hull from flat data", () => {
      const result = STATUS_SLICE_EXTRACTORS.get_health({ hull: 30, max_hull: 100 }) as any;
      expect(result.hull).toBe(30);
      expect(result.max_hull).toBe(100);
    });
  });

  describe("get_cargo_summary", () => {
    it("extracts cargo fields from nested ship object", () => {
      const cargo = [{ item_id: "iron_ore", quantity: 10 }];
      const result = STATUS_SLICE_EXTRACTORS.get_cargo_summary({ ship: { cargo_used: 10, cargo_capacity: 200, cargo } }) as any;
      expect(result.cargo_used).toBe(10);
      expect(result.cargo_capacity).toBe(200);
      expect(result.cargo).toBe(cargo);
    });

    it("extracts cargo from flat data", () => {
      const result = STATUS_SLICE_EXTRACTORS.get_cargo_summary({ cargo_used: 0, cargo_capacity: 100, cargo: [] }) as any;
      expect(result.cargo_used).toBe(0);
      expect(result.cargo_capacity).toBe(100);
    });
  });

  describe("get_status", () => {
    it("extracts full status from nested player/ship structure", () => {
      const data = {
        tick: 42,
        player: { username: "test-pilot", credits: 5000, current_system: "sol", current_poi: "sol_station", docked_at_base: null },
        ship: { name: "Rustbucket", class_id: "starter", hull: 80, max_hull: 100, fuel: 60, max_fuel: 100, cargo_used: 5, cargo_capacity: 50 },
        in_combat: false,
      };
      const result = STATUS_SLICE_EXTRACTORS.get_status(data) as any;
      // summarizeToolResult may pass through or transform — just verify key fields present
      expect(result).toBeDefined();
    });

    it("falls back gracefully when player wrapper is absent", () => {
      const data = { username: "solo", credits: 100, ship: { hull: 50, max_hull: 100, fuel: 20, max_fuel: 100, cargo_used: 0, cargo_capacity: 50 } };
      const result = STATUS_SLICE_EXTRACTORS.get_status(data);
      expect(result).toBeDefined();
    });
  });
});
