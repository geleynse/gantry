/**
 * api-drift-monitor tests
 *
 * Covers:
 * - buildBaseline: normalization, sorting, session_id exclusion
 * - diffBaseline: add/remove/type-change/required-change detection
 * - formatDriftAlert + getDriftSeverity: message content, severity logic
 * - createApiDriftMonitor: cold-start, no-drift, drift alerting, dedup, forceCheck, acceptBaseline
 *
 * Mocking strategy:
 * - global.fetch: saved/restored manually (not covered by mock.restore())
 * - alertsDb (createAlert, hasRecentAlert): spyOn namespace imports
 * - File I/O: uses a real temp dir (mkdtemp) for baseline reads/writes
 */

import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as alertsDb from "./alerts-db.js";
import {
  buildBaseline,
  buildBaselineTool,
  diffBaseline,
  formatDriftAlert,
  getDriftSeverity,
  isDriftEmpty,
  normalizeType,
  readDriftBaseline,
  writeDriftBaseline,
  createApiDriftMonitor,
  INTENTIONALLY_SKIPPED,
} from "./api-drift-monitor.js";
import type { ServerTool, ApiDriftBaseline, DriftReport } from "./api-drift-monitor.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeTool(name: string, params: Record<string, { type?: string; description?: string }> = {}, required: string[] = []): ServerTool {
  const properties: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    properties[k] = v;
  }
  return {
    name,
    inputSchema: {
      type: "object",
      properties,
      required,
    },
  };
}

function makeBaseline(tools: ServerTool[], version = "v1.0"): ApiDriftBaseline {
  return buildBaseline(tools, version);
}

// ---------------------------------------------------------------------------
// normalizeType
// ---------------------------------------------------------------------------

describe("normalizeType", () => {
  it("normalizes 'integer' to 'number'", () => {
    expect(normalizeType("integer")).toBe("number");
  });

  it("leaves 'number' as 'number'", () => {
    expect(normalizeType("number")).toBe("number");
  });

  it("leaves 'string' as 'string'", () => {
    expect(normalizeType("string")).toBe("string");
  });

  it("returns 'unknown' for undefined", () => {
    expect(normalizeType(undefined)).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// buildBaselineTool / buildBaseline
// ---------------------------------------------------------------------------

describe("buildBaseline", () => {
  it("normalizes 'integer' type to 'number' in params", () => {
    const tool = makeTool("mine", { amount: { type: "integer" } });
    const baseline = makeBaseline([tool]);
    const mineTool = baseline.tools.find((t) => t.name === "mine")!;
    expect(mineTool.params[0].type).toBe("number");
  });

  it("sorts params alphabetically", () => {
    const tool = makeTool("dock", {
      station_id: { type: "string" },
      agent: { type: "string" },
      bay: { type: "integer" },
    });
    const baseline = makeBaseline([tool]);
    const dockTool = baseline.tools.find((t) => t.name === "dock")!;
    const names = dockTool.params.map((p) => p.name);
    expect(names).toEqual(["agent", "bay", "station_id"]);
  });

  it("omits session_id from params", () => {
    const tool = makeTool("travel", {
      destination_id: { type: "string" },
      session_id: { type: "string" },
    });
    const baseline = makeBaseline([tool]);
    const travelTool = baseline.tools.find((t) => t.name === "travel")!;
    expect(travelTool.params.map((p) => p.name)).not.toContain("session_id");
    expect(travelTool.params.map((p) => p.name)).toContain("destination_id");
  });

  it("marks required params correctly from inputSchema.required", () => {
    const tool = makeTool(
      "sell",
      { item_id: { type: "string" }, quantity: { type: "integer" }, auto_list: { type: "boolean" } },
      ["item_id", "quantity"]
    );
    const baseline = makeBaseline([tool]);
    const sellTool = baseline.tools.find((t) => t.name === "sell")!;
    const byName = Object.fromEntries(sellTool.params.map((p) => [p.name, p]));
    expect(byName["item_id"].required).toBe(true);
    expect(byName["quantity"].required).toBe(true);
    expect(byName["auto_list"].required).toBe(false);
  });

  it("sets hasDescription correctly", () => {
    const tool = makeTool("jump", {
      system_id: { type: "string", description: "Target system" },
      fuel_pct: { type: "number" },
    });
    const baseline = makeBaseline([tool]);
    const jumpTool = baseline.tools.find((t) => t.name === "jump")!;
    const byName = Object.fromEntries(jumpTool.params.map((p) => [p.name, p]));
    expect(byName["system_id"].hasDescription).toBe(true);
    expect(byName["fuel_pct"].hasDescription).toBe(false);
  });

  it("handles tools with no inputSchema", () => {
    const tool: ServerTool = { name: "help" };
    const baseline = makeBaseline([tool]);
    const helpTool = baseline.tools.find((t) => t.name === "help")!;
    expect(helpTool.params).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// diffBaseline
// ---------------------------------------------------------------------------

describe("diffBaseline", () => {
  it("returns empty diff for identical baselines", () => {
    const tools = [makeTool("mine", { amount: { type: "integer" } })];
    const baseline = makeBaseline(tools);
    const report = diffBaseline(baseline, baseline);
    expect(isDriftEmpty(report)).toBe(true);
  });

  it("detects new tools", () => {
    const old = makeBaseline([makeTool("mine")]);
    const current = makeBaseline([makeTool("mine"), makeTool("deploy_drone")]);
    const report = diffBaseline(old, current);
    expect(report.newTools).toContain("deploy_drone");
    expect(report.removedTools).toHaveLength(0);
  });

  it("detects removed tools (not in INTENTIONALLY_SKIPPED)", () => {
    const old = makeBaseline([makeTool("mine"), makeTool("travel")]);
    const current = makeBaseline([makeTool("mine")]);
    const report = diffBaseline(old, current);
    expect(report.removedTools).toContain("travel");
  });

  it("excludes INTENTIONALLY_SKIPPED tools from removedTools", () => {
    // Pick a tool we know is in INTENTIONALLY_SKIPPED
    const skipped = "login";
    expect(INTENTIONALLY_SKIPPED.has(skipped)).toBe(true);
    const old = makeBaseline([makeTool("mine"), makeTool(skipped)]);
    const current = makeBaseline([makeTool("mine")]);
    const report = diffBaseline(old, current);
    expect(report.removedTools).not.toContain(skipped);
  });

  it("detects param additions on a changed tool", () => {
    const old = makeBaseline([makeTool("dock", { station_id: { type: "string" } })]);
    const current = makeBaseline([makeTool("dock", {
      station_id: { type: "string" },
      drone_id: { type: "string" },
    })]);
    const report = diffBaseline(old, current);
    const dockDiff = report.changedTools.find((t) => t.name === "dock");
    expect(dockDiff).toBeDefined();
    expect(dockDiff!.newParams).toContain("drone_id");
  });

  it("detects param removals on a changed tool", () => {
    const old = makeBaseline([makeTool("dock", {
      station_id: { type: "string" },
      bay: { type: "integer" },
    })]);
    const current = makeBaseline([makeTool("dock", { station_id: { type: "string" } })]);
    const report = diffBaseline(old, current);
    const dockDiff = report.changedTools.find((t) => t.name === "dock");
    expect(dockDiff).toBeDefined();
    expect(dockDiff!.removedParams).toContain("bay");
  });

  it("detects type changes", () => {
    const old = makeBaseline([makeTool("sell", { quantity: { type: "string" } })]);
    const current = makeBaseline([makeTool("sell", { quantity: { type: "integer" } })]);
    const report = diffBaseline(old, current);
    const sellDiff = report.changedTools.find((t) => t.name === "sell");
    expect(sellDiff).toBeDefined();
    // "string" → "number" (integer normalized to number)
    expect(sellDiff!.typeChanges[0]).toMatchObject({ param: "quantity", from: "string", to: "number" });
  });

  it("detects required changes", () => {
    const old = makeBaseline([makeTool("craft", { recipe_id: { type: "string" }, count: { type: "integer" } }, ["recipe_id"])]);
    const current = makeBaseline([makeTool("craft", { recipe_id: { type: "string" }, count: { type: "integer" } }, ["recipe_id", "count"])]);
    const report = diffBaseline(old, current);
    const craftDiff = report.changedTools.find((t) => t.name === "craft");
    expect(craftDiff).toBeDefined();
    expect(craftDiff!.requiredChanges).toContainEqual({ param: "count", from: false, to: true });
  });

  it("no false positives for integer/number normalization", () => {
    // Server switches between "integer" and "number" — should NOT be a type change
    const old = makeBaseline([makeTool("mine", { amount: { type: "integer" } })]);
    const current = makeBaseline([makeTool("mine", { amount: { type: "number" } })]);
    const report = diffBaseline(old, current);
    // No type changes because both normalize to "number"
    const mineDiff = report.changedTools.find((t) => t.name === "mine");
    expect(mineDiff).toBeUndefined();
    expect(isDriftEmpty(report)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatDriftAlert + getDriftSeverity
// ---------------------------------------------------------------------------

describe("formatDriftAlert", () => {
  it("includes game version in message", () => {
    const report: DriftReport = { newTools: ["new_tool"], removedTools: [], changedTools: [] };
    const msg = formatDriftAlert(report, "v0.323");
    expect(msg).toContain("v0.323");
  });

  it("shows correct counts for new tools", () => {
    const report: DriftReport = {
      newTools: ["tool_a", "tool_b", "tool_c"],
      removedTools: [],
      changedTools: [],
    };
    const msg = formatDriftAlert(report, "v1.0");
    expect(msg).toContain("NEW tools (3)");
    expect(msg).toContain("tool_a");
    expect(msg).toContain("tool_b");
  });

  it("shows removed tools in message", () => {
    const report: DriftReport = {
      newTools: [],
      removedTools: ["old_tool"],
      changedTools: [],
    };
    const msg = formatDriftAlert(report, "v1.0");
    expect(msg).toContain("REMOVED tools (1)");
    expect(msg).toContain("old_tool");
  });

  it("includes review instructions", () => {
    const report: DriftReport = { newTools: ["x"], removedTools: [], changedTools: [] };
    const msg = formatDriftAlert(report, "v1.0");
    expect(msg).toContain("Review:");
    expect(msg).toContain("schema-drift.test.ts");
  });
});

describe("getDriftSeverity", () => {
  it("returns 'warning' when removedTools is non-empty", () => {
    const report: DriftReport = { newTools: [], removedTools: ["travel"], changedTools: [] };
    expect(getDriftSeverity(report)).toBe("warning");
  });

  it("returns 'info' for additions-only", () => {
    const report: DriftReport = { newTools: ["new_tool"], removedTools: [], changedTools: [] };
    expect(getDriftSeverity(report)).toBe("info");
  });

  it("returns 'info' for changes-only (no removals)", () => {
    const report: DriftReport = {
      newTools: [],
      removedTools: [],
      changedTools: [{ name: "dock", newParams: ["drone_id"], removedParams: [], typeChanges: [], requiredChanges: [] }],
    };
    expect(getDriftSeverity(report)).toBe("info");
  });

  it("returns 'warning' when both additions and removals exist", () => {
    const report: DriftReport = {
      newTools: ["new_tool"],
      removedTools: ["old_tool"],
      changedTools: [],
    };
    expect(getDriftSeverity(report)).toBe("warning");
  });
});

// ---------------------------------------------------------------------------
// createApiDriftMonitor — unit tests with mocked fetch + alerts
// ---------------------------------------------------------------------------

describe("createApiDriftMonitor", () => {
  let tmpDir: string;
  let savedFetch: typeof global.fetch;
  let mockCreateAlert: ReturnType<typeof spyOn>;
  let mockHasRecentAlert: ReturnType<typeof spyOn>;

  const gameTools = [
    makeTool("mine", { amount: { type: "integer" } }),
    makeTool("travel", { destination_id: { type: "string" } }),
  ];

  function mockFetchSuccess(tools: ServerTool[] = gameTools): void {
    const mockSessionId = "test-session-123";
    let callCount = 0;
    global.fetch = async (_url: string | URL | Request, _init?: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        // initialize
        return new Response(JSON.stringify({ jsonrpc: "2.0", result: { protocolVersion: "2025-03-26" }, id: 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json", "mcp-session-id": mockSessionId },
        });
      } else if (callCount === 2) {
        // notifications/initialized
        return new Response("{}", { status: 200 });
      } else {
        // tools/list
        return new Response(JSON.stringify({ jsonrpc: "2.0", result: { tools }, id: 2 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    };
  }

  function mockFetchFailure(): void {
    global.fetch = async () => {
      throw new Error("Network error");
    };
  }

  function makeDeps(overrides: Partial<Parameters<typeof createApiDriftMonitor>[0]> = {}) {
    return {
      mcpUrl: "https://game.example.com/mcp",
      getGameVersion: () => "v0.323",
      fleetDir: tmpDir,
      ...overrides,
    };
  }

  beforeEach(() => {
    // Create fresh temp dir for each test
    tmpDir = mkdtempSync(join(tmpdir(), "api-drift-test-"));
    mkdirSync(join(tmpDir, "data"), { recursive: true });

    // Save real fetch
    savedFetch = global.fetch;

    // Set up alert spies
    mock.restore();
    mockCreateAlert = spyOn(alertsDb, "createAlert").mockReturnValue(1);
    mockHasRecentAlert = spyOn(alertsDb, "hasRecentAlert").mockReturnValue(false);
  });

  afterEach(() => {
    // Restore real fetch — NOT done by mock.restore()
    global.fetch = savedFetch;

    // Clean up temp dir
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // ---- cold start (no baseline) ----

  it("tick(): captures baseline on first run (no alert)", async () => {
    mockFetchSuccess();
    const monitor = createApiDriftMonitor(makeDeps());

    await monitor.tick();

    // Baseline should be written
    const baseline = readDriftBaseline(tmpDir);
    expect(baseline).not.toBeNull();
    expect(baseline!.tools.map((t) => t.name)).toContain("mine");

    // No alert should be filed on cold start
    expect(mockCreateAlert).not.toHaveBeenCalled();
  });

  // ---- no drift ----

  it("tick(): no alert when baseline matches current server", async () => {
    // Set up a baseline identical to what the server returns
    const baseline = buildBaseline(gameTools, "v0.323");
    writeDriftBaseline(tmpDir, baseline);

    mockFetchSuccess(gameTools);

    const monitor = createApiDriftMonitor(makeDeps());
    await monitor.tick();

    expect(mockCreateAlert).not.toHaveBeenCalled();
  });

  // ---- drift detected ----

  it("tick(): files alert when drift is detected", async () => {
    // Baseline has 2 tools; server now has 3
    const baselineTools = [makeTool("mine"), makeTool("travel")];
    const serverTools = [makeTool("mine"), makeTool("travel"), makeTool("deploy_drone")];

    const baseline = buildBaseline(baselineTools, "v0.323");
    writeDriftBaseline(tmpDir, baseline);

    mockFetchSuccess(serverTools);

    const monitor = createApiDriftMonitor(makeDeps());
    await monitor.tick();

    expect(mockCreateAlert).toHaveBeenCalledTimes(1);
    const [agent, severity, category, message] = mockCreateAlert.mock.calls[0] as [string, string, string, string];
    expect(agent).toBe("system");
    expect(category).toBe("api-drift");
    expect(severity).toBe("info"); // additions only
    expect(message).toContain("deploy_drone");
  });

  it("tick(): severity is 'warning' when tools are removed", async () => {
    const baselineTools = [makeTool("mine"), makeTool("travel"), makeTool("old_tool")];
    const serverTools = [makeTool("mine"), makeTool("travel")];

    writeDriftBaseline(tmpDir, buildBaseline(baselineTools, "v0.323"));
    mockFetchSuccess(serverTools);

    const monitor = createApiDriftMonitor(makeDeps());
    await monitor.tick();

    const [, severity] = mockCreateAlert.mock.calls[0] as [string, string, string, string];
    expect(severity).toBe("warning");
  });

  // ---- dedup ----

  it("tick(): respects hasRecentAlert dedup — does NOT call createAlert twice within 6h window", async () => {
    const baselineTools = [makeTool("mine")];
    const serverTools = [makeTool("mine"), makeTool("new_tool")];

    writeDriftBaseline(tmpDir, buildBaseline(baselineTools, "v0.323"));

    // First tick: no recent alert
    mockFetchSuccess(serverTools);
    mockHasRecentAlert.mockReturnValue(false);
    const monitor = createApiDriftMonitor(makeDeps());
    await monitor.tick();
    expect(mockCreateAlert).toHaveBeenCalledTimes(1);

    // Second tick: dedup window active
    mockFetchSuccess(serverTools);
    mockHasRecentAlert.mockReturnValue(true);
    await monitor.tick();
    // Still only 1 alert total — second tick was suppressed
    expect(mockCreateAlert).toHaveBeenCalledTimes(1);
  });

  // ---- server unreachable ----

  it("tick(): skips gracefully when game server unreachable (no alert)", async () => {
    mockFetchFailure();
    const monitor = createApiDriftMonitor(makeDeps());
    // Should not throw
    await expect(monitor.tick()).resolves.toBeUndefined();
    expect(mockCreateAlert).not.toHaveBeenCalled();
  });

  // ---- forceCheck bypasses dedup ----

  it("forceCheck(): bypasses dedup and always calls createAlert if drift exists", async () => {
    const baselineTools = [makeTool("mine")];
    const serverTools = [makeTool("mine"), makeTool("new_tool")];

    writeDriftBaseline(tmpDir, buildBaseline(baselineTools, "v0.323"));

    // Set dedup to say "yes, there's a recent alert"
    mockHasRecentAlert.mockReturnValue(true);

    mockFetchSuccess(serverTools);
    const monitor = createApiDriftMonitor(makeDeps());

    await monitor.forceCheck();

    // Alert should be filed even though hasRecentAlert returned true
    expect(mockCreateAlert).toHaveBeenCalledTimes(1);
  });

  // ---- acceptBaseline ----

  it("acceptBaseline(): updates baseline file; subsequent tick sees no drift", async () => {
    const baselineTools = [makeTool("mine")];
    const serverTools = [makeTool("mine"), makeTool("new_tool")];

    writeDriftBaseline(tmpDir, buildBaseline(baselineTools, "v0.323"));

    mockFetchSuccess(serverTools);
    const monitor = createApiDriftMonitor(makeDeps());

    // First tick should detect drift (loads pending server tools)
    await monitor.tick();
    expect(mockCreateAlert).toHaveBeenCalledTimes(1);

    // Accept the baseline — updates stored baseline to current server state
    monitor.acceptBaseline();
    mockCreateAlert.mockClear();

    // Verify the file was updated
    const updatedBaseline = readDriftBaseline(tmpDir);
    expect(updatedBaseline!.tools.map((t) => t.name)).toContain("new_tool");

    // Second tick with same server tools: no more drift
    mockFetchSuccess(serverTools);
    mockHasRecentAlert.mockReturnValue(false);
    await monitor.tick();
    expect(mockCreateAlert).not.toHaveBeenCalled();
  });

  // ---- onDrift callback ----

  it("calls onDrift callback when drift is detected", async () => {
    const baselineTools = [makeTool("mine")];
    const serverTools = [makeTool("mine"), makeTool("new_tool")];

    writeDriftBaseline(tmpDir, buildBaseline(baselineTools, "v0.323"));
    mockFetchSuccess(serverTools);

    const driftReports: DriftReport[] = [];
    const monitor = createApiDriftMonitor(makeDeps({ onDrift: (r) => driftReports.push(r) }));

    await monitor.tick();

    expect(driftReports).toHaveLength(1);
    expect(driftReports[0].newTools).toContain("new_tool");
  });

  // ---- getLastReport ----

  it("getLastReport() returns null before any tick", () => {
    mockFetchSuccess();
    const monitor = createApiDriftMonitor(makeDeps());
    expect(monitor.getLastReport()).toBeNull();
  });

  it("getLastReport() returns the last report after a drift tick", async () => {
    const baselineTools = [makeTool("mine")];
    const serverTools = [makeTool("mine"), makeTool("new_tool")];

    writeDriftBaseline(tmpDir, buildBaseline(baselineTools, "v0.323"));
    mockFetchSuccess(serverTools);

    const monitor = createApiDriftMonitor(makeDeps());
    await monitor.tick();

    const report = monitor.getLastReport();
    expect(report).not.toBeNull();
    expect(report!.newTools).toContain("new_tool");
  });

  // ---- getCurrentBaseline ----

  it("getCurrentBaseline() returns null when no baseline exists on disk", () => {
    // Don't write a baseline, don't run any tick
    mockFetchSuccess();
    const monitor = createApiDriftMonitor(makeDeps());
    expect(monitor.getCurrentBaseline()).toBeNull();
  });

  it("getCurrentBaseline() returns the stored baseline after cold start", async () => {
    mockFetchSuccess(gameTools);
    const monitor = createApiDriftMonitor(makeDeps());
    await monitor.tick();
    const baseline = monitor.getCurrentBaseline();
    expect(baseline).not.toBeNull();
    expect(baseline!.tools.map((t) => t.name)).toContain("mine");
  });
});

// ---------------------------------------------------------------------------
// readDriftBaseline / writeDriftBaseline
// ---------------------------------------------------------------------------

describe("readDriftBaseline / writeDriftBaseline", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "api-drift-io-test-"));
    mkdirSync(join(tmpDir, "data"), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("returns null when file does not exist", () => {
    expect(readDriftBaseline(tmpDir)).toBeNull();
  });

  it("round-trips a baseline through write/read", () => {
    const tools = [makeTool("mine", { amount: { type: "integer" } })];
    const baseline = buildBaseline(tools, "v1.2.3");
    writeDriftBaseline(tmpDir, baseline);
    const read = readDriftBaseline(tmpDir);
    expect(read).not.toBeNull();
    expect(read!.version).toBe("v1.2.3");
    expect(read!.tools[0].name).toBe("mine");
  });
});
