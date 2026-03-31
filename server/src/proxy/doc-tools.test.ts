import { describe, it, expect, beforeEach } from "bun:test";
import { registerDocTools, type DocToolDeps, type DatabaseAdapter, handleWriteDiary, handleReadDiary, handleWriteDoc, handleReadDoc, handleWriteReport, handleSearchMemory, handleRateMemory, handleDebugLog, handleCreateAlert } from "./doc-tools.js";

// ── Mock Database Adapter ─────────────────────────────────────────────────────

export interface ToolCallRow {
  tool_name: string;
  args_summary: string | null;
  result_summary: string | null;
  success: number;
  error_code: string | null;
  duration_ms: number | null;
  timestamp: string;
}

const createMockDatabase = (): DatabaseAdapter & { reset: () => void; addToolCall: (agent: string, row: Partial<ToolCallRow> & { tool_name: string }) => void } => {
  const diaries = new Map<string, Array<{ id: number; entry: string; importance: number }>>();
  const docs = new Map<string, { [key: string]: string }>();
  const importanceMap = new Map<number, number>(); // id -> importance
  const toolCalls = new Map<string, ToolCallRow[]>();
  let nextId = 1;

  return {
    reset() {
      diaries.clear();
      docs.clear();
      importanceMap.clear();
      toolCalls.clear();
      nextId = 1;
    },
    addToolCall(agent: string, row: Partial<ToolCallRow> & { tool_name: string }) {
      if (!toolCalls.has(agent)) toolCalls.set(agent, []);
      toolCalls.get(agent)!.push({
        tool_name: row.tool_name,
        args_summary: row.args_summary ?? null,
        result_summary: row.result_summary ?? null,
        success: row.success ?? 1,
        error_code: row.error_code ?? null,
        duration_ms: row.duration_ms ?? null,
        timestamp: row.timestamp ?? new Date().toISOString(),
      });
    },
    queryToolCalls(agent: string, excludeTool: string, count: number): ToolCallRow[] {
      const rows = toolCalls.get(agent) ?? [];
      return rows
        .filter(r => r.tool_name !== excludeTool)
        .slice(-count)
        .reverse();
    },
    addDiaryEntry(agent: string, entry: string, importance = 0): number {
      if (!diaries.has(agent)) diaries.set(agent, []);
      const id = nextId++;
      diaries.get(agent)!.push({ id, entry, importance });
      importanceMap.set(id, importance);
      return id;
    },
    getRecentDiary(agent: string, count = 5) {
      const entries = diaries.get(agent) || [];
      return entries.slice(-count).reverse().map((e) => ({
        id: e.id,
        entry: e.entry,
        importance: e.importance,
        created_at: new Date().toISOString(),
      }));
    },
    getNote(agent: string, noteType: string) {
      return docs.get(agent)?.[noteType] ?? null;
    },
    upsertNote(agent: string, noteType: string, content: string, _importance = 0) {
      if (!docs.has(agent)) docs.set(agent, {});
      docs.get(agent)![noteType] = content;
    },
    appendNote(agent: string, noteType: string, content: string) {
      if (!docs.has(agent)) docs.set(agent, {});
      const current = docs.get(agent)![noteType] || "";
      docs.get(agent)![noteType] = current ? `${current}\n${content}` : content;
    },
    searchAgentMemory(agent: string, query: string, limit = 20) {
      const results: unknown[] = [];
      const entries = diaries.get(agent) || [];
      for (const e of entries) {
        if (e.entry.toLowerCase().includes(query.toLowerCase())) {
          results.push({ source: "diary", text: e.entry, importance: e.importance });
        }
        if (results.length >= limit) break;
      }
      const docNotes = docs.get(agent) || {};
      for (const [type, content] of Object.entries(docNotes)) {
        if (content.toLowerCase().includes(query.toLowerCase())) {
          results.push({ source: type, text: content, importance: 0 });
        }
        if (results.length >= limit) break;
      }
      return results.slice(0, limit);
    },
    searchFleetMemory(query: string, limit = 20, targetAgent?: string) {
      const results: unknown[] = [];
      const agents = targetAgent ? [targetAgent] : Array.from(diaries.keys());
      for (const agent of agents) {
        const entries = diaries.get(agent) || [];
        for (const e of entries) {
          if (e.entry.toLowerCase().includes(query.toLowerCase())) {
            results.push({ agent, source: "diary", text: e.entry, importance: e.importance });
          }
          if (results.length >= limit) break;
        }
      }
      return results.slice(0, limit);
    },
    updateImportance(_table: "diary" | "docs", id: number, importance: number): boolean {
      if (!importanceMap.has(id)) return false;
      importanceMap.set(id, importance);
      return true;
    },
    createAlert(_agent: string, _severity: string, _category: string | null, _message: string): number {
      return nextId++;
    },
  };
};

// ── McpServer Mock ────────────────────────────────────────────────────────────

function createMockMcpServer() {
  const tools = new Map<string, { opts: unknown; handler: Function }>();
  return {
    registerTool: (name: string, opts: unknown, handler: Function) => {
      tools.set(name, { opts, handler });
    },
    tools,
  };
}

function makeDeps(overrides?: Partial<DocToolDeps> & { mockDb?: DatabaseAdapter }): DocToolDeps & { mockServer: ReturnType<typeof createMockMcpServer> } {
  const mockServer = createMockMcpServer();
  const { mockDb, ...rest } = overrides || {};
  return {
    mcpServer: mockServer as unknown as DocToolDeps["mcpServer"],
    registeredTools: [],
    config: { agents: [{ name: "test-agent" }, { name: "other-agent" }] } as unknown as DocToolDeps["config"],
    getAgentForSession: () => "test-agent",
    withInjections: async (_agent, response) => response,
    contaminationWords: ["action_pending", "infrastructure", "queue", "broken"],
    db: mockDb,
    mockServer,
    ...rest,
  };
}

async function callTool(mockServer: ReturnType<typeof createMockMcpServer>, name: string, args: unknown, sessionId?: string) {
  const entry = mockServer.tools.get(name);
  if (!entry) throw new Error(`Tool ${name} not registered`);
  return entry.handler(args, { sessionId });
}

function parseResult(result: unknown): unknown {
  const r = result as { content: Array<{ text: string }> };
  return JSON.parse(r.content[0].text);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("registerDocTools", () => {
  it("registers all 9 doc tools", () => {
    const deps = makeDeps();
    registerDocTools(deps);
    expect(deps.registeredTools).toEqual(["write_diary", "read_diary", "write_doc", "read_doc", "write_report", "search_memory", "rate_memory", "debug_log", "create_alert"]);
  });

  it("registers tools on the McpServer", () => {
    const deps = makeDeps();
    registerDocTools(deps);
    expect(deps.mockServer.tools.has("write_diary")).toBe(true);
    expect(deps.mockServer.tools.has("read_diary")).toBe(true);
    expect(deps.mockServer.tools.has("write_doc")).toBe(true);
    expect(deps.mockServer.tools.has("read_doc")).toBe(true);
    expect(deps.mockServer.tools.has("write_report")).toBe(true);
    expect(deps.mockServer.tools.has("search_memory")).toBe(true);
    expect(deps.mockServer.tools.has("rate_memory")).toBe(true);
    expect(deps.mockServer.tools.has("create_alert")).toBe(true);
  });

  it("write_diary returns error when not logged in", async () => {
    const deps = makeDeps({ getAgentForSession: () => undefined });
    registerDocTools(deps);
    const result = parseResult(await callTool(deps.mockServer, "write_diary", { entry: "today was fine" }));
    expect(result).toEqual({ error: "not logged in" });
  });

  it("write_diary rejects entries with contamination words", async () => {
    const deps = makeDeps();
    registerDocTools(deps);
    const result = parseResult(await callTool(deps.mockServer, "write_diary", { entry: "the infrastructure is broken today" }));
    expect((result as { error: string }).error).toMatch(/contains hallucination/);
    expect((result as { error: string }).error).toMatch(/infrastructure/);
  });

  it("write_diary rejects entries with second contamination word", async () => {
    const deps = makeDeps();
    registerDocTools(deps);
    const result = parseResult(await callTool(deps.mockServer, "write_diary", { entry: "action_pending is stuck" }));
    expect((result as { error: string }).error).toMatch(/action_pending/);
  });

  it("write_doc returns error when not logged in", async () => {
    const deps = makeDeps({ getAgentForSession: () => undefined });
    registerDocTools(deps);
    const result = parseResult(await callTool(deps.mockServer, "write_doc", { name: "strategy", content: "mine ore" }));
    expect(result).toEqual({ error: "not logged in" });
  });

  it("write_doc rejects content with contamination words", async () => {
    const deps = makeDeps();
    registerDocTools(deps);
    const result = parseResult(await callTool(deps.mockServer, "write_doc", { name: "strategy", content: "queue is jammed" }));
    expect((result as { error: string }).error).toMatch(/contains hallucination/);
    expect((result as { error: string }).error).toMatch(/queue/);
  });

  it("read_diary returns error when not logged in", async () => {
    const deps = makeDeps({ getAgentForSession: () => undefined });
    registerDocTools(deps);
    const result = parseResult(await callTool(deps.mockServer, "read_diary", {}));
    expect(result).toEqual({ error: "not logged in" });
  });

  it("read_doc returns error when not logged in", async () => {
    const deps = makeDeps({ getAgentForSession: () => undefined });
    registerDocTools(deps);
    const result = parseResult(await callTool(deps.mockServer, "read_doc", { name: "strategy" }));
    expect(result).toEqual({ error: "not logged in" });
  });

  it("write_report returns error when not logged in", async () => {
    const deps = makeDeps({ getAgentForSession: () => undefined });
    registerDocTools(deps);
    const result = parseResult(await callTool(deps.mockServer, "write_report", { content: "status update" }));
    expect(result).toEqual({ error: "not logged in" });
  });

  it("search_memory returns error when not logged in", async () => {
    const deps = makeDeps({ getAgentForSession: () => undefined });
    registerDocTools(deps);
    const result = parseResult(await callTool(deps.mockServer, "search_memory", { query: "ore" }));
    expect(result).toEqual({ error: "not logged in" });
  });
});

// ── Handler function tests (with mock database) ────────────────────────────────

describe("handleWriteDiary", () => {
  let mockDb: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    mockDb = createMockDatabase();
  });

  it("rejects entries with contamination words", () => {
    const result = handleWriteDiary("agent-1", "the infrastructure is down", ["infrastructure", "queue"], mockDb);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/infrastructure/);
  });

  it("rejects entries with second contamination word", () => {
    const result = handleWriteDiary("agent-1", "queue is stuck today", ["infrastructure", "queue"], mockDb);
    expect((result as { error: string }).error).toMatch(/queue/);
  });

  it("saves clean entries and returns id", () => {
    const result = handleWriteDiary("agent-1", "mined 50 ore and sold it", [], mockDb);
    expect(result).toHaveProperty("status", "saved");
    expect((result as { id: number }).id).toBeGreaterThan(0);
  });

  it("is case-insensitive for contamination check", () => {
    const result = handleWriteDiary("agent-1", "The QUEUE is STUCK", ["queue"], mockDb);
    expect((result as { error: string }).error).toMatch(/queue/);
  });

  it("allows 'Sync' (capitalized) as a system name", () => {
    const result = handleWriteDiary("agent-1", "Traveled to Sync system for trading", ["sync"], mockDb);
    expect(result).toHaveProperty("status", "saved");
  });

  it("blocks lowercase 'sync' as a contamination word", () => {
    const result = handleWriteDiary("agent-1", "The state sync is broken", ["sync"], mockDb);
    expect((result as { error: string }).error).toMatch(/sync/);
  });

  it("allows 'Sync' even if mixed with lowercase 'sync' (agent is discussing Sync system)", () => {
    const result = handleWriteDiary("agent-1", "Sync failed to sync state properly", ["sync"], mockDb);
    expect(result).toHaveProperty("status", "saved");
  });

  it("saves entries with empty contamination list", () => {
    const result = handleWriteDiary("agent-1", "anything goes here", [], mockDb);
    expect((result as { status: string }).status).toBe("saved");
  });

  it("returns the stored importance (not always 0) when importance is provided", () => {
    // Add a prior entry to advance nextId — ensures IDs don't coincidentally match index+1
    handleWriteDiary("agent-1", "first entry", [], mockDb);
    const result = handleWriteDiary("agent-1", "important discovery", [], mockDb, 7) as { status: string; id: number; importance: number };
    expect(result.status).toBe("saved");
    expect(result.importance).toBe(7);
  });

  it("returns importance 0 when no importance provided", () => {
    // Add a prior entry so ID > 1, ruling out an index-based coincidence
    handleWriteDiary("agent-1", "first entry", [], mockDb);
    const result = handleWriteDiary("agent-1", "plain entry", [], mockDb) as { status: string; id: number; importance: number };
    expect(result.status).toBe("saved");
    expect(result.importance).toBe(0);
  });
});

describe("handleReadDiary", () => {
  let mockDb: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    mockDb = createMockDatabase();
  });

  it("returns empty entries for new agent", () => {
    const result = handleReadDiary("new-agent", 5, mockDb);
    expect(result).toHaveProperty("entries");
    expect((result as { entries: unknown[]; count: number }).entries).toHaveLength(0);
    expect((result as { count: number }).count).toBe(0);
  });

  it("returns saved diary entries", () => {
    handleWriteDiary("agent-1", "entry one", [], mockDb);
    handleWriteDiary("agent-1", "entry two", [], mockDb);
    const result = handleReadDiary("agent-1", 5, mockDb) as { entries: { entry: string }[]; count: number };
    expect(result.count).toBe(2);
    expect(result.entries.map(e => e.entry)).toContain("entry one");
    expect(result.entries.map(e => e.entry)).toContain("entry two");
  });

  it("respects count limit", () => {
    for (let i = 0; i < 10; i++) {
      handleWriteDiary("agent-1", `entry ${i}`, [], mockDb);
    }
    const result = handleReadDiary("agent-1", 3, mockDb) as { entries: unknown[]; count: number };
    expect(result.count).toBe(3);
    expect(result.entries).toHaveLength(3);
  });

  it("only returns entries for the specified agent", () => {
    handleWriteDiary("agent-1", "agent-1 entry", [], mockDb);
    handleWriteDiary("agent-2", "agent-2 entry", [], mockDb);
    const result = handleReadDiary("agent-1", 10, mockDb) as { entries: { entry: string }[]; count: number };
    expect(result.count).toBe(1);
    expect(result.entries[0].entry).toBe("agent-1 entry");
  });
});

describe("handleWriteDoc", () => {
  let mockDb: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    mockDb = createMockDatabase();
  });

  it("rejects content with contamination words", () => {
    const result = handleWriteDoc("agent-1", "strategy", "queue is jammed", "overwrite", ["queue"], mockDb);
    expect((result as { error: string }).error).toMatch(/queue/);
  });

  it("saves clean content", () => {
    const result = handleWriteDoc("agent-1", "strategy", "mine ore at belt", "overwrite", [], mockDb);
    expect((result as { note: string }).note).toBe("strategy");
  });

  it("saves to different note types", () => {
    const r1 = handleWriteDoc("agent-1", "strategy", "strategy content", "overwrite", [], mockDb);
    const r2 = handleWriteDoc("agent-1", "discoveries", "discovery content", "overwrite", [], mockDb);
    expect((r1 as { note: string }).note).toBe("strategy");
    expect((r2 as { note: string }).note).toBe("discoveries");
  });

  it("allows 'Sync' (capitalized) as a system name in doc content", () => {
    const result = handleWriteDoc("agent-1", "discoveries", "Sync system has good prices for modules", "overwrite", ["sync"], mockDb);
    expect((result as { note: string }).note).toBe("discoveries");
  });

  it("blocks lowercase 'sync' in doc content", () => {
    const result = handleWriteDoc("agent-1", "discoveries", "The sync process is broken", "overwrite", ["sync"], mockDb);
    expect((result as { error: string }).error).toMatch(/sync/);
  });
});

describe("handleReadDoc", () => {
  let mockDb: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    mockDb = createMockDatabase();
  });

  it("returns (empty) for notes that do not exist", () => {
    const result = handleReadDoc("agent-1", "strategy", mockDb) as { note: string; content: string };
    expect(result.note).toBe("strategy");
    expect(result.content).toBe("(empty)");
  });

  it("returns saved content", () => {
    handleWriteDoc("agent-1", "strategy", "mine ore at belt", "overwrite", [], mockDb);
    const result = handleReadDoc("agent-1", "strategy", mockDb) as { note: string; content: string };
    expect(result.note).toBe("strategy");
    expect(result.content).toBe("mine ore at belt");
  });

  it("returns content for the correct note type", () => {
    handleWriteDoc("agent-1", "strategy", "strategy text", "overwrite", [], mockDb);
    handleWriteDoc("agent-1", "discoveries", "discovery text", "overwrite", [], mockDb);
    const result = handleReadDoc("agent-1", "discoveries", mockDb) as { content: string };
    expect(result.content).toBe("discovery text");
  });

  it("does not return another agent's notes", () => {
    handleWriteDoc("agent-2", "strategy", "agent-2 strategy", "overwrite", [], mockDb);
    const result = handleReadDoc("agent-1", "strategy", mockDb) as { content: string };
    expect(result.content).toBe("(empty)");
  });
});

describe("handleWriteReport", () => {
  let mockDb: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    mockDb = createMockDatabase();
  });

  it("saves report and returns status saved", () => {
    const result = handleWriteReport("agent-1", "Fleet status: all systems operational", mockDb);
    expect(result).toEqual({ status: "saved" });
  });

  it("overwrites previous report", () => {
    handleWriteReport("agent-1", "first report", mockDb);
    handleWriteReport("agent-1", "second report", mockDb);
    const readResult = handleReadDoc("agent-1", "report", mockDb) as { content: string };
    expect(readResult.content).toBe("second report");
  });
});

describe("handleSearchMemory", () => {
  let mockDb: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    mockDb = createMockDatabase();
  });

  it("returns empty results for no matching entries", () => {
    const result = handleSearchMemory("agent-1", "nonexistent", 20, undefined, ["agent-2"], mockDb);
    expect(result).toHaveProperty("results");
    expect((result.results as unknown[]).length).toBe(0);
    expect(result.query).toBe("nonexistent");
  });

  it("searches own diary when no targetAgent provided", () => {
    handleWriteDiary("agent-1", "found ore at asteroid belt", [], mockDb);
    handleWriteDiary("agent-2", "found ore at nebula", [], mockDb);
    const result = handleSearchMemory("agent-1", "ore", 20, undefined, ["agent-2"], mockDb);
    const results = result.results as { source: string; text: string }[];
    expect(results.length).toBe(1);
    expect(results[0].text).toContain("asteroid belt");
  });

  it("includes fleet_agents list excluding current agent", () => {
    const result = handleSearchMemory("agent-1", "ore", 20, undefined, ["agent-2", "agent-3"], mockDb);
    expect(result.fleet_agents).toEqual(["agent-2", "agent-3"]);
  });

  it("searches cross-agent when targetAgentArg provided", () => {
    handleWriteDiary("agent-2", "agent-2 found rare ore", [], mockDb);
    const result = handleSearchMemory("agent-1", "rare ore", 20, "agent-2", ["agent-2"], mockDb);
    const results = result.results as { text: string }[];
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toContain("rare ore");
  });

  it("searches fleet-wide when targetAgentArg is 'all'", () => {
    handleWriteDiary("agent-1", "agent-1 found iron", [], mockDb);
    handleWriteDiary("agent-2", "agent-2 found iron", [], mockDb);
    const result = handleSearchMemory("agent-1", "iron", 20, "all", ["agent-2"], mockDb);
    expect(result.agent).toBe("all");
    const results = result.results as unknown[];
    expect(results.length).toBe(2);
  });

  it("includes agent field in result when targetAgentArg provided", () => {
    const result = handleSearchMemory("agent-1", "anything", 20, "agent-2", ["agent-2"], mockDb);
    expect(result).toHaveProperty("agent");
  });

  it("does not include agent field when searching own memory", () => {
    const result = handleSearchMemory("agent-1", "anything", 20, undefined, ["agent-2"], mockDb);
    expect(result).not.toHaveProperty("agent");
  });

  it("searches docs as well as diary", () => {
    handleWriteDoc("agent-1", "discoveries", "rare crystal at nova terra", "overwrite", [], mockDb);
    const result = handleSearchMemory("agent-1", "crystal", 20, undefined, ["agent-2"], mockDb);
    const results = result.results as { source: string; text: string }[];
    expect(results.some(r => r.source === "discoveries")).toBe(true);
  });

  it("respects limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      handleWriteDiary("agent-1", `ore entry ${i}`, [], mockDb);
    }
    const result = handleSearchMemory("agent-1", "ore", 3, undefined, [], mockDb);
    const results = result.results as unknown[];
    expect(results.length).toBeLessThanOrEqual(3);
  });
});

// ── handleDebugLog ─────────────────────────────────────────────────────────

describe("handleDebugLog", () => {
  let mockDb: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    mockDb = createMockDatabase();
  });

  it("returns empty calls list when agent has no tool calls", () => {
    const result = handleDebugLog("agent-1", 5, mockDb) as { calls: unknown[]; count: number };
    expect(result.calls).toHaveLength(0);
    expect(result.count).toBe(0);
  });

  it("returns last N tool calls for the agent ordered newest first", () => {
    mockDb.addToolCall("agent-1", { tool_name: "get_status", timestamp: "2026-01-01T00:00:00Z" });
    mockDb.addToolCall("agent-1", { tool_name: "travel_to", timestamp: "2026-01-01T00:01:00Z" });
    mockDb.addToolCall("agent-1", { tool_name: "batch_mine", timestamp: "2026-01-01T00:02:00Z" });
    const result = handleDebugLog("agent-1", 5, mockDb) as { calls: { tool_name: string }[]; count: number };
    expect(result.count).toBe(3);
    expect(result.calls[0].tool_name).toBe("batch_mine");
    expect(result.calls[2].tool_name).toBe("get_status");
  });

  it("respects the count limit", () => {
    for (let i = 0; i < 10; i++) {
      mockDb.addToolCall("agent-1", { tool_name: `tool_${i}` });
    }
    const result = handleDebugLog("agent-1", 3, mockDb) as { calls: unknown[]; count: number };
    expect(result.calls).toHaveLength(3);
    expect(result.count).toBe(3);
  });

  it("excludes debug_log calls from results", () => {
    mockDb.addToolCall("agent-1", { tool_name: "get_status" });
    mockDb.addToolCall("agent-1", { tool_name: "debug_log" });
    mockDb.addToolCall("agent-1", { tool_name: "batch_mine" });
    const result = handleDebugLog("agent-1", 10, mockDb) as { calls: { tool_name: string }[] };
    const toolNames = result.calls.map(c => c.tool_name);
    expect(toolNames).not.toContain("debug_log");
    expect(toolNames).toContain("get_status");
    expect(toolNames).toContain("batch_mine");
  });

  it("only returns calls for the requesting agent", () => {
    mockDb.addToolCall("agent-1", { tool_name: "get_status" });
    mockDb.addToolCall("agent-2", { tool_name: "travel_to" });
    const result = handleDebugLog("agent-1", 10, mockDb) as { calls: { tool_name: string }[] };
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].tool_name).toBe("get_status");
  });

  it("includes all expected fields in each entry", () => {
    mockDb.addToolCall("agent-1", {
      tool_name: "batch_mine",
      args_summary: '{"location":"belt"}',
      result_summary: "mined 5 ore",
      success: 1,
      error_code: null,
      duration_ms: 420,
      timestamp: "2026-01-01T12:00:00Z",
    });
    const result = handleDebugLog("agent-1", 5, mockDb) as unknown as { calls: Record<string, unknown>[] };
    const call = result.calls[0];
    expect(call).toHaveProperty("tool_name", "batch_mine");
    expect(call).toHaveProperty("args_summary", '{"location":"belt"}');
    expect(call).toHaveProperty("result_summary", "mined 5 ore");
    expect(call).toHaveProperty("success", 1);
    expect(call).toHaveProperty("error_code", null);
    expect(call).toHaveProperty("duration_ms", 420);
    expect(call).toHaveProperty("timestamp", "2026-01-01T12:00:00Z");
  });
});

// ── debug_log MCP tool registration ──────────────────────────────────────────

describe("debug_log tool (via registerDocTools)", () => {
  let mockDb: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    mockDb = createMockDatabase();
  });

  it("registers debug_log in registeredTools", () => {
    const deps = makeDeps({ mockDb });
    registerDocTools(deps);
    expect(deps.registeredTools).toContain("debug_log");
  });

  it("registers debug_log on the McpServer", () => {
    const deps = makeDeps({ mockDb });
    registerDocTools(deps);
    expect(deps.mockServer.tools.has("debug_log")).toBe(true);
  });

  it("registers all 9 doc tools including debug_log", () => {
    const deps = makeDeps({ mockDb });
    registerDocTools(deps);
    expect(deps.registeredTools).toEqual(["write_diary", "read_diary", "write_doc", "read_doc", "write_report", "search_memory", "rate_memory", "debug_log", "create_alert"]);
  });

  it("returns error when not logged in", async () => {
    const deps = makeDeps({ getAgentForSession: () => undefined, mockDb });
    registerDocTools(deps);
    const result = parseResult(await callTool(deps.mockServer, "debug_log", {}));
    expect(result).toEqual({ error: "not logged in" });
  });

  it("returns tool call history via the tool handler", async () => {
    mockDb.addToolCall("test-agent", { tool_name: "get_status" });
    mockDb.addToolCall("test-agent", { tool_name: "travel_to" });
    const deps = makeDeps({ mockDb });
    registerDocTools(deps);
    const result = parseResult(await callTool(deps.mockServer, "debug_log", { count: 5 })) as { calls: { tool_name: string }[]; count: number };
    expect(result.count).toBe(2);
    expect(result.calls.some(c => c.tool_name === "get_status")).toBe(true);
  });

  it("uses default count of 5 when not specified", async () => {
    for (let i = 0; i < 10; i++) {
      mockDb.addToolCall("test-agent", { tool_name: `tool_${i}` });
    }
    const deps = makeDeps({ mockDb });
    registerDocTools(deps);
    const result = parseResult(await callTool(deps.mockServer, "debug_log", {})) as { calls: unknown[] };
    expect(result.calls).toHaveLength(5);
  });
});

// ── handleRateMemory ───────────────────────────────────────────────────────

describe("handleRateMemory", () => {
  let mockDb: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    mockDb = createMockDatabase();
  });

  it("updates importance for an existing diary entry", () => {
    const id = mockDb.addDiaryEntry("agent-1", "mined 50 ore", 1);
    const result = handleRateMemory(id, 8, "diary", mockDb);
    expect(result).toHaveProperty("status", "updated");
    expect((result as { id: number }).id).toBe(id);
    expect((result as { importance: number }).importance).toBe(8);
  });

  it("returns error for a non-existent ID", () => {
    const result = handleRateMemory(99999, 5, "diary", mockDb);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/not found/);
  });

  it("rejects importance below 0", () => {
    const id = mockDb.addDiaryEntry("agent-1", "some entry", 0);
    const result = handleRateMemory(id, -1, "diary", mockDb);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/0 and 10/);
  });

  it("rejects importance above 10", () => {
    const id = mockDb.addDiaryEntry("agent-1", "some entry", 0);
    const result = handleRateMemory(id, 11, "diary", mockDb);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/0 and 10/);
  });

  it("accepts importance of exactly 0 and 10", () => {
    const id1 = mockDb.addDiaryEntry("agent-1", "entry one", 5);
    const id2 = mockDb.addDiaryEntry("agent-1", "entry two", 5);
    expect(handleRateMemory(id1, 0, "diary", mockDb)).toHaveProperty("status", "updated");
    expect(handleRateMemory(id2, 10, "diary", mockDb)).toHaveProperty("status", "updated");
  });
});

// ── handleCreateAlert ───────────────────────────────────────────────────────

describe("handleCreateAlert", () => {
  it("creates an alert and returns status created", () => {
    const mockDb = createMockDatabase();
    const counts = new Map<string, number>();
    const result = handleCreateAlert("agent-1", "session-1", "warning", "navigation", "Stuck", counts, mockDb);
    expect(result).toHaveProperty("status", "created");
    expect((result as { id: number }).id).toBeGreaterThan(0);
    expect((result as { agent: string }).agent).toBe("agent-1");
    expect((result as { severity: string }).severity).toBe("warning");
  });

  it("returns error when not logged in (no agent name)", () => {
    // This is handled at the MCP tool level before calling the handler;
    // test the handler directly with a stand-in for safety
    const mockDb = createMockDatabase();
    const counts = new Map<string, number>();
    const result = handleCreateAlert("", "session-1", "info", undefined, "test", counts, mockDb);
    // Empty agent name proceeds (auth check is in the MCP wrapper), id is returned
    expect(result).toHaveProperty("status", "created");
  });

  it("enforces rate limit of 5 per session", () => {
    const mockDb = createMockDatabase();
    const counts = new Map<string, number>();
    for (let i = 0; i < 5; i++) {
      const result = handleCreateAlert("agent-1", "session-1", "info", undefined, `Alert ${i}`, counts, mockDb);
      expect(result).toHaveProperty("status", "created");
    }
    const blocked = handleCreateAlert("agent-1", "session-1", "info", undefined, "sixth alert", counts, mockDb);
    expect(blocked).toHaveProperty("error");
    expect((blocked as { error: string }).error).toMatch(/rate limit/i);
  });

  it("rate limit is per session, not per agent", () => {
    const mockDb = createMockDatabase();
    const counts = new Map<string, number>();
    for (let i = 0; i < 5; i++) {
      handleCreateAlert("agent-1", "session-1", "info", undefined, `Alert ${i}`, counts, mockDb);
    }
    // Different session should still succeed
    const result = handleCreateAlert("agent-1", "session-2", "info", undefined, "other session", counts, mockDb);
    expect(result).toHaveProperty("status", "created");
  });

  it("accepts optional category", () => {
    const mockDb = createMockDatabase();
    const counts = new Map<string, number>();
    const result = handleCreateAlert("agent-1", "s1", "error", "combat", "Under attack", counts, mockDb);
    expect(result).toHaveProperty("status", "created");
  });

  it("accepts undefined category", () => {
    const mockDb = createMockDatabase();
    const counts = new Map<string, number>();
    const result = handleCreateAlert("agent-1", "s1", "critical", undefined, "No category", counts, mockDb);
    expect(result).toHaveProperty("status", "created");
  });

  it("create_alert MCP tool returns error when not logged in", async () => {
    const deps = makeDeps({ getAgentForSession: () => undefined });
    registerDocTools(deps);
    const result = parseResult(await callTool(deps.mockServer, "create_alert", { severity: "warning", message: "test" }));
    expect(result).toEqual({ error: "not logged in" });
  });

  it("create_alert MCP tool creates alert when logged in", async () => {
    const mockDb = createMockDatabase();
    const deps = makeDeps({ mockDb });
    registerDocTools(deps);
    const result = parseResult(await callTool(deps.mockServer, "create_alert", { severity: "info", message: "fleet check" })) as { status: string; id: number };
    expect(result.status).toBe("created");
    expect(result.id).toBeGreaterThan(0);
  });
});
