/**
 * Tests that handlePassthrough injects _poi_warning for invalid system/POI names.
 */
import { describe, it, expect, mock } from "bun:test";
import { handlePassthrough, type PassthroughDeps, type PassthroughClient } from "./passthrough-handler.js";
import type { PoiValidator } from "./poi-validator.js";

// Minimal mock client that returns a successful result
function makeClient(result: Record<string, unknown> = { status: "completed" }): PassthroughClient {
  return {
    execute: mock(async () => ({ result })),
    waitForTick: mock(async () => {}),
    lastArrivalTick: null,
  };
}

// Minimal deps with a stub poiValidator
function makeDeps(overrides: Partial<PassthroughDeps> = {}): PassthroughDeps {
  return {
    statusCache: new Map(),
    marketCache: { get: () => ({ data: null, stale: true }) } as any,
    gameHealthRef: { current: null },
    stateChangingTools: new Set(["jump", "travel", "jump_route"]),
    waitForNavCacheUpdate: mock(async () => true),
    waitForDockCacheUpdate: mock(async () => true),
    decontaminateLog: (r) => r,
    stripPendingFields: () => {},
    withInjections: mock(async (_name, result) => result),
    galaxyGraph: undefined,
    ...overrides,
  };
}

describe("handlePassthrough — POI warning injection", () => {
  it("injects _poi_warning for an invalid jump destination", async () => {
    const invalidValidator: PoiValidator = {
      isValidSystem: () => false,
      isValidPoi: () => true,
      getSuggestions: () => ["Alpha", "Beta"],
    };

    const client = makeClient({ status: "completed", location_after: { system: "hallucinated_system" } });
    const deps = makeDeps({ poiValidator: invalidValidator });

    const result = await handlePassthrough(
      deps,
      client,
      "agent1",
      "jump",
      "jump",
      { system_id: "hallucinated_system" },
      "hallucinated_system",
    );

    const outer = JSON.parse(result.content[0].text) as Record<string, unknown>;
    // jump is state-changing, so result is wrapped: { status, result: { ..., _poi_warning } }
    const inner = outer.result as Record<string, unknown>;
    expect(inner._poi_warning).toBeString();
    expect(String(inner._poi_warning)).toContain("hallucinated_system");
    expect(String(inner._poi_warning)).toContain("Alpha");
  });

  it("does not inject _poi_warning for a valid jump destination", async () => {
    const validValidator: PoiValidator = {
      isValidSystem: () => true,
      isValidPoi: () => true,
      getSuggestions: () => [],
    };

    const client = makeClient({ status: "completed" });
    const deps = makeDeps({ poiValidator: validValidator });

    const result = await handlePassthrough(
      deps,
      client,
      "agent1",
      "jump",
      "jump",
      { system_id: "sys_alpha" },
      "sys_alpha",
    );

    const outer = JSON.parse(result.content[0].text) as Record<string, unknown>;
    const inner = outer.result as Record<string, unknown>;
    expect(inner._poi_warning).toBeUndefined();
  });
});
