/**
 * Zod validation schemas for configuration files.
 */
import * as z from "zod";

export const AgentConfigSchema = z.object({
  name: z.string().min(1),
  backend: z.enum(["claude", "codex", "gemini"]).optional(),
  model: z.string().optional(),
  extraTools: z.string().optional(),
  faction: z.string().optional(),
  role: z.string().optional(),
  proxy: z.string().optional(),
  /** Computed at load time from proxy .conf file — not read from JSON directly. */
  socksPort: z.number().optional(),
  mcpVersion: z.enum(["v1", "v2", "overseer"]).optional(),
  mcpPreset: z.enum(["basic", "standard", "full"]).optional(),
  toolResultFormat: z.enum(["json", "yaml"]).optional(),
  homeSystem: z.string().optional(),
  roleType: z.enum(["trader", "miner", "explorer", "combat", "crafter", "hauler", "salvager", "diplomat", "prospector"]).optional(),
  skillModules: z.array(z.string()).optional(),
  factionNote: z.string().optional(),
  operatingZone: z.string().optional(),
  routineMode: z.boolean().optional(),
  /**
   * Context compression mode. "full" (default) keeps the long-running Claude session.
   * "compressed" starts a fresh session per turn with a structured state summary injected
   * into the system prompt, dramatically reducing token usage at the cost of conversational
   * continuity. Agents can use search_memory to recall older context.
   */
  contextMode: z.enum(["full", "compressed"]).optional(),
  systemPrompt: z.string().optional(),
  /**
   * Model to use for context compaction (background summarization of long contexts).
   * Should be a cheaper/faster model than the main agent model to reduce cost.
   * Example: "haiku" for Claude Haiku, "claude-3-haiku-20240307" for full model ID.
   * Passed to the agent runner via --compaction-model flag when supported.
   */
  compactionModel: z.string().optional(),
  /**
   * Whether context compaction is enabled for this agent. Defaults to true.
   * Set to false to disable compaction entirely (agent runs with full context only).
   */
  compactionEnabled: z.boolean().optional(),
});


export const AuthConfigSchema = z.object({
  adapter: z.string(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const MockInitialStateSchema = z.object({
  credits: z.number().optional(),
  fuel: z.number().optional(),
  location: z.string().optional(),
  dockedAt: z.string().optional(),
  cargo: z.array(z.object({ item_id: z.string(), quantity: z.number() })).optional(),
});

export const MockModeConfigSchema = z.union([
  z.boolean(),
  z.object({
    enabled: z.boolean(),
    responsesFile: z.string().optional(),
    tickIntervalMs: z.number().min(0).optional(),
    initialState: MockInitialStateSchema.optional(),
  }),
]);

export const CoordinatorConfigSchema = z.object({
  enabled: z.boolean().optional().default(false),
  intervalMinutes: z.number().positive().optional().default(10),
  defaultDistribution: z.object({
    miners: z.number().min(0),
    crafters: z.number().min(0),
    traders: z.number().min(0),
    flex: z.number().min(0),
  }).optional().default({ miners: 2, crafters: 1, traders: 1, flex: 1 }),
  quotaDefaults: z.object({
    batchSize: z.number().positive(),
    maxActiveQuotas: z.number().positive(),
  }).optional().default({ batchSize: 50, maxActiveQuotas: 10 }),
});

export const OverseerConfigSchema = z.object({
  enabled: z.boolean().default(false),
  model: z.string().default("haiku"),
  intervalMinutes: z.number().positive().default(10),
  cooldownSeconds: z.number().min(0).default(60),
  maxActionsPerTick: z.number().positive().default(5),
  eventTriggers: z.array(z.string()).default([
    "agent_stranded", "agent_died", "agent_stopped", "credits_critical", "combat_alert",
  ]),
  creditThreshold: z.number().min(0).default(1000),
  historyWindow: z.number().min(0).default(3),
});

export const ThreatLevelSchema = z.enum(["safe", "low", "medium", "high", "extreme"]);

export const CloakThresholdsSchema = z.object({
  combat: ThreatLevelSchema.optional().default("extreme"),
  explorer: ThreatLevelSchema.optional().default("high"),
  hauler: ThreatLevelSchema.optional().default("medium"),
  default: ThreatLevelSchema.optional().default("medium"),
});

export const SurvivabilityConfigSchema = z.object({
  autoCloakEnabled: z.boolean().optional(),
  agentOverrides: z.record(z.string(), z.boolean()).optional(),
  /** Per-role cloak thresholds. Falls back to hardcoded defaults if not set. */
  thresholds: CloakThresholdsSchema.optional(),
});

export const OutboundPolicySchema = z.enum(["require_approval", "auto_approve_with_log", "disabled"]);

export const OutboundConfigSchema = z.object({
  forum: OutboundPolicySchema.optional().default("require_approval"),
  chat: OutboundPolicySchema.optional().default("require_approval"),
  discord: OutboundPolicySchema.optional().default("require_approval"),
});

export const FleetConfigSchema = z.object({
  mcpGameUrl: z.string(),
  agents: z.array(AgentConfigSchema).min(1),
  turnSleepMs: z.number().positive().optional(),
  /** @deprecated Use turnSleepMs instead. Accepted for backward compatibility. */
  turnInterval: z.number().positive().optional(),
  staggerDelay: z.number().min(0).optional(),
  agentDeniedTools: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  callLimits: z.record(z.string(), z.number()).optional(),
  mcpToolSet: z.array(z.string()).optional(),
  /**
   * MCP preset definitions: maps preset/role name → list of v2 tool names to advertise.
   * Used by gantry-v2.ts to filter tools per agent role (#214).
   * Must include "standard" as the default fallback.
   */
  mcpPresets: z.record(z.string(), z.array(z.string())).optional(),
  auth: AuthConfigSchema.optional(),
  fleetName: z.string().optional(),
  mockMode: MockModeConfigSchema.optional(),
  accountPool: z.string().nullable().optional(),
  credentialsPath: z.string().optional(),
  maxIterationsPerSession: z.number().positive().optional(),
  maxTurnDurationMs: z.number().positive().optional(),
  idleTimeoutMs: z.number().positive().optional(),
  /** Time (ms) after turn start to inject SHUTDOWN_SIGNAL. Default: 1100000 (1100s). */
  shutdownWarningMs: z.number().positive().optional(),
  coordinator: CoordinatorConfigSchema.optional(),
  overseer: OverseerConfigSchema.optional(),
  survivability: SurvivabilityConfigSchema.optional(),
  outbound: OutboundConfigSchema.optional(),
  /**
   * URL of the game's forum for intel scraping.
   * When set, /api/intel/forum returns cached post data.
   * When absent, the forum endpoint returns {"configured": false}.
   */
  forumUrl: z.string().url().optional(),
  /**
   * Validate fleet credentials against the game API on startup.
   * Attempts a login with the first agent's credentials and logs a warning if it fails.
   * Default: true. Set to false to skip (useful in offline/mock mode).
   */
  validateCredentialsOnStartup: z.boolean().optional(),
});
