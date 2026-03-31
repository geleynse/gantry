/**
 * Configuration type definitions.
 * Types with a corresponding Zod schema are derived via z.infer<> to prevent drift.
 * Types without a schema (runtime-only or differently shaped) remain as interfaces.
 */
import type { z } from "zod";
import type {
  AgentConfigSchema,
  AuthConfigSchema,
  MockInitialStateSchema,
  CoordinatorConfigSchema,
  OverseerConfigSchema,
  SurvivabilityConfigSchema,
  OutboundConfigSchema,
} from "./schemas.js";

// Merged agent config interface (from both proxy and web)
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

// Auth config interface
export type AuthConfig = z.infer<typeof AuthConfigSchema>;

// Mock mode initial state
export type MockInitialState = z.infer<typeof MockInitialStateSchema>;

// Mock mode configuration — runtime-only normalized form (boolean shorthand
// from JSON is expanded to this object shape by loadConfig()).
export interface MockModeConfig {
  /** Enable offline mode — uses MockGameClient instead of real game connection. */
  enabled: boolean;
  /** Path to canned responses JSON file. Defaults to examples/mock-responses.json. */
  responsesFile?: string;
  /** How long waitForTick() sleeps (ms). Set to 0 for instant ticks. Defaults to 500. */
  tickIntervalMs?: number;
  /** Initial agent state for simulation. */
  initialState?: MockInitialState;
}

// Account pool config — resolved absolute path to the pool file
export interface AccountPoolConfig {
  /** Absolute path to the account-pool.json file */
  poolFile: string;
}

// Survivability config interface
export type SurvivabilityConfig = z.infer<typeof SurvivabilityConfigSchema>;

// Outbound content review config
export type OutboundConfig = z.infer<typeof OutboundConfigSchema>;

// Coordinator config interface
export type CoordinatorConfig = z.infer<typeof CoordinatorConfigSchema>;

// Overseer config interface
export type OverseerConfig = z.infer<typeof OverseerConfigSchema>;

// Proxy config interface — runtime shape after loadConfig() normalization.
// Not directly inferred from FleetConfigSchema because field names differ
// (e.g. mcpGameUrl → gameUrl/gameApiUrl/gameMcpUrl, accountPool string → AccountPoolConfig).
export interface GantryConfig {
  agents: AgentConfig[];
  gameUrl: string;
  gameApiUrl: string;
  gameMcpUrl: string;
  agentDeniedTools: Record<string, Record<string, string>>;
  callLimits: Record<string, number>;
  turnSleepMs: number;
  staggerDelay: number;
  auth?: AuthConfig;
  fleetName?: string;
  mockMode?: MockModeConfig;
  accountPool?: AccountPoolConfig;
  /**
   * Path to credentials file for OAuth token refresh on 401.
   * Defaults to ~/.claude/.credentials.json (Claude Code OAuth credentials).
   * Used by GameClient to reload a fresh token when the game session expires mid-run.
   */
  credentialsPath?: string;
  /** Max iterations (tool calls) per MCP session. Default: 200. */
  maxIterationsPerSession?: number;
  /** Max turn duration in milliseconds. Default: 10 minutes. */
  maxTurnDurationMs?: number;
  /** Idle timeout in milliseconds (no activity). Default: 2 minutes. */
  idleTimeoutMs?: number;
  /** Supply-chain coordinator config */
  coordinator?: CoordinatorConfig;
  /** Overseer agent config: autonomous fleet monitoring and corrective actions */
  overseer?: OverseerConfig;
  /** Agent survivability features: auto-cloak, mod recommendations */
  survivability?: SurvivabilityConfig;
  /** Outbound content review config: per-channel review policies */
  outbound?: OutboundConfig;
  /**
   * MCP preset definitions: maps preset/role name → list of v2 tool names to advertise.
   * Used by gantry-v2.ts to filter which tools are visible to each agent (#214).
   */
  mcpPresets?: Record<string, string[]>;
  /**
   * URL of the game's forum for intel scraping (Task #29).
   * When set, /api/intel/forum returns cached post data.
   */
  forumUrl?: string;
  /**
   * Validate fleet credentials against the game API on startup.
   * Attempts a login with the first agent's credentials and logs a warning if it fails.
   * Default: true. Set to false to skip (useful in offline/mock mode).
   */
  validateCredentialsOnStartup?: boolean;
}
