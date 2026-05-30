/**
 * API Drift Monitor
 *
 * Continuously diffs the game server's MCP tool schemas against a stored
 * baseline and files alerts when tools are added, removed, or changed.
 *
 * Design:
 * - Periodic job (default 1h) using the same anonymous MCP handshake as schema.ts
 * - Baseline stored as JSON in $FLEET_DIR/data/api-drift-baseline.json
 * - Alerts filed via alerts-db createAlert/hasRecentAlert with 6h dedup window
 * - severity "warning" when tools removed (proxy impact), "info" for additions only
 * - Cold start: writes baseline, no alert
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createLogger } from "../lib/logger.js";
import { createAlert, hasRecentAlert } from "./alerts-db.js";

const log = createLogger("api-drift-monitor");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 6-hour dedup window — shorter than 24h because drift that lasts >6h is worth re-alerting. */
const DEDUP_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Category used for alert dedup. */
const ALERT_CATEGORY = "api-drift";

/** Agent name for system-level alerts. */
const ALERT_AGENT = "system";

/**
 * Tools the server exposes but we intentionally don't proxy.
 * Removed tools in this set are not reported as drift (they were never expected).
 * Mirrors the INTENTIONALLY_SKIPPED list in schema-drift.test.ts.
 * TODO: Extract to proxy-constants.ts and import from both places.
 */
export const INTENTIONALLY_SKIPPED = new Set([
  "register", "login", "logout", "get_commands", "get_version", "get_notifications",
  "get_status",
  "set_colors", "set_anonymous", "set_status",
  "read_note", "write_note",
  "v2_get_missions", "v2_get_cargo", "v2_get_ship", "v2_get_state",
  "v2_get_player", "v2_get_queue", "v2_get_skills", "get_state",
  "forum_delete_thread", "forum_delete_reply",
  "deposit_credits", "withdraw_credits",
  "create_faction", "join_faction", "leave_faction",
  "faction_accept_peace", "faction_cancel_mission", "faction_create_buy_order",
  "faction_create_role", "faction_create_sell_order", "faction_declare_war",
  "faction_decline_invite", "faction_delete_role", "faction_delete_room",
  "faction_deposit_credits", "faction_deposit_items", "faction_edit",
  "faction_edit_role", "faction_get_invites", "faction_gift", "faction_info",
  "faction_intel_status", "faction_invite", "faction_kick",
  "faction_list_missions", "faction_post_mission", "faction_promote",
  "faction_propose_peace", "faction_query_trade_intel", "faction_rooms",
  "faction_set_ally", "faction_set_enemy", "faction_submit_intel",
  "faction_submit_trade_intel", "faction_trade_intel_status", "faction_visit_room",
  "faction_withdraw_credits", "faction_withdraw_items", "faction_write_room",
  "faction_query_intel",
  "get_recipes",
  "self_destruct",
  "jettison",
  "buy_ship",
  "shipyard_showroom",
  "faction_build",
  "faction_upgrade",
  "personal_build",
  "types",
  "upgrades",
  "get_action_log",
  "view_completed_mission",
  "facility",
  "distress_signal",
  "completed_missions",
  "view_faction_storage",
  "fleet",
  "name_ship",
  "repair_module",
  "captains_log_get",
  "scrap_ship",
  "get_empire_info",
  "faction_propose_ally",
  "faction_accept_ally",
  "faction_remove_ally",
  "faction_remove_enemy",
  "faction_accept_invite",
  "faction_withdraw_invite",
]);

/** Params the server includes on every tool that we handle at proxy level. */
const IGNORED_PARAMS = new Set(["session_id"]);

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** Raw tool data from the game server including inputSchema. */
export interface ServerTool {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface BaselineParam {
  name: string;
  /** Normalized: "number" covers both "number" and "integer" from the server. */
  type: string;
  required: boolean;
  /** Whether the param has a non-empty description — stored as a flag, not the text. */
  hasDescription: boolean;
}

export interface BaselineTool {
  name: string;
  /** Sorted alphabetically for stable diffs. */
  params: BaselineParam[];
}

export interface ApiDriftBaseline {
  /** Game server version when baseline was captured. */
  version: string;
  /** Epoch ms when baseline was captured. */
  capturedAt: number;
  tools: BaselineTool[];
}

export interface ToolDiff {
  name: string;
  newParams: string[];
  removedParams: string[];
  typeChanges: { param: string; from: string; to: string }[];
  requiredChanges: { param: string; from: boolean; to: boolean }[];
}

export interface DriftReport {
  newTools: string[];
  removedTools: string[];
  changedTools: ToolDiff[];
}

export interface ApiDriftMonitorDeps {
  /** The base MCP URL (config.gameUrl). */
  mcpUrl: string;
  /** Returns current game server version, or null if unknown. */
  getGameVersion: () => string | null;
  /** Path to $FLEET_DIR for baseline file persistence. */
  fleetDir: string;
  /** Optional callback for testing — called with each DriftReport. */
  onDrift?: (report: DriftReport) => void;
}

export interface ApiDriftMonitor {
  /** One check pass. On first run, captures baseline; subsequent runs diff. */
  tick(): Promise<void>;
  /** Immediate check bypassing dedup — use on version-change hook. */
  forceCheck(): Promise<void>;
  /** Update baseline to current server state. Call after operator acknowledgment. */
  acceptBaseline(): void;
  /** Current stored baseline, or null if none captured yet. */
  getCurrentBaseline(): ApiDriftBaseline | null;
  /** Last drift report from a tick/forceCheck, or null. */
  getLastReport(): DriftReport | null;
}

// ---------------------------------------------------------------------------
// Baseline file I/O
// ---------------------------------------------------------------------------

function getDriftBaselinePath(fleetDir: string): string {
  return join(fleetDir, "data", "api-drift-baseline.json");
}

export function readDriftBaseline(fleetDir: string): ApiDriftBaseline | null {
  try {
    return JSON.parse(readFileSync(getDriftBaselinePath(fleetDir), "utf-8")) as ApiDriftBaseline;
  } catch {
    return null;
  }
}

export function writeDriftBaseline(fleetDir: string, baseline: ApiDriftBaseline): void {
  const path = getDriftBaselinePath(fleetDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(baseline, null, 2));
  } catch (err) {
    // Silently skip in test environments
    if (path.includes("/dev/null")) return;
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "EACCES") {
      log.warn(`Cannot write drift baseline (permission denied): ${path}`);
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Normalize a type string: "integer" → "number" (server uses either interchangeably). */
export function normalizeType(raw: string | undefined): string {
  if (!raw) return "unknown";
  if (raw === "integer") return "number";
  return raw;
}

/** Build a normalized BaselineTool from a raw ServerTool. */
export function buildBaselineTool(tool: ServerTool): BaselineTool {
  const props = tool.inputSchema?.properties ?? {};
  const required = new Set(tool.inputSchema?.required ?? []);

  const params: BaselineParam[] = Object.entries(props)
    .filter(([name]) => !IGNORED_PARAMS.has(name))
    .map(([name, def]) => {
      const d = def as { type?: string; description?: string };
      return {
        name,
        type: normalizeType(d.type),
        required: required.has(name),
        hasDescription: typeof d.description === "string" && d.description.length > 0,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return { name: tool.name, params };
}

/** Build a full ApiDriftBaseline from a list of ServerTools and a game version. */
export function buildBaseline(serverTools: ServerTool[], gameVersion: string): ApiDriftBaseline {
  return {
    version: gameVersion,
    capturedAt: Date.now(),
    tools: serverTools.map(buildBaselineTool).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// ---------------------------------------------------------------------------
// Diff algorithm
// ---------------------------------------------------------------------------

/** Returns true if the drift report has no changes. */
export function isDriftEmpty(report: DriftReport): boolean {
  return (
    report.newTools.length === 0 &&
    report.removedTools.length === 0 &&
    report.changedTools.length === 0
  );
}

/**
 * Diff two baselines. Returns what changed between baseline and current.
 * Uses INTENTIONALLY_SKIPPED to filter removedTools — a tool removed from
 * the server but intentionally not proxied is not drift.
 */
export function diffBaseline(baseline: ApiDriftBaseline, current: ApiDriftBaseline): DriftReport {
  const baselineMap = new Map(baseline.tools.map((t) => [t.name, t]));
  const currentMap = new Map(current.tools.map((t) => [t.name, t]));

  const newTools: string[] = [];
  for (const name of currentMap.keys()) {
    if (!baselineMap.has(name)) {
      newTools.push(name);
    }
  }

  const removedTools: string[] = [];
  for (const name of baselineMap.keys()) {
    if (!currentMap.has(name) && !INTENTIONALLY_SKIPPED.has(name)) {
      removedTools.push(name);
    }
  }

  const changedTools: ToolDiff[] = [];
  for (const [name, bt] of baselineMap) {
    const ct = currentMap.get(name);
    if (!ct) continue; // removed — handled above

    const bparams = new Map(bt.params.map((p) => [p.name, p]));
    const cparams = new Map(ct.params.map((p) => [p.name, p]));

    const newParams: string[] = [];
    for (const pname of cparams.keys()) {
      if (!bparams.has(pname)) newParams.push(pname);
    }

    const removedParams: string[] = [];
    for (const pname of bparams.keys()) {
      if (!cparams.has(pname)) removedParams.push(pname);
    }

    const typeChanges: { param: string; from: string; to: string }[] = [];
    const requiredChanges: { param: string; from: boolean; to: boolean }[] = [];

    for (const [pname, bp] of bparams) {
      const cp = cparams.get(pname);
      if (!cp) continue; // removed — handled above

      if (bp.type !== cp.type) {
        typeChanges.push({ param: pname, from: bp.type, to: cp.type });
      }
      if (bp.required !== cp.required) {
        requiredChanges.push({ param: pname, from: bp.required, to: cp.required });
      }
    }

    if (
      newParams.length > 0 ||
      removedParams.length > 0 ||
      typeChanges.length > 0 ||
      requiredChanges.length > 0
    ) {
      changedTools.push({ name, newParams, removedParams, typeChanges, requiredChanges });
    }
  }

  return { newTools, removedTools, changedTools };
}

// ---------------------------------------------------------------------------
// Alert formatting
// ---------------------------------------------------------------------------

/** Format a drift report into a human-readable alert message. */
export function formatDriftAlert(report: DriftReport, gameVersion: string): string {
  const lines: string[] = [`API drift detected (game v${gameVersion}):`];

  if (report.newTools.length > 0) {
    lines.push(`  NEW tools (${report.newTools.length}): ${report.newTools.join(", ")}`);
  }

  if (report.removedTools.length > 0) {
    lines.push(`  REMOVED tools (${report.removedTools.length}): ${report.removedTools.join(", ")}`);
  }

  if (report.changedTools.length > 0) {
    lines.push(`  CHANGED tools (${report.changedTools.length}):`);
    for (const diff of report.changedTools) {
      const parts: string[] = [];
      if (diff.newParams.length > 0) {
        parts.push(`+${diff.newParams.join(", +")} (new param${diff.newParams.length > 1 ? "s" : ""})`);
      }
      if (diff.removedParams.length > 0) {
        parts.push(`-${diff.removedParams.join(", -")} (removed param${diff.removedParams.length > 1 ? "s" : ""})`);
      }
      for (const tc of diff.typeChanges) {
        parts.push(`${tc.param}: ${tc.from} → ${tc.to}`);
      }
      for (const rc of diff.requiredChanges) {
        parts.push(`${rc.param}: required ${rc.from} → ${rc.to}`);
      }
      lines.push(`    ${diff.name}: ${parts.join("; ")}`);
    }
  }

  lines.push(`Review: update V1_PROXIED_TOOLS or INTENTIONALLY_SKIPPED in schema-drift.test.ts`);

  return lines.join("\n");
}

/** Determine alert severity: "warning" if tools removed, "info" for additions/changes only. */
export function getDriftSeverity(report: DriftReport): "warning" | "info" {
  return report.removedTools.length > 0 ? "warning" : "info";
}

// ---------------------------------------------------------------------------
// MCP fetch (anonymous 3-step handshake)
// ---------------------------------------------------------------------------

/**
 * Perform the 3-step MCP handshake against the game URL and return raw server tools.
 * Returns null if the server is unreachable or returns an error (safe to skip alerting).
 */
async function fetchToolsFromServer(mcpUrl: string): Promise<ServerTool[] | null> {
  try {
    const initResp = await fetch(mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        id: 1,
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "gantry-drift-monitor", version: "1.0.0" },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!initResp.ok) return null;

    const sessionId = initResp.headers.get("mcp-session-id");
    if (!sessionId) return null;

    const sessionHeaders = {
      "Content-Type": "application/json",
      "mcp-session-id": sessionId,
    };

    await fetch(mcpUrl, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      signal: AbortSignal.timeout(5_000),
    });

    const toolsResp = await fetch(mcpUrl, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 2 }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!toolsResp.ok) return null;

    const data = JSON.parse(await toolsResp.text()) as {
      result?: { tools?: ServerTool[] };
    };

    return data.result?.tools ?? null;
  } catch {
    // Network error, timeout, DNS failure — game server unreachable
    return null;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createApiDriftMonitor(deps: ApiDriftMonitorDeps): ApiDriftMonitor {
  let currentBaseline: ApiDriftBaseline | null = readDriftBaseline(deps.fleetDir);
  let lastReport: DriftReport | null = null;
  /** Pending server tools captured on forceCheck for use in acceptBaseline(). */
  let pendingServerTools: ServerTool[] | null = null;

  // ---------------------------------------------------------------------------
  // Core check logic
  // ---------------------------------------------------------------------------

  async function runCheck(skipDedup: boolean): Promise<void> {
    const serverTools = await fetchToolsFromServer(deps.mcpUrl);
    if (serverTools === null) {
      log.warn("api-drift: game server unreachable — skipping check");
      return;
    }

    const gameVersion = deps.getGameVersion() ?? "unknown";
    const currentSnapshot = buildBaseline(serverTools, gameVersion);
    pendingServerTools = serverTools;

    if (currentBaseline === null) {
      // First run — capture baseline, no alert
      currentBaseline = currentSnapshot;
      writeDriftBaseline(deps.fleetDir, currentBaseline);
      log.info("api-drift: initial baseline captured", {
        toolCount: serverTools.length,
        version: gameVersion,
      });
      return;
    }

    const report = diffBaseline(currentBaseline, currentSnapshot);
    lastReport = report;

    if (isDriftEmpty(report)) {
      log.debug("api-drift: no drift detected");
      return;
    }

    // Always log drift regardless of dedup
    const severity = getDriftSeverity(report);
    const message = formatDriftAlert(report, gameVersion);
    log.warn("api-drift: drift detected", {
      newTools: report.newTools.length,
      removedTools: report.removedTools.length,
      changedTools: report.changedTools.length,
      version: gameVersion,
    });
    log.warn(message);

    deps.onDrift?.(report);

    // File alert (with dedup unless forceCheck)
    const alreadyAlerted = skipDedup
      ? false
      : hasRecentAlert(ALERT_AGENT, ALERT_CATEGORY, DEDUP_WINDOW_MS);

    if (!alreadyAlerted) {
      try {
        createAlert(ALERT_AGENT, severity, ALERT_CATEGORY, message);
        log.info("api-drift: alert filed", { severity });
      } catch (err) {
        log.warn("api-drift: could not file alert", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      log.debug("api-drift: dedup suppressed alert (already alerted within window)");
    }
  }

  // ---------------------------------------------------------------------------
  // Public interface
  // ---------------------------------------------------------------------------

  async function tick(): Promise<void> {
    return runCheck(false);
  }

  async function forceCheck(): Promise<void> {
    return runCheck(true);
  }

  function acceptBaseline(): void {
    if (pendingServerTools === null) {
      log.warn("api-drift: acceptBaseline called but no pending server tools — run a check first");
      return;
    }
    const gameVersion = deps.getGameVersion() ?? "unknown";
    currentBaseline = buildBaseline(pendingServerTools, gameVersion);
    writeDriftBaseline(deps.fleetDir, currentBaseline);
    log.info("api-drift: baseline accepted", {
      toolCount: pendingServerTools.length,
      version: gameVersion,
    });
    pendingServerTools = null;
  }

  function getCurrentBaseline(): ApiDriftBaseline | null {
    return currentBaseline;
  }

  function getLastReport(): DriftReport | null {
    return lastReport;
  }

  return { tick, forceCheck, acceptBaseline, getCurrentBaseline, getLastReport };
}
