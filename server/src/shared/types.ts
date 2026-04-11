export type { AgentConfig } from "../config.js";

export interface FleetConfig {
  agents: import("../config.js").AgentConfig[];
  mcpGameUrl: string;
  turnSleepMs: number;
  staggerDelay: number;
}

export interface AgentStatus {
  name: string;
  backend: string;
  model?: string;
  role?: string;
  /** Role type from fleet-config.json (e.g. "trader", "combat", "explorer") — #213a */
  roleType?: string;
  /** Skill module names from fleet-config.json — #213a */
  skillModules?: string[];
  /** Operating zone from fleet-config.json — #213a */
  operatingZone?: string;
  /** Faction note from fleet-config.json — #213a */
  factionNote?: string;
  llmRunning: boolean;
  state: 'running' | 'backed-off' | 'stale' | 'stopped' | 'unreachable' | 'dead';
  turnCount: number;
  lastTurnAge?: string;
  lastTurnAgeSeconds?: number;
  quotaHits: number;
  authHits: number;
  shutdownPending: boolean;
  lastGameOutput: string[];
  healthScore: number;
  healthIssues: string[];
  proxy?: string;
  // Session tracking
  sessionStartedAt?: string | null;
  lastToolCallAt?: string | null;
  lastToolName?: string | null;
  // Health details
  latencyMetrics?: LatencyMetrics;
  errorRate?: ErrorRateBreakdown;
  connectionStatus?: 'connected' | 'disconnected' | 'reconnecting';
  // Shutdown state tracking
  inBattle?: boolean;
  shutdownState?: AgentShutdownState;
  proxySessionActive?: boolean;
  lastActivityAt?: string | null;
}

export interface ProxyInfo {
  name: string;
  port: number;
  host: string;
  status: 'up' | 'down' | 'unknown';
  agents: string[];
}

export interface ActionProxyStatus {
  processRunning: boolean;
  healthy: boolean;
  activeAgents: string[];
  toolCount: number;
}

export interface FleetStatus {
  agents: AgentStatus[];
  proxies: ProxyInfo[];
  actionProxy: ActionProxyStatus;
  turnSleepMs: number;
  timestamp: string;
  fleetName?: string;
}

export interface Analytics {
  name: string;
  backend: string;
  model?: string;
  totalTurns: number;
  quotaHits: number;
  successRate: number;
  uptimeFormatted?: string;
  turnsPerHour?: number;
  // Usage metrics
  totalCost?: number;
  avgCostPerTurn?: number;
  totalTokens?: number;  // Codex: total tokens; Claude: input + output
}

export interface CommsData {
  orders: string;
  bulletin: string;
  reports: Record<string, string>;
}

export interface HealthScore {
  name: string;
  backend: string;
  model?: string;
  score: number;
  issues: string[];
}

export interface SessionInfo {
  agent: string;
  sessionStartedAt: string | null;
  lastToolCallAt: string | null;
  lastToolName: string | null;
}

export interface LatencyMetrics {
  agent: string;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  avgMs: number | null;
}

export interface ErrorRateBreakdown {
  agent: string;
  totalCalls: number;
  successRate: number;
  errorsByType: Record<string, number>;
  countRateLimit: number;
  countConnection: number;
}

export interface AgentHealthDetails {
  agent: string;
  latency: LatencyMetrics;
  errorRate: ErrorRateBreakdown;
  lastSuccessfulCommand: string | null;
  connectionStatus: 'connected' | 'disconnected' | 'reconnecting';
}

export interface NoteFile {
  name: string;
  size: number;
  updated_at?: string;
}

export interface UsageSummary {
  turnCount: number;
  costPerHour?: number;
  // Claude fields
  totalCost?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheReadTokens?: number;
  totalCacheCreateTokens?: number;
  totalIterations?: number;
  avgCostPerTurn?: number;
  avgDurationMs?: number;
  // Codex fields
  totalTokens?: number;
  avgTokensPerTurn?: number;
}

export interface LogLineEvent {
  line: string;
  offset: number;
}

export interface LogMetaEvent {
  fileSize: number;
}

export interface LogHistoryResponse {
  lines: string[];
  startOffset: number;
  endOffset: number;
  fileSize: number;
}

export interface LogSearchResult {
  line: string;
  lineNumber: number;
  offset: number;
}

// Account pool types
export type AccountStatus = "available" | "assigned" | "disabled";

export interface AccountSummary {
  id: string;
  username: string;
  status: AccountStatus;
  assignedTo: string | null;
  assignedAt: string | null;
  faction?: string;
  notes?: string;
  lastLogin?: string;
}

export interface AccountPoolStatus {
  enabled: boolean;
  poolFile: string;
  accounts: AccountSummary[];
  config: {
    autoAssign: boolean;
    matchFaction: boolean;
    releaseOnShutdown: boolean;
    maxAssignmentsPerAccount: number;
  };
}

// Proxy cache types (shared to avoid circular imports between server.ts and cache-persistence.ts)
export interface BattleState {
  battle_id: string;
  zone: string;
  stance: string;
  hull: number;
  shields: number;
  target: unknown;
  status: string;
  updatedAt: number;
}

export interface AgentCallTracker {
  /** Tool call counts for rate-limited tools */
  counts: Record<string, number>;
  /** Last tool call signature for duplicate detection: "toolName:argsHash" */
  lastCallSig: string | null;
  /** Tools called in this session (for prerequisite enforcement) */
  calledTools: Set<string>;
}

// Agent shutdown state types
export type AgentShutdownState = 'none' | 'shutdown_waiting' | 'draining' | 'stopped' | 'stop_after_turn';

export interface AgentShutdownRecord {
  id: string;
  agent_name: string;
  state: AgentShutdownState;
  created_at: string;
  updated_at: string;
  reason: string;
}

export interface AgentStatusWithShutdown {
  inBattle: boolean;
  shutdownState: AgentShutdownState;
  llmRunning: boolean;
  proxySessionActive: boolean;
  lastActivityAt: string | null;
}
