/**
 * Game API rate limit tracker.
 *
 * Tracks requests per agent and per exit IP to the game server.
 * The game enforces 30 combined requests/min/IP. 5 agents share 3 exit IPs.
 *
 * Rolling 10-minute window of per-minute buckets, used to compute:
 * - Current RPM per agent
 * - Current RPM per exit IP (aggregated across agents on that IP)
 * - 429 events with timestamps and tool names
 * - 10-minute sparkline history (one RPM data point per minute)
 */

import { createLogger } from "../lib/logger.js";

const log = createLogger("rate-limit-tracker");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Game server rate limit: requests per minute per exit IP */
export const GAME_RATE_LIMIT = 30;
/** Window for sparkline history (10 minutes = 10 buckets) */
const HISTORY_WINDOW_MINUTES = 10;
const BUCKET_MS = 60_000;
const MAX_429_EVENTS = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RateLimitEvent429 {
  agent: string;
  timestamp: string; // ISO 8601
  tool: string;
}

interface RequestRecord {
  agentName: string;
  bucketMinute: number; // floor(Date.now() / 60_000)
  isRateLimit: boolean;
  tool: string;
}

export interface IpStats {
  agents: string[];
  rpm: number;
  history: number[]; // last HISTORY_WINDOW_MINUTES buckets, oldest first
}

export interface AgentStats {
  rpm: number;
  rate_limited: number; // total 429 count (in window)
  last_429: string | null; // ISO timestamp
}

export interface RateLimitSnapshot {
  limit: number;
  window_seconds: number;
  by_ip: Record<string, IpStats>;
  by_agent: Record<string, AgentStats>;
  recent_429s: RateLimitEvent429[];
}

// ---------------------------------------------------------------------------
// DI interface
// ---------------------------------------------------------------------------

export interface RateLimitTrackerDeps {
  /** Maps agent name → exit IP label (e.g. "direct", "socks5-1081"). */
  agentToIp: Map<string, string>;
  /** Maps exit IP label → list of agents on that IP. */
  ipToAgents: Map<string, string[]>;
  /** Current time in ms. Defaults to Date.now(). Override in tests. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// RateLimitTracker
// ---------------------------------------------------------------------------

export class RateLimitTracker {
  private records: RequestRecord[] = [];
  private events429: RateLimitEvent429[] = [];
  private readonly deps: RateLimitTrackerDeps;

  constructor(deps: RateLimitTrackerDeps) {
    this.deps = deps;
  }

  /** Record a game API call for an agent. */
  recordRequest(agentName: string, tool: string, isRateLimit = false): void {
    const now = this.now();
    const bucketMinute = Math.floor(now / BUCKET_MS);
    this.records.push({ agentName, bucketMinute, isRateLimit, tool });

    if (isRateLimit) {
      this.events429.push({
        agent: agentName,
        timestamp: new Date(now).toISOString(),
        tool,
      });
      // Trim to cap
      if (this.events429.length > MAX_429_EVENTS) {
        this.events429.shift();
      }
      log.info("rate_limited", { agent: agentName, tool });
    }

    this.prune(now);
  }

  /** Get a full snapshot of current rate limit stats. */
  getSnapshot(): RateLimitSnapshot {
    const now = this.now();
    this.prune(now);

    const currentBucket = Math.floor(now / BUCKET_MS);
    const { agentToIp, ipToAgents } = this.deps;

    // Count RPM per agent (requests in the last full minute bucket = currentBucket)
    const agentCurrentRpm = new Map<string, number>();
    const agent429Count = new Map<string, number>();

    for (const rec of this.records) {
      if (rec.bucketMinute === currentBucket) {
        agentCurrentRpm.set(rec.agentName, (agentCurrentRpm.get(rec.agentName) ?? 0) + 1);
      }
      if (rec.isRateLimit) {
        agent429Count.set(rec.agentName, (agent429Count.get(rec.agentName) ?? 0) + 1);
      }
    }

    // Build by_agent
    const allAgents = new Set<string>([...agentToIp.keys()]);
    // Include any agents seen in records but not in config
    for (const rec of this.records) {
      allAgents.add(rec.agentName);
    }

    const by_agent: Record<string, AgentStats> = {};
    const last429ByAgent = new Map<string, string>();
    for (const ev of this.events429) {
      last429ByAgent.set(ev.agent, ev.timestamp);
    }

    for (const agent of allAgents) {
      by_agent[agent] = {
        rpm: agentCurrentRpm.get(agent) ?? 0,
        rate_limited: agent429Count.get(agent) ?? 0,
        last_429: last429ByAgent.get(agent) ?? null,
      };
    }

    // Build sparkline history per IP
    // History = 10 buckets, index 0 = oldest (currentBucket - 9), index 9 = most recent (currentBucket)
    const bucketCountPerIp = new Map<string, Map<number, number>>();
    for (const [label] of ipToAgents) {
      bucketCountPerIp.set(label, new Map<number, number>());
    }

    for (const rec of this.records) {
      const ipLabel = agentToIp.get(rec.agentName) ?? "direct";
      let buckets = bucketCountPerIp.get(ipLabel);
      if (!buckets) {
        buckets = new Map<number, number>();
        bucketCountPerIp.set(ipLabel, buckets);
      }
      buckets.set(rec.bucketMinute, (buckets.get(rec.bucketMinute) ?? 0) + 1);
    }

    // Build sparkline history for an IP: array of length HISTORY_WINDOW_MINUTES,
    // oldest bucket at index 0, most recent (currentBucket) at index length-1.
    function buildHistory(label: string): number[] {
      const buckets = bucketCountPerIp.get(label) ?? new Map<number, number>();
      const history: number[] = [];
      for (let i = HISTORY_WINDOW_MINUTES - 1; i >= 0; i--) {
        history.push(buckets.get(currentBucket - i) ?? 0);
      }
      return history;
    }

    // Build by_ip
    const by_ip: Record<string, IpStats> = {};
    for (const [label, agents] of ipToAgents) {
      const history = buildHistory(label);
      const rpm = history[history.length - 1] ?? 0;
      by_ip[label] = { agents, rpm, history };
    }

    // Also add IPs from agents not in config (edge case)
    for (const [agent, ipLabel] of agentToIp) {
      if (!by_ip[ipLabel]) {
        const history = buildHistory(ipLabel);
        by_ip[ipLabel] = {
          agents: [agent],
          rpm: history[history.length - 1] ?? 0,
          history,
        };
      }
    }

    return {
      limit: GAME_RATE_LIMIT,
      window_seconds: 60,
      by_ip,
      by_agent,
      recent_429s: [...this.events429].reverse(), // newest first
    };
  }

  /** Prune records older than the history window. */
  private prune(now: number): void {
    const cutoffBucket = Math.floor(now / BUCKET_MS) - HISTORY_WINDOW_MINUTES;
    this.records = this.records.filter((r) => r.bucketMinute > cutoffBucket);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

// ---------------------------------------------------------------------------
// Factory: build tracker deps from GantryConfig
// ---------------------------------------------------------------------------

import type { GantryConfig } from "../config.js";

/**
 * Derive the exit-IP label from an agent's proxy config.
 * - No proxy → "direct"
 * - proxy name is mapped to "socks5-{port}" using the agent's socksPort field
 */
export function resolveIpLabel(agentConfig: { proxy?: string; socksPort?: number }): string {
  if (!agentConfig.proxy) return "direct";
  if (agentConfig.socksPort) return `socks5-${agentConfig.socksPort}`;
  return `proxy-${agentConfig.proxy}`;
}

/** Build RateLimitTrackerDeps from a GantryConfig. */
export function buildTrackerDeps(config: GantryConfig): RateLimitTrackerDeps {
  const agentToIp = new Map<string, string>();
  const ipToAgents = new Map<string, string[]>();

  for (const agent of config.agents) {
    // Skip the overseer — it connects to /mcp/overseer, never calls the game API.
    if (agent.mcpVersion === 'overseer') continue;
    const label = resolveIpLabel(agent);
    agentToIp.set(agent.name, label);
    const list = ipToAgents.get(label) ?? [];
    list.push(agent.name);
    ipToAgents.set(label, list);
  }

  return { agentToIp, ipToAgents };
}

// ---------------------------------------------------------------------------
// Singleton (module-level, like MetricsWindow in instability-metrics.ts)
// ---------------------------------------------------------------------------

let _tracker: RateLimitTracker | null = null;

/** Get or create the singleton tracker. Must call initTracker first. */
export function getTracker(): RateLimitTracker | null {
  return _tracker;
}

/** Initialize the singleton tracker from config. Safe to call multiple times. */
export function initTracker(config: GantryConfig): RateLimitTracker {
  if (!_tracker) {
    const deps = buildTrackerDeps(config);
    _tracker = new RateLimitTracker(deps);
    log.info("rate limit tracker initialized", {
      agents: config.agents.length,
      ips: deps.ipToAgents.size,
    });
  }
  return _tracker;
}

/** Reset singleton (for testing). */
export function resetTracker(): void {
  _tracker = null;
}
