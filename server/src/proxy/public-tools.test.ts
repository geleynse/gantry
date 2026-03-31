import { describe, it, expect } from "bun:test";
import { registerPublicTools, handleGetGlobalMarket, handleFindLocalRoute, type PublicToolDeps } from "./public-tools.js";

function createMockMcpServer() {
  const tools = new Map<string, { opts: any; handler: Function }>();
  return {
    registerTool: (name: string, opts: any, handler: Function) => {
      tools.set(name, { opts, handler });
    },
    tools,
  };
}

// Minimal MarketCache mock
function createMockMarketCache(data?: { items: any[]; categories: string[] }) {
  return {
    get: (_filter?: string) => ({
      data: data ?? null,
      stale: false,
      age_seconds: 10,
    }),
  };
}

// Minimal GalaxyGraph mock
function createMockGalaxyGraph(opts?: { systems?: number; routeResult?: any }) {
  return {
    systemCount: opts?.systems ?? 100,
    resolveSystemId: (name: string) => name === "unknown" ? undefined : name,
    findRoute: (_from: string, _to: string) => opts?.routeResult ?? { route: ["a", "b"], names: ["A", "B"], jumps: 1 },
  };
}

function createMockArbitrageAnalyzer(opportunities: any[] = []) {
  return {
    getOpportunities: () => opportunities,
  };
}

function makeDeps(overrides?: Partial<PublicToolDeps>) {
  const mockServer = createMockMcpServer();
  return {
    mcpServer: mockServer as any,
    registeredTools: [] as string[],
    marketCache: createMockMarketCache({ items: [{ id: "iron_ore", price: 10 }], categories: ["ore"] }) as any,
    arbitrageAnalyzer: createMockArbitrageAnalyzer() as any,
    galaxyGraph: createMockGalaxyGraph() as any,
    getAgentForSession: () => "test-agent" as string | undefined,
    mockServer,
    ...overrides,
  };
}

describe("registerPublicTools", () => {

  it("get_global_market returns market data", async () => {
    const deps = makeDeps();
    registerPublicTools(deps);
    const handler = deps.mockServer.tools.get("get_global_market")!.handler;
    const result = await handler({ item_name: undefined }, { sessionId: "s1" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toBeDefined();
    expect(parsed.item_count).toBe(1);
    expect(parsed._cache).toBeDefined();
  });

  it("get_global_market returns error when no data", async () => {
    const deps = makeDeps({ marketCache: createMockMarketCache() as any });
    registerPublicTools(deps);
    const handler = deps.mockServer.tools.get("get_global_market")!.handler;
    const result = await handler({ item_name: undefined }, { sessionId: "s1" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("not yet available");
  });

  it("find_local_route returns route", async () => {
    const deps = makeDeps();
    registerPublicTools(deps);
    const handler = deps.mockServer.tools.get("find_local_route")!.handler;
    const result = await handler({ from_system: "sol", to_system: "alpha" }, { sessionId: "s1" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.route).toBeDefined();
    expect(parsed.jumps).toBe(1);
  });

  it("find_local_route returns error for unknown system", async () => {
    const deps = makeDeps();
    registerPublicTools(deps);
    const handler = deps.mockServer.tools.get("find_local_route")!.handler;
    const result = await handler({ from_system: "unknown", to_system: "alpha" }, { sessionId: "s1" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("unknown system");
  });

  it("find_local_route returns error when graph not loaded", async () => {
    const deps = makeDeps({ galaxyGraph: createMockGalaxyGraph({ systems: 0 }) as any });
    registerPublicTools(deps);
    const handler = deps.mockServer.tools.get("find_local_route")!.handler;
    const result = await handler({ from_system: "sol", to_system: "alpha" }, { sessionId: "s1" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("not yet loaded");
  });

  it("returns error when not logged in", async () => {
    const deps = makeDeps({ getAgentForSession: () => undefined });
    registerPublicTools(deps);
    const handler = deps.mockServer.tools.get("get_global_market")!.handler;
    const result = await handler({ item_name: undefined }, { sessionId: "s1" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("not logged in");
  });
});

describe("handleGetGlobalMarket", () => {
  it("returns items, item_count, categories, and _cache when data available", () => {
    const cache = createMockMarketCache({ items: [{ id: "iron_ore", price: 10 }, { id: "ore_gold", price: 50 }], categories: ["ore"] }) as any;
    const result = handleGetGlobalMarket(cache);
    expect(result.items).toHaveLength(2);
    expect(result.item_count).toBe(2);
    expect(result.categories).toEqual(["ore"]);
    expect(result._cache).toBeDefined();
  });

  it("returns error when no market data available", () => {
    const cache = createMockMarketCache() as any;
    const result = handleGetGlobalMarket(cache);
    expect(result.error).toContain("not yet available");
  });

  it("passes item filter to market cache", () => {
    let capturedFilter: string | undefined;
    const cache = {
      get: (filter?: string) => {
        capturedFilter = filter;
        return { data: { items: [{ id: "iron_ore", price: 10 }], categories: ["ore"] }, stale: false, age_seconds: 5 };
      },
    } as any;
    const result = handleGetGlobalMarket(cache, "iron_ore");
    expect(capturedFilter).toBe("iron_ore");
    expect(result.item_count).toBe(1);
  });
});

describe("handleFindLocalRoute", () => {
  it("returns route, names, and jumps on success", () => {
    const graph = createMockGalaxyGraph() as any;
    const result = handleFindLocalRoute(graph, "sol", "alpha");
    expect(result.route).toEqual(["a", "b"]);
    expect(result.names).toEqual(["A", "B"]);
    expect(result.jumps).toBe(1);
  });

  it("returns error for unknown from_system", () => {
    const graph = createMockGalaxyGraph() as any;
    const result = handleFindLocalRoute(graph, "unknown", "alpha");
    expect(result.error).toContain("unknown system: unknown");
  });

  it("returns error for unknown to_system", () => {
    const graph = createMockGalaxyGraph() as any;
    const result = handleFindLocalRoute(graph, "sol", "unknown");
    expect(result.error).toContain("unknown system: unknown");
  });

  it("returns error when no route found", () => {
    const graph = {
      systemCount: 100,
      resolveSystemId: (name: string) => name,
      findRoute: () => null,
    } as any;
    const result = handleFindLocalRoute(graph, "sol", "alpha");
    expect(result.error).toContain("no route found from sol to alpha");
  });

  it("returns error when galaxy graph is empty", () => {
    const graph = createMockGalaxyGraph({ systems: 0 }) as any;
    const result = handleFindLocalRoute(graph, "sol", "alpha");
    expect(result.error).toContain("not yet loaded");
  });
});
