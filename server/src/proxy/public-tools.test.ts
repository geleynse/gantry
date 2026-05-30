import { describe, it, expect } from "bun:test";
import { registerPublicTools, handleGetGlobalMarket, handleFindLocalRoute, type PublicToolDeps } from "./public-tools.js";
import type { EmpireInfo } from "./empire-info-cache.js";

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

const MOCK_EMPIRE_DATA: EmpireInfo[] = [
  {
    id: "solarian", name: "Solarian",
    tax_rate_income: 0.1, tax_rate_sales: 0.05,
    tax_collection_active: false, citizenship_open: false,
    citizenship_requirements: "500 rep", fuel_surcharge: 0.02,
    repair_cost_modifier: 1.0, customs_fine_rate: 0.1,
    bounty_multiplier: 1.0, starting_credits: 1000, contraband: [],
  },
  {
    id: "voidborn", name: "Voidborn",
    tax_rate_income: 0.15, tax_rate_sales: 0.08,
    tax_collection_active: false, citizenship_open: true,
    citizenship_requirements: "none", fuel_surcharge: 0.0,
    repair_cost_modifier: 1.2, customs_fine_rate: 0.0,
    bounty_multiplier: 0.5, starting_credits: 500, contraband: [],
  },
];

function createMockEmpireInfoCache(data?: EmpireInfo[] | null) {
  return {
    get: (empire_id?: string) => {
      if (!data) return { data: null, stale: false, age_seconds: -1 };
      const filtered = empire_id ? data.filter((e) => e.id === empire_id) : data;
      return { data: filtered, stale: false, age_seconds: 30 };
    },
  };
}

describe("get_empire_policies", () => {
  it("returns error when cache is empty", async () => {
    const deps = makeDeps({ empireInfoCache: createMockEmpireInfoCache(null) as any });
    registerPublicTools(deps);
    const handler = deps.mockServer.tools.get("get_empire_policies")!.handler;
    const result = await handler({ empire_id: undefined }, { sessionId: "s1" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("not yet loaded");
  });

  it("returns all empires when no empire_id filter", async () => {
    const deps = makeDeps({ empireInfoCache: createMockEmpireInfoCache(MOCK_EMPIRE_DATA) as any });
    registerPublicTools(deps);
    const handler = deps.mockServer.tools.get("get_empire_policies")!.handler;
    const result = await handler({ empire_id: undefined }, { sessionId: "s1" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.empires).toHaveLength(2);
    expect(parsed._cache).toBeDefined();
    expect(parsed._cache.age_seconds).toBe(30);
  });

  it("filters by empire_id", async () => {
    const deps = makeDeps({ empireInfoCache: createMockEmpireInfoCache(MOCK_EMPIRE_DATA) as any });
    registerPublicTools(deps);
    const handler = deps.mockServer.tools.get("get_empire_policies")!.handler;
    const result = await handler({ empire_id: "solarian" }, { sessionId: "s1" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.empires).toHaveLength(1);
    expect(parsed.empires[0].id).toBe("solarian");
  });

  it("includes _cache metadata with stale flag", async () => {
    const staleCache = {
      get: () => ({ data: MOCK_EMPIRE_DATA, stale: true, age_seconds: 3700 }),
    };
    const deps = makeDeps({ empireInfoCache: staleCache as any });
    registerPublicTools(deps);
    const handler = deps.mockServer.tools.get("get_empire_policies")!.handler;
    const result = await handler({}, { sessionId: "s1" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed._cache.stale).toBe(true);
    expect(parsed._cache.age_seconds).toBe(3700);
  });

  it("returns error when not logged in", async () => {
    const deps = makeDeps({
      empireInfoCache: createMockEmpireInfoCache(MOCK_EMPIRE_DATA) as any,
      getAgentForSession: () => undefined,
    });
    registerPublicTools(deps);
    const handler = deps.mockServer.tools.get("get_empire_policies")!.handler;
    const result = await handler({}, { sessionId: "s1" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("not logged in");
  });

  it("returns error when empireInfoCache not provided", async () => {
    const deps = makeDeps({ empireInfoCache: undefined });
    registerPublicTools(deps);
    const handler = deps.mockServer.tools.get("get_empire_policies")?.handler;
    // Tool should be registered
    expect(handler).toBeDefined();
    const result = await handler!({}, { sessionId: "s1" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("empire info cache not available");
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
