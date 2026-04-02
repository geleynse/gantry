/**
 * Document tools: diary, notes, reports, and memory search.
 * All stored in fleet-web SQLite — no game server interaction.
 */
import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GantryConfig } from "../config.js";
import { createLogger } from "../lib/logger.js";
import { textResult, type McpTextResult } from "./passthrough-handler.js";

const log = createLogger("doc-tools");
import { addDiaryEntry, getRecentDiary, getNote, upsertNote, appendNote, searchAgentMemory, searchFleetMemory, updateImportance } from "../services/notes-db.js";
import { sanitizeStrategyContent } from "./strategy-sanitizer.js";
import { parseReport } from "../services/report-parser.js";
import { createOrder } from "../services/comms-db.js";
import { queryAll } from "../services/database.js";
import { createAlert } from "../services/alerts-db.js";

/**
 * Check text for contamination words (hallucinations).
 * Special handling: "Sync" (capitalized) is whitelisted as a system name,
 * so only lowercase "sync" in contamination context is flagged.
 */
function findContaminationWords(text: string, contaminationWords: string[]): string[] {
  const lower = text.toLowerCase();
  return contaminationWords.filter((w) => {
    if (!lower.includes(w)) return false;
    // Whitelist: Allow "sync" contamination word if text contains "Sync" (capitalized system name).
    // Agents writing about the Sync system should use the capitalized form.
    if (w === "sync" && /\bSync\b/.test(text)) {
      return false;
    }
    return true;
  });
}

/**
 * Generate a helpful hint based on contamination pattern detected.
 * Helps agents understand WHY a word is forbidden and what to write instead.
 */

interface ContaminationRule {
  patterns: (string | RegExp)[];
  hint: string;
}

const CONTAMINATION_RULES: ContaminationRule[] = [
  {
    patterns: ["queue", "deadlock", "async", "lock", "backend"],
    hint: "Systems like queues and deadlocks don't exist in this game.",
  },
  {
    patterns: ["frozen", "stuck", "corrupted", "cache"],
    hint: "Servers and caches don't fail in this game. If you can't move, describe what actually happens instead.",
  },
  {
    patterns: ["somehow", "must be", "perhaps", "seems like", "possibly", "mysterious", "unexplained"],
    hint: "Use facts, not speculation. Describe what you see, not what you think might be happening behind the scenes.",
  },
  {
    patterns: ["sabotage", "intentional", "conspiracy", "deliberately"],
    hint: "No sabotage or conspiracies exist. Only report failures you directly observe.",
  },
  {
    patterns: ["endless", "infinite", "perpetual", "constant", "keeps failing"],
    hint: "Game actions complete or fail once—never loop forever. One failure is acceptable; perpetual failures are hallucinated.",
  },
];

const CONTAMINATION_DEFAULT_HINT = "Describe only what you directly observe in the game.";

function getContaminationHint(foundWords: string[]): string {
  if (!foundWords || foundWords.length === 0) return "";

  const word = foundWords[0].toLowerCase();

  for (const rule of CONTAMINATION_RULES) {
    const matched = rule.patterns.some((p) =>
      p instanceof RegExp ? p.test(word) : word.includes(p)
    );
    if (matched) return rule.hint;
  }

  return CONTAMINATION_DEFAULT_HINT;
}

export interface ToolCallRow {
  tool_name: string;
  args_summary: string | null;
  result_summary: string | null;
  success: number;
  error_code: string | null;
  duration_ms: number | null;
  timestamp: string;
}

export function handleCreateAlert(
  agentName: string,
  sessionId: string | undefined,
  severity: string,
  category: string | undefined,
  message: string,
  sessionAlertCounts: Map<string, number>,
  db: DatabaseAdapter = defaultDatabaseAdapter,
): { status: string; id: number; agent: string; severity: string } | { error: string } {
  const key = sessionId ?? agentName;
  const count = sessionAlertCounts.get(key) ?? 0;
  if (count >= 5) {
    return { error: "Alert rate limit reached (5 per session). Alerts are for important operator attention only." };
  }
  try {
    const id = db.createAlert(agentName, severity, category ?? null, message);
    sessionAlertCounts.set(key, count + 1);
    log.info(`[${agentName}] created alert id=${id} severity=${severity}`);

    // Push notification for warning/error/critical alerts
    if (severity !== "info") {
      const webhookUrl = process.env.WATCHDOG_WEBHOOK_URL;
      if (webhookUrl) {
        fetch(webhookUrl, {
          method: "POST",
          headers: {
            "Title": `Fleet Alert: ${agentName}`,
            "Priority": severity === "critical" ? "urgent" : severity === "error" ? "high" : "default",
            "Tags": severity === "critical" ? "rotating_light" : "warning",
          },
          body: `[${severity.toUpperCase()}] ${agentName}: ${message}`,
        }).catch((err) => {
          log.warn("alert webhook failed", { error: String(err) });
        });
      }
    }

    return { status: "created", id, agent: agentName, severity };
  } catch {
    return { error: "failed to create alert" };
  }
}

// Database adapter interface for dependency injection in tests
export interface DatabaseAdapter {
  addDiaryEntry: (agent: string, entry: string, importance?: number) => number;
  getRecentDiary: (agent: string, count?: number) => { id: number; entry: string; importance: number; created_at: string }[];
  getNote: (agent: string, noteType: string) => string | null;
  upsertNote: (agent: string, noteType: string, content: string, importance?: number) => void;
  appendNote: (agent: string, noteType: string, content: string) => void;
  searchAgentMemory: (agent: string, query: string, limit?: number) => unknown[];
  searchFleetMemory: (query: string, limit?: number, targetAgent?: string) => unknown[];
  updateImportance: (table: "diary" | "docs", id: number, importance: number) => boolean;
queryToolCalls: (agent: string, excludeTool: string, count: number) => ToolCallRow[];
createAlert: (agent: string, severity: string, category: string | null, message: string) => number;
}

// Default database adapter uses the real database functions
const defaultDatabaseAdapter: DatabaseAdapter = {
  addDiaryEntry,
  getRecentDiary,
  getNote,
  upsertNote,
  appendNote,
  searchAgentMemory,
  searchFleetMemory,
  updateImportance,
queryToolCalls(agent: string, excludeTool: string, count: number): ToolCallRow[] {
    return queryAll<ToolCallRow>(
      `SELECT tool_name, args_summary, result_summary, success, error_code, duration_ms, timestamp
       FROM proxy_tool_calls
       WHERE agent = ? AND tool_name != ?
       ORDER BY timestamp DESC
       LIMIT ?`,
      agent, excludeTool, count,
    );
  },
createAlert,
};

export interface DocToolDeps {
  mcpServer: McpServer;
  registeredTools: string[];
  config: GantryConfig;
  getAgentForSession: (sessionId?: string) => string | undefined;
  withInjections: (agentName: string, response: McpTextResult) => Promise<McpTextResult>;
  contaminationWords: string[];
  db?: DatabaseAdapter;
}

// ── Pure handler functions ────────────────────────────────────────────────────
// These contain the business logic without MCP/session concerns.
// v2 callers map their generic param names to the v1 (semantic) names before calling.

export function handleWriteDiary(
  agentName: string,
  entry: string,
  contaminationWords: string[],
  db: DatabaseAdapter = defaultDatabaseAdapter,
  importance?: number,
): { status: string; id: number; importance: number } | { error: string } {
  const found = findContaminationWords(entry, contaminationWords);
  if (found.length > 0) {
    log.info(`[${agentName}] blocked write_diary: contamination words found: ${found.join(", ")}`);
    const hint = getContaminationHint(found);
    return { error: `Diary entry rejected — contains hallucination (${found[0]}). ${hint}` };
  }

  try {
    const id = db.addDiaryEntry(agentName, entry, importance);
    // Retrieve actual stored importance (may be auto-scored)
    const entries = db.getRecentDiary(agentName, 1);
    const storedImportance = entries.find(e => e.id === id)?.importance ?? 0;
    return { status: "saved", id, importance: storedImportance };
  } catch {
    return { error: "failed to save diary entry" };
  }
}

export function handleReadDiary(
  agentName: string,
  count: number,
  db: DatabaseAdapter = defaultDatabaseAdapter,
  contaminationWords: string[] = [],
): { entries: unknown[]; count: number } | { error: string } {
  try {
    // Fetch extra entries in case some are filtered out
    const fetchCount = contaminationWords.length > 0 ? count * 2 : count;
    const raw = db.getRecentDiary(agentName, fetchCount);
    const entries = contaminationWords.length > 0
      ? raw.filter(e => findContaminationWords(e.entry, contaminationWords).length === 0).slice(0, count)
      : raw;
    return { entries, count: entries.length };
  } catch {
    return { error: "failed to read diary" };
  }
}

export function handleWriteDoc(
  agentName: string,
  name: string,
  content: string,
  mode: string,
  contaminationWords: string[],
  db: DatabaseAdapter = defaultDatabaseAdapter,
  importance?: number,
): { status: string; note: string } | { error: string } {
  // For strategy docs: sanitize at line level before contamination word check.
  // This handles Haiku agents that ignore prompt-level cleanup rules and preserve
  // stale lines like "Navigation unstable" across rewrites.
  let sanitizedContent = content;
  if (name === "strategy") {
    const { cleaned, removed } = sanitizeStrategyContent(content);
    if (removed.length > 0) {
      log.info(`[${agentName}] strategy sanitized — stripped ${removed.length} line(s): ${removed.map(l => l.trim()).join(" | ")}`);
      sanitizedContent = cleaned;
    }
  }

  const found = findContaminationWords(sanitizedContent, contaminationWords);
  if (found.length > 0) {
    log.info(`[${agentName}] blocked write_doc(${name}): contamination words found: ${found.join(", ")}`);
    const hint = getContaminationHint(found);
    return { error: `Write rejected — contains hallucination (${found[0]}). ${hint}` };
  }

  try {
    if (mode === "append") {
      db.appendNote(agentName, name, sanitizedContent);
    } else {
      db.upsertNote(agentName, name, sanitizedContent, importance);
    }
    return { status: "saved", note: name };
  } catch {
    return { error: `failed to write ${name}` };
  }
}

export function handleReadDoc(
  agentName: string,
  name: string,
  db: DatabaseAdapter = defaultDatabaseAdapter,
): { note: string; content: string } | { error: string } {
  try {
    const content = db.getNote(agentName, name);
    return { note: name, content: content || "(empty)" };
  } catch {
    return { error: `failed to read ${name}` };
  }
}

export function handleWriteReport(
  agentName: string,
  content: string,
  db: DatabaseAdapter = defaultDatabaseAdapter,
): { status: string } | { error: string } {
  try {
    db.upsertNote(agentName, "report", content);
    // Auto-generate fleet orders from report content
    const parsed = parseReport(agentName, content);
    for (const order of parsed) {
      createOrder({
        message: order.message,
        target_agent: order.target_agent ?? undefined,
        priority: order.priority,
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
      log.info(`[report-pipeline] Auto-created ${order.priority} order from ${agentName}: ${order.type}`);
    }
    return { status: "saved" };
  } catch {
    return { error: "failed to save report" };
  }
}

export function handleSearchMemory(
  agentName: string,
  query: string,
  limit: number,
  targetAgentArg: string | undefined,
  otherAgentNames: string[],
  db: DatabaseAdapter = defaultDatabaseAdapter,
): Record<string, unknown> {
  const targetAgent = targetAgentArg === "all" ? undefined : (targetAgentArg || agentName);
  try {
    let results;
    if (targetAgentArg) {
      // Fleet-wide or cross-agent search
      results = db.searchFleetMemory(query, limit, targetAgent);
    } else {
      // Own memory search
      results = db.searchAgentMemory(agentName, query, limit);
    }
    const data: Record<string, unknown> = { results, query };
    if (targetAgentArg) data.agent = targetAgent ?? "all";
    data.fleet_agents = otherAgentNames;
    return data;
  } catch (err) {
    return { error: `Search error: ${err}` };
  }
}

export function handleRateMemory(
  id: number,
  importance: number,
  table: "diary" | "docs",
  db: DatabaseAdapter = defaultDatabaseAdapter,
): { status: string; id: number; importance: number } | { error: string } {
  if (importance < 0 || importance > 10) {
    return { error: "importance must be between 0 and 10" };
  }
  try {
    const updated = db.updateImportance(table, id, importance);
    if (!updated) {
      return { error: `memory id ${id} not found in ${table}` };
    }
    return { status: "updated", id, importance };
  } catch (err) {
    return { error: `failed to update importance: ${err}` };
  }
}

export function handleDebugLog(
  agentName: string,
  count: number,
  db: DatabaseAdapter = defaultDatabaseAdapter,
): { calls: ToolCallRow[]; count: number } | { error: string } {
  try {
    const calls = db.queryToolCalls(agentName, "debug_log", count);
    return { calls, count: calls.length };
  } catch {
    return { error: "failed to retrieve debug log" };
  }
}

// ── MCP tool registration ─────────────────────────────────────────────────────

export function registerDocTools(deps: DocToolDeps): void {
  const { mcpServer, registeredTools, config, getAgentForSession, contaminationWords, db = defaultDatabaseAdapter } = deps;
  // Per-session alert rate limiter (max 5 per session)
  const sessionAlertCounts = new Map<string, number>();

  mcpServer.registerTool("write_diary", {
    description: "Write a diary entry. Stored permanently — use for session summaries (what you did, credits earned, ore sold).",
    inputSchema: {
      entry: z.string().describe("Diary entry text (3-8 sentences)"),
      importance: z.number().int().min(0).max(10).optional().describe("Importance score 0-10 (0=routine, 5=notable, 10=critical). Auto-scored if omitted."),
    },
  }, async ({ entry, importance }, extra) => {
    const agentName = getAgentForSession(extra.sessionId);
    if (!agentName) return textResult({ error: "not logged in" });
    const result = handleWriteDiary(agentName, entry, contaminationWords, db, importance);
    return textResult(result);
  });
  registeredTools.push("write_diary");

  mcpServer.registerTool("read_diary", {
    description: "Read your recent diary entries. Returns last N entries (default 5).",
    inputSchema: {
      count: z.number().int().min(1).max(50).optional().describe("Number of entries to read (default 5)"),
    },
  }, async ({ count }, extra) => {
    const agentName = getAgentForSession(extra.sessionId);
    if (!agentName) return textResult({ error: "not logged in" });
    const result = handleReadDiary(agentName, count ?? 5, db, contaminationWords);
    return textResult(result);
  });
  registeredTools.push("read_diary");

  mcpServer.registerTool("write_doc", {
    description: "Write a note file (strategy, discoveries, thoughts). Mode: 'overwrite' replaces content, 'append' adds to end.",
    inputSchema: {
      name: z.enum(["strategy", "discoveries", "thoughts"]).describe("Note type"),
      content: z.string().describe("Note content"),
      mode: z.enum(["overwrite", "append"]).optional().describe("Write mode (default: overwrite)"),
      importance: z.number().int().min(0).max(10).optional().describe("Importance score 0-10. Auto-scored if omitted."),
    },
  }, async ({ name, content, mode, importance }, extra) => {
    const agentName = getAgentForSession(extra.sessionId);
    if (!agentName) return textResult({ error: "not logged in" });
    const result = handleWriteDoc(agentName, name, content, mode ?? "overwrite", contaminationWords, db, importance);
    return textResult(result);
  });
  registeredTools.push("write_doc");

  mcpServer.registerTool("read_doc", {
    description: "Read one of your note files (strategy, discoveries, thoughts).",
    inputSchema: {
      name: z.enum(["strategy", "discoveries", "thoughts"]).describe("Note type"),
    },
  }, async ({ name }, extra) => {
    const agentName = getAgentForSession(extra.sessionId);
    if (!agentName) return textResult({ error: "not logged in" });
    const result = handleReadDoc(agentName, name, db);
    return textResult(result);
  });
  registeredTools.push("read_doc");

  mcpServer.registerTool("write_report", {
    description: "Write a comms report for the fleet. Visible to all agents and the operator.",
    inputSchema: {
      content: z.string().describe("Report content"),
    },
  }, async ({ content }, extra) => {
    const agentName = getAgentForSession(extra.sessionId);
    if (!agentName) return textResult({ error: "not logged in" });
    const result = handleWriteReport(agentName, content, db);
    return textResult(result);
  });
  registeredTools.push("write_report");

  mcpServer.registerTool("search_memory", {
    description: "Search diary and notes for past entries matching a keyword. Omit agent to search your own memory. Set agent to another agent's name to search theirs (read-only). Results ordered by importance score descending.",
    inputSchema: {
      query: z.string().describe("Search keyword or phrase"),
      limit: z.number().optional().describe("Max results (default 20)"),
      agent: z.string().optional().describe("Agent name to search (omit for your own, 'all' for fleet-wide)"),
    },
  }, async ({ query, limit, agent }, extra) => {
    const agentName = getAgentForSession(extra.sessionId);
    if (!agentName) return textResult({ error: "not logged in" });
    const otherAgents = config.agents.map(a => a.name).filter(n => n !== agentName);
    const result = handleSearchMemory(agentName, query, limit ?? 20, agent, otherAgents, db);
    return textResult(result);
  });
  registeredTools.push("search_memory");

  mcpServer.registerTool("rate_memory", {
    description: "Retroactively set the importance score of a diary entry or doc by its ID. Use after reflecting on which memories were most useful.",
    inputSchema: {
      id: z.number().int().describe("Memory ID (from diary entry or doc)"),
      importance: z.number().int().min(0).max(10).describe("Importance score 0-10 (0=routine, 5=notable, 10=critical lesson)"),
      table: z.enum(["diary", "docs"]).optional().describe("Which table to update (default: diary)"),
    },
  }, async ({ id, importance, table }, extra) => {
    const agentName = getAgentForSession(extra.sessionId);
    if (!agentName) return textResult({ error: "not logged in" });
    const result = handleRateMemory(id, importance, table ?? "diary", db);
    return textResult(result);
  });
  registeredTools.push("rate_memory");

mcpServer.registerTool("debug_log", {
    description: "View your last N raw game server tool calls and responses. Use to diagnose unexpected results or repeated failures.",
    inputSchema: {
      count: z.number().int().min(1).max(20).optional().describe("Number of recent calls to show (default 5, max 20)"),
    },
  }, async ({ count }, extra) => {
    const agentName = getAgentForSession(extra.sessionId);
    if (!agentName) return textResult({ error: "not logged in" });
    const result = handleDebugLog(agentName, count ?? 5, db);
    return textResult(result);
  });
  registeredTools.push("debug_log");
mcpServer.registerTool("create_alert", {
    description: "Create an alert for the operator. Use only for important issues requiring human attention (errors, stuck state, critical findings). Limited to 5 per session.",
    inputSchema: {
      severity: z.enum(["info", "warning", "error", "critical"]).describe("Alert severity"),
      message: z.string().describe("Alert message describing the issue"),
      category: z.string().optional().describe("Optional category (e.g. 'navigation', 'trade', 'combat')"),
    },
  }, async ({ severity, message, category }, extra) => {
    const agentName = getAgentForSession(extra.sessionId);
    if (!agentName) return textResult({ error: "not logged in" });
    const result = handleCreateAlert(agentName, extra.sessionId, severity, category, message, sessionAlertCounts, db);
    return textResult(result);
  });
  registeredTools.push("create_alert");
}
