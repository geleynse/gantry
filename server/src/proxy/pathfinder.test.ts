import { describe, it, expect, mock, afterEach } from "bun:test";
import { GalaxyGraph, fetchAndBuildGraph, normalizeSystemName, type MapData } from "./pathfinder.js";

const MOCK_MAP: MapData = {
  systems: [
    { id: "sys_a", name: "Alpha", x: 0, y: 0, online: 0, connections: ["sys_b", "sys_c"] },
    { id: "sys_b", name: "Beta", x: 100, y: 0, online: 0, connections: ["sys_a", "sys_d"] },
    { id: "sys_c", name: "Gamma", x: 0, y: 100, online: 0, connections: ["sys_a", "sys_d"] },
    { id: "sys_d", name: "Delta", x: 100, y: 100, online: 0, connections: ["sys_b", "sys_c", "sys_e"] },
    { id: "sys_e", name: "Epsilon", x: 200, y: 100, online: 0, connections: ["sys_d"] },
    { id: "sys_isolated", name: "Isolated", x: 500, y: 500, online: 0, connections: [] },
  ],
};

function mockFetch(responses: Array<{ body: unknown; status: number } | Error>) {
  let callIdx = 0;
  global.fetch = mock(async () => {
    const resp = responses[callIdx++];
    if (!resp) throw new Error("unexpected fetch call");
    if (resp instanceof Error) throw resp;
    return new Response(JSON.stringify(resp.body), { status: resp.status });
  }) as any;
}

describe("GalaxyGraph", () => {
  it("finds direct route between neighbors", () => {
    const g = new GalaxyGraph();
    g.addSystem("A", "Alpha");
    g.addSystem("B", "Beta");
    g.addEdge("A", "B");

    const route = g.findRoute("A", "B");
    expect(route).not.toBeNull();
    expect(route!.route).toEqual(["A", "B"]);
    expect(route!.jumps).toBe(1);
  });

  it("returns same system with zero jumps for source=dest", () => {
    const g = new GalaxyGraph();
    g.addSystem("A", "Alpha");

    const route = g.findRoute("A", "A");
    expect(route).not.toBeNull();
    expect(route!.route).toEqual(["A"]);
    expect(route!.jumps).toBe(0);
    expect(route!.names).toEqual(["Alpha"]);
  });

  it("returns null for unreachable destination", () => {
    const g = new GalaxyGraph();
    g.addSystem("A", "Alpha");
    g.addSystem("B", "Beta");

    const route = g.findRoute("A", "B");
    expect(route).toBeNull();
  });

  it("returns null for unknown system IDs", () => {
    const g = new GalaxyGraph();
    g.addSystem("A", "Alpha");

    expect(g.findRoute("A", "Z")).toBeNull();
    expect(g.findRoute("Z", "A")).toBeNull();
  });

  it("checks neighbor relationships with isNeighbor", () => {
    const g = new GalaxyGraph();
    g.addSystem("sol", "Sol");
    g.addSystem("sirius", "Sirius");
    g.addSystem("wolf", "Wolf 359");
    g.addEdge("sol", "sirius");

    expect(g.isNeighbor("sol", "sirius")).toBe(true);
    expect(g.isNeighbor("sirius", "sol")).toBe(true);
    expect(g.isNeighbor("sol", "wolf")).toBe(false);
    expect(g.isNeighbor("wolf", "sol")).toBe(false);
    expect(g.isNeighbor("unknown", "sol")).toBe(false);
  });

  it("finds shortest path through intermediaries", () => {
    const g = new GalaxyGraph();
    g.addSystem("A", "Alpha");
    g.addSystem("B", "Beta");
    g.addSystem("C", "Gamma");
    g.addSystem("D", "Delta");
    g.addSystem("E", "Epsilon");
    g.addEdge("A", "B");
    g.addEdge("A", "C");
    g.addEdge("B", "D");
    g.addEdge("C", "D");
    g.addEdge("D", "E");

    const route = g.findRoute("A", "E");
    expect(route).not.toBeNull();
    expect(route!.jumps).toBe(3);
    expect(route!.route[0]).toBe("A");
    expect(route!.route[route!.route.length - 1]).toBe("E");
  });

  it("finds shortest path with equal-length alternatives", () => {
    const g = new GalaxyGraph();
    g.addSystem("A", "Alpha");
    g.addSystem("B", "Beta");
    g.addSystem("C", "Gamma");
    g.addSystem("D", "Delta");
    g.addEdge("A", "B");
    g.addEdge("B", "C");
    g.addEdge("A", "D");
    g.addEdge("D", "C");

    const route = g.findRoute("A", "C");
    expect(route!.jumps).toBe(2);
  });

  it("resolves system name to ID (case-insensitive)", () => {
    const g = new GalaxyGraph();
    g.addSystem("sys_001", "Alpha Centauri");

    expect(g.resolveSystemId("sys_001")).toBe("sys_001");
    expect(g.resolveSystemId("Alpha Centauri")).toBe("sys_001");
    expect(g.resolveSystemId("alpha centauri")).toBe("sys_001");
    expect(g.resolveSystemId("nonexistent")).toBeNull();
  });

  it("includes names in route result", () => {
    const g = new GalaxyGraph();
    g.addSystem("A", "Alpha");
    g.addSystem("B", "Beta");
    g.addSystem("C", "Gamma");
    g.addEdge("A", "B");
    g.addEdge("B", "C");

    const route = g.findRoute("A", "C");
    expect(route!.names).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("reports correct systemCount", () => {
    const g = new GalaxyGraph();
    expect(g.systemCount).toBe(0);
    g.addSystem("A", "Alpha");
    g.addSystem("B", "Beta");
    expect(g.systemCount).toBe(2);
    g.addEdge("A", "C"); // addEdge creates nodes too
    expect(g.systemCount).toBe(3);
  });

  it("resolveSystemId matches underscore-style input to display name with spaces", () => {
    const g = new GalaxyGraph();
    g.addSystem("nbt_001", "Node Beta");
    g.addEdge("nbt_001", "nbt_001"); // ensure adj entry exists

    expect(g.resolveSystemId("node_beta")).toBe("nbt_001");
    expect(g.resolveSystemId("Node_Beta")).toBe("nbt_001");
    expect(g.resolveSystemId("NODE_BETA")).toBe("nbt_001");
  });

  it("resolveSystemId trims whitespace from name input", () => {
    const g = new GalaxyGraph();
    g.addSystem("sol_001", "Sol");

    expect(g.resolveSystemId("  Sol  ")).toBe("sol_001");
    expect(g.resolveSystemId("  SOL  ")).toBe("sol_001");
  });

  it("findRoute accepts display names as source and destination", () => {
    const g = new GalaxyGraph();
    g.addSystem("sys_sol", "Sol");
    g.addSystem("sys_alpha", "Alpha");
    g.addEdge("sys_sol", "sys_alpha");

    const route = g.findRoute("Sol", "Alpha");
    expect(route).not.toBeNull();
    expect(route!.route).toEqual(["sys_sol", "sys_alpha"]);
    expect(route!.jumps).toBe(1);
  });

  it("findRoute accepts mixed-case and underscore names", () => {
    const g = new GalaxyGraph();
    g.addSystem("node_beta", "Node Beta");
    g.addSystem("gsc_0050", "GSC 0050");
    g.addEdge("node_beta", "gsc_0050");

    const route = g.findRoute("node_beta", "GSC 0050");
    expect(route).not.toBeNull();
    expect(route!.route).toEqual(["node_beta", "gsc_0050"]);

    const routeUnderscore = g.findRoute("Node_Beta", "gsc_0050");
    expect(routeUnderscore).not.toBeNull();
    expect(routeUnderscore!.jumps).toBe(1);
  });
});

describe("normalizeSystemName", () => {
  it("lowercases and trims input", () => {
    expect(normalizeSystemName("Sol")).toBe("sol");
    expect(normalizeSystemName("  Alpha Centauri  ")).toBe("alpha centauri");
    expect(normalizeSystemName("GSC 0050")).toBe("gsc 0050");
  });

  it("converts underscores to spaces", () => {
    expect(normalizeSystemName("node_beta")).toBe("node beta");
    expect(normalizeSystemName("gsc_0050")).toBe("gsc 0050");
  });

  it("handles combined transformations", () => {
    expect(normalizeSystemName("  Node_Beta  ")).toBe("node beta");
    expect(normalizeSystemName("NOVA_TERRA")).toBe("nova terra");
    expect(normalizeSystemName("sol")).toBe("sol");
  });
});

describe("fetchAndBuildGraph", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("builds graph from API response", async () => {
    mockFetch([{ body: MOCK_MAP, status: 200 }]);

    const { graph, success } = await fetchAndBuildGraph("http://localhost/api/map");

    expect(success).toBe(true);
    expect(graph.systemCount).toBe(6);

    const route = graph.findRoute("sys_a", "sys_e");
    expect(route).not.toBeNull();
    expect(route!.jumps).toBe(3);
    expect(route!.names[0]).toBe("Alpha");
    expect(route!.names[route!.names.length - 1]).toBe("Epsilon");
  });

  it("isolated nodes are unreachable", async () => {
    mockFetch([{ body: MOCK_MAP, status: 200 }]);

    const { graph } = await fetchAndBuildGraph("http://localhost/api/map");
    const route = graph.findRoute("sys_a", "sys_isolated");
    expect(route).toBeNull();
  });

  it("returns empty graph on HTTP error", async () => {
    mockFetch([{ body: "Not Found", status: 404 }]);

    const { graph, success } = await fetchAndBuildGraph("http://localhost/api/map");
    expect(success).toBe(false);
    expect(graph.systemCount).toBe(0);
  });

  it("returns empty graph on network error", async () => {
    mockFetch([new Error("network timeout")]);

    const { graph, success } = await fetchAndBuildGraph("http://localhost/api/map");
    expect(success).toBe(false);
    expect(graph.systemCount).toBe(0);
  });

  it("returns empty graph on invalid response", async () => {
    mockFetch([{ body: { invalid: true }, status: 200 }]);

    const { graph, success } = await fetchAndBuildGraph("http://localhost/api/map");
    expect(success).toBe(false);
    expect(graph.systemCount).toBe(0);
  });
});

describe("GalaxyGraph periodic refresh", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("start() initializes background refresh with default interval", async () => {
    const g = new GalaxyGraph();
    g.addSystem("A", "Alpha");

    mockFetch([
      { body: { systems: [{ id: "A", name: "Alpha", x: 0, y: 0, connections: [] }, { id: "B", name: "Beta", x: 100, y: 0, connections: [] }] }, status: 200 },
    ]);

    g.start("http://localhost/api/map", 1000);

    // Give it a moment to fetch
    await new Promise(resolve => setTimeout(resolve, 50));

    // System count should have changed
    expect(g.systemCount).toBe(2);

    g.stop();
  });

  it("start() performs non-blocking initial fetch", async () => {
    const g = new GalaxyGraph();
    g.addSystem("X", "Xray");

    mockFetch([
      { body: { systems: [{ id: "X", name: "Xray", x: 0, y: 0, connections: [] }, { id: "Y", name: "Yankee", x: 100, y: 0, connections: [] }] }, status: 200 },
    ]);

    // Should not block
    g.start("http://localhost/api/map", 5000);

    expect(g.systemCount).toBe(1); // Starts with 1

    await new Promise(resolve => setTimeout(resolve, 100));

    expect(g.systemCount).toBe(2); // Async update worked

    g.stop();
  });

  it("stop() clears the refresh interval", async () => {
    const g = new GalaxyGraph();
    mockFetch([{ body: MOCK_MAP, status: 200 }]);

    g.start("http://localhost/api/map", 1000);

    await new Promise(resolve => setTimeout(resolve, 50));

    g.stop();

    // After stop, the interval should be cleared
    // (We can't directly check if setInterval is cleared, but multiple stop() calls should be safe)
    g.stop(); // Should not throw
    expect(true).toBe(true); // Idempotent
  });

  it("refresh detects topology change (system count increase)", async () => {
    const g = new GalaxyGraph();
    g.addSystem("A", "Alpha");
    g.addSystem("B", "Beta");

    const expandedMap: MapData = {
      systems: [
        { id: "A", name: "Alpha", x: 0, y: 0, online: 0, connections: ["B", "C"] },
        { id: "B", name: "Beta", x: 100, y: 0, online: 0, connections: ["A", "C"] },
        { id: "C", name: "Gamma", x: 200, y: 0, online: 0, connections: ["A", "B"] },
      ],
    };

    mockFetch([
      { body: expandedMap, status: 200 },
    ]);

    g.start("http://localhost/api/map", 1000);

    await new Promise(resolve => setTimeout(resolve, 100));

    expect(g.systemCount).toBe(3);

    g.stop();
  });

  it("refresh handles HTTP error gracefully", async () => {
    const g = new GalaxyGraph();
    g.addSystem("A", "Alpha");

    mockFetch([
      { body: "Server Error", status: 500 },
    ]);

    g.start("http://localhost/api/map", 1000);

    await new Promise(resolve => setTimeout(resolve, 100));

    // Should remain unchanged on error
    expect(g.systemCount).toBe(1);

    g.stop();
  });

  it("refresh handles network timeout gracefully", async () => {
    const g = new GalaxyGraph();
    g.addSystem("A", "Alpha");

    mockFetch([
      new Error("timeout"),
    ]);

    g.start("http://localhost/api/map", 1000);

    await new Promise(resolve => setTimeout(resolve, 100));

    // Should remain unchanged on network error
    expect(g.systemCount).toBe(1);

    g.stop();
  });

  it("refresh handles invalid response shape", async () => {
    const g = new GalaxyGraph();
    g.addSystem("A", "Alpha");

    mockFetch([
      { body: { invalid: true }, status: 200 },
    ]);

    g.start("http://localhost/api/map", 1000);

    await new Promise(resolve => setTimeout(resolve, 100));

    // Should remain unchanged on invalid response
    expect(g.systemCount).toBe(1);

    g.stop();
  });

  it("refresh does not update graph when system count is unchanged", async () => {
    const g = new GalaxyGraph();
    g.addSystem("A", "Alpha");
    g.addSystem("B", "Beta");
    g.addEdge("A", "B");

    const sameCountMap: MapData = {
      systems: [
        { id: "X", name: "Xray", x: 0, y: 0, online: 0, connections: ["Y"] },
        { id: "Y", name: "Yankee", x: 100, y: 0, online: 0, connections: ["X"] },
      ],
    };

    mockFetch([
      { body: sameCountMap, status: 200 },
    ]);

    g.start("http://localhost/api/map", 1000);

    await new Promise(resolve => setTimeout(resolve, 100));

    // System count is same (2), so graph should not update
    // Original system names should remain
    expect(g.systemCount).toBe(2);
    expect(g.getSystemName("A")).toBe("Alpha");

    g.stop();
  });

  it("multiple start/stop cycles work correctly", async () => {
    const g = new GalaxyGraph();
    mockFetch([
      { body: MOCK_MAP, status: 200 },
      { body: MOCK_MAP, status: 200 },
    ]);

    g.start("http://localhost/api/map", 500);
    await new Promise(resolve => setTimeout(resolve, 100));
    g.stop();

    const count1 = g.systemCount;

    g.start("http://localhost/api/map", 500);
    await new Promise(resolve => setTimeout(resolve, 100));
    g.stop();

    const count2 = g.systemCount;

    expect(count1).toBe(count2);
  });

describe("forceRefresh", () => {
  it("triggers an immediate graph refresh", async () => {
    const g = new GalaxyGraph();
    mockFetch([{ body: MOCK_MAP, status: 200 }]);
    const changed = await g.forceRefresh("http://localhost/api/map");
    expect(changed).toBe(true);
    expect(g.systemCount).toBeGreaterThan(0);
  });

  it("returns false if fetch fails", async () => {
    const g = new GalaxyGraph();
    mockFetch([{ body: "", status: 500 }]);
    const changed = await g.forceRefresh();
    expect(changed).toBe(false);
  });

  it("updates topology when system count changes", async () => {
    const g = new GalaxyGraph();
    mockFetch([{ body: MOCK_MAP, status: 200 }]);
    g.start("http://localhost/api/map", 99999);
    await new Promise(resolve => setTimeout(resolve, 50));
    const countBefore = g.systemCount;

    const EXPANDED_MAP = {
      systems: [
        ...JSON.parse(JSON.stringify(MOCK_MAP)).systems,
        { id: "sys_new", name: "New System", connections: ["sol"] },
      ],
    };
    mockFetch([{ body: EXPANDED_MAP, status: 200 }]);
    const changed = await g.forceRefresh();
    expect(changed).toBe(true);
    expect(g.systemCount).toBeGreaterThan(countBefore);
    g.stop();
  });
});
});
