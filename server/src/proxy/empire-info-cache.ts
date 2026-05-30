/**
 * EmpireInfoCache — Periodically fetches empire policy data and caches results.
 *
 * Uses the game's get_empire_info MCP tool (public, no-login) to fetch policy
 * snapshots for all empires: tax rates, citizenship status, fuel surcharges,
 * repair costs, contraband, etc. Cached hourly; invalidated on game version change.
 *
 * Exposed to agents as the `get_empire_policies` public tool (see public-tools.ts).
 */

import { createLogger } from "../lib/logger.js";
import { persistEmpireInfoCache } from "./cache-persistence.js";

const log = createLogger("empire-info-cache");

export const EMPIRE_INFO_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface EmpireInfo {
  id: string;
  name: string;
  tax_rate_income: number;
  tax_rate_sales: number;
  tax_collection_active: boolean;
  citizenship_open: boolean;
  citizenship_requirements: string;
  fuel_surcharge: number;
  repair_cost_modifier: number;
  customs_fine_rate: number;
  bounty_multiplier: number;
  starting_credits: number;
  contraband: string[];
}

export interface EmpireCacheData {
  empires: EmpireInfo[];
  fetchedAt: number;
}

/** Normalize a raw empire object from the game API into our EmpireInfo shape. */
function normalizeEmpire(raw: Record<string, unknown>): EmpireInfo {
  return {
    id: String(raw.id ?? raw.empire_id ?? ""),
    name: String(raw.name ?? ""),
    tax_rate_income: Number(raw.tax_rate_income ?? 0),
    tax_rate_sales: Number(raw.tax_rate_sales ?? 0),
    tax_collection_active: Boolean(raw.tax_collection_active ?? false),
    citizenship_open: Boolean(raw.citizenship_open ?? false),
    citizenship_requirements: String(raw.citizenship_requirements ?? ""),
    fuel_surcharge: Number(raw.fuel_surcharge ?? 0),
    repair_cost_modifier: Number(raw.repair_cost_modifier ?? 1),
    customs_fine_rate: Number(raw.customs_fine_rate ?? 0),
    bounty_multiplier: Number(raw.bounty_multiplier ?? 1),
    starting_credits: Number(raw.starting_credits ?? 0),
    contraband: Array.isArray(raw.contraband) ? (raw.contraband as string[]) : [],
  };
}

export class EmpireInfoCache {
  static readonly TTL_MS = EMPIRE_INFO_TTL_MS;

  private empires: EmpireInfo[] | null = null;
  private fetchedAt = 0;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private readonly ttlMs: number;
  private readonly mcpUrl: string;
  private onRefresh: ((empires: EmpireInfo[]) => void) | null = null;

  constructor(gameUrl: string, ttlMs = EMPIRE_INFO_TTL_MS) {
    // gameUrl is the MCP endpoint — strip /mcp suffix to get base URL
    const base = gameUrl.replace(/\/mcp$/, "");
    this.mcpUrl = `${base}/mcp`;
    this.ttlMs = ttlMs;
  }

  /** Register a callback fired on every successful refresh. Used by TaxMonitor. */
  setOnRefresh(cb: (empires: EmpireInfo[]) => void): void {
    this.onRefresh = cb;
  }

  /** Start periodic background refresh. Returns the interval handle. */
  start(): ReturnType<typeof setInterval> {
    this.refresh().catch(() => {});
    this.refreshTimer = setInterval(() => {
      this.refresh().catch(() => {});
    }, this.ttlMs);
    this.refreshTimer.unref();
    return this.refreshTimer;
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /** Restore previously persisted cache data without a network fetch. */
  restore(empires: EmpireInfo[], fetchedAt: number): void {
    this.empires = empires;
    this.fetchedAt = fetchedAt;
  }

  /** Force a refresh (e.g., after game version change). */
  async forceRefresh(): Promise<void> {
    await this.refresh();
  }

  /**
   * Fetch empire info via the game's anonymous MCP endpoint (no login required).
   * The 3-step MCP handshake: initialize → notifications/initialized → tools/call.
   */
  async refresh(): Promise<boolean> {
    try {
      // Step 1: initialize session
      const initResp = await fetch(this.mcpUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "initialize",
          id: 1,
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "gantry-empire-info-cache", version: "1.0.0" },
          },
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!initResp.ok) {
        log.warn(`empire info init failed: HTTP ${initResp.status}`);
        return false;
      }

      const sessionId = initResp.headers.get("mcp-session-id");
      if (!sessionId) {
        log.warn("empire info init: no session ID returned");
        return false;
      }

      const sessionHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        "mcp-session-id": sessionId,
      };

      // Step 2: send initialized notification
      await fetch(this.mcpUrl, {
        method: "POST",
        headers: sessionHeaders,
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        signal: AbortSignal.timeout(5_000),
      });

      // Step 3: call get_empire_info
      const toolResp = await fetch(this.mcpUrl, {
        method: "POST",
        headers: sessionHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          id: 2,
          params: { name: "get_empire_info", arguments: {} },
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!toolResp.ok) {
        log.warn(`empire info tool call failed: HTTP ${toolResp.status}`);
        return false;
      }

      const raw = JSON.parse(await toolResp.text()) as {
        result?: { content?: Array<{ text?: string }> };
        error?: unknown;
      };

      if (raw.error) {
        log.warn("empire info tool returned error", { error: raw.error });
        return false;
      }

      const text = raw.result?.content?.[0]?.text;
      if (!text) {
        log.warn("empire info: no text content in response");
        return false;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        log.warn("empire info: JSON parse error", { textLen: text.length });
        return false;
      }

      // Accept { empires: [...] } or a raw array
      const rawList: unknown[] = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as Record<string, unknown>)?.empires)
          ? ((parsed as Record<string, unknown>).empires as unknown[])
          : null!;

      if (!Array.isArray(rawList)) {
        log.warn("empire info: unexpected response shape", { keys: Object.keys(parsed as Record<string, unknown> || {}) });
        return false;
      }

      const empires = rawList.map((e) => normalizeEmpire(e as Record<string, unknown>));
      this.empires = empires;
      this.fetchedAt = Date.now();

      // Persist for restart recovery
      persistEmpireInfoCache(empires, this.fetchedAt);

      log.info(`refreshed: ${empires.length} empires`);

      // Notify observers (TaxMonitor)
      if (this.onRefresh) {
        try {
          this.onRefresh(empires);
        } catch (err) {
          log.warn("onRefresh callback error", { error: err instanceof Error ? err.message : String(err) });
        }
      }

      return true;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return false;
      log.warn(`empire info fetch error: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** Get cached empire data. */
  get(empireId?: string): { data: EmpireInfo[] | null; stale: boolean; age_seconds: number } {
    const age = this.fetchedAt > 0 ? Math.round((Date.now() - this.fetchedAt) / 1000) : -1;
    const stale = this.fetchedAt > 0 && (Date.now() - this.fetchedAt) > this.ttlMs;

    if (!this.empires) {
      return { data: null, stale: false, age_seconds: age };
    }

    const empires = empireId
      ? this.empires.filter((e) => e.id === empireId)
      : this.empires;

    return { data: empires, stale, age_seconds: age };
  }

  /** Whether any data has been fetched (even if stale). */
  get hasData(): boolean {
    return this.empires !== null;
  }
}
