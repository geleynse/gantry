/**
 * Zod schemas for key API response types.
 * Validates data shapes at API boundaries so mismatches surface as errors
 * instead of silent undefined values.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// AgentStatus
// ---------------------------------------------------------------------------

export const LatencyMetricsSchema = z.object({
  agent: z.string(),
  p50Ms: z.number().nullable(),
  p95Ms: z.number().nullable(),
  p99Ms: z.number().nullable(),
  avgMs: z.number().nullable(),
});

export const ErrorRateBreakdownSchema = z.object({
  agent: z.string(),
  totalCalls: z.number(),
  successRate: z.number(),
  errorsByType: z.record(z.number()),
});

export const AgentStatusSchema = z.object({
  name: z.string(),
  backend: z.string(),
  model: z.string().optional(),
  role: z.string().optional(),
  roleType: z.string().optional(),
  operatingZone: z.string().optional(),
  skillModules: z.array(z.string()).optional(),
  factionNote: z.string().optional(),
  llmRunning: z.boolean(),
  state: z.enum(['running', 'backed-off', 'stale', 'stopped', 'unreachable', 'dead']),
  turnCount: z.number(),
  lastTurnAge: z.string().optional(),
  lastTurnAgeSeconds: z.number().optional(),
  quotaHits: z.number(),
  authHits: z.number(),
  shutdownPending: z.boolean(),
  lastGameOutput: z.array(z.string()),
  healthScore: z.number(),
  healthIssues: z.array(z.string()),
  proxy: z.string().optional(),
  sessionStartedAt: z.string().nullable().optional(),
  lastToolCallAt: z.string().nullable().optional(),
  latencyMetrics: LatencyMetricsSchema.optional(),
  errorRate: ErrorRateBreakdownSchema.optional(),
  connectionStatus: z.enum(['connected', 'disconnected', 'reconnecting']).optional(),
  shutdownState: z.string().optional(),
  inBattle: z.boolean().optional(),
  proxySessionActive: z.boolean().optional(),
  lastActivityAt: z.string().nullable().optional(),
});

export type AgentStatusParsed = z.infer<typeof AgentStatusSchema>;

// ---------------------------------------------------------------------------
// ProxyInfo / ActionProxyStatus
// ---------------------------------------------------------------------------

export const ProxyInfoSchema = z.object({
  name: z.string(),
  port: z.number(),
  host: z.string(),
  status: z.enum(['up', 'down', 'unknown']),
  agents: z.array(z.string()),
});

export const ActionProxyStatusSchema = z.object({
  processRunning: z.boolean(),
  healthy: z.boolean(),
  activeAgents: z.array(z.string()),
  toolCount: z.number(),
});

// ---------------------------------------------------------------------------
// FleetStatus
// ---------------------------------------------------------------------------

export const FleetStatusSchema = z.object({
  agents: z.array(AgentStatusSchema),
  proxies: z.array(ProxyInfoSchema),
  actionProxy: ActionProxyStatusSchema,
  turnSleepMs: z.number(),
  timestamp: z.string(),
  fleetName: z.string().optional(),
});

export type FleetStatusParsed = z.infer<typeof FleetStatusSchema>;

// ---------------------------------------------------------------------------
// GameState (as returned by /api/game-state/:agent)
// ---------------------------------------------------------------------------

export const ShipModuleSchema = z.object({
  slot_type: z.string().optional(),
  item_id: z.string().optional(),
  item_name: z.string().optional(),
});

export const CargoItemSchema = z.object({
  item_id: z.string().optional(),
  name: z.string().optional(),
  quantity: z.number().optional(),
});

export const SkillDataSchema = z.object({
  name: z.string().optional(),
  level: z.number().optional(),
  xp: z.number().optional(),
  xp_to_next: z.number().optional(),
});

export const AgentShipSchema = z.object({
  name: z.string(),
  class: z.string().nullable(),
  hull: z.number(),
  max_hull: z.number(),
  shield: z.number(),
  max_shield: z.number(),
  fuel: z.number(),
  max_fuel: z.number(),
  cargo_used: z.number(),
  cargo_capacity: z.number(),
  modules: z.array(ShipModuleSchema),
  cargo: z.array(CargoItemSchema),
});

export const FactionUpgradeSchema = z.object({
  facility_id: z.string(),
  facility_type: z.string(),
  tier: z.number(),
  progress: z.number(),
  max_progress: z.number(),
});

export const FactionStateSchema = z.object({
  name: z.string().optional(),
  tag: z.string().optional(),
  storage_used: z.number().optional(),
  storage_capacity: z.number().optional(),
  upgrades: z.array(FactionUpgradeSchema).optional(),
});

export const AgentGameStateSchema = z.object({
  credits: z.number(),
  current_system: z.string().nullable(),
  current_poi: z.string().nullable(),
  docked_at_base: z.string().nullable(),
  home_system: z.string().nullable().optional(),
  home_poi: z.string().nullable().optional(),
  ship: AgentShipSchema.nullable(),
  faction: FactionStateSchema.nullable().optional(),
  skills: z.record(SkillDataSchema),
  data_age_s: z.number().optional(),
  last_seen: z.string().optional(),
});

export type AgentGameStateParsed = z.infer<typeof AgentGameStateSchema>;

export const FleetGameStateSchema = z.record(AgentGameStateSchema);

// ---------------------------------------------------------------------------
// statusCache entry (internal proxy shape)
// ---------------------------------------------------------------------------

export const StatusCacheEntrySchema = z.object({
  data: z.record(z.unknown()),
  fetchedAt: z.number(),
});

export type StatusCacheEntry = z.infer<typeof StatusCacheEntrySchema>;

/**
 * Validate a statusCache entry restored from the DB.
 * Returns { success: true, value } or { success: false, error }.
 */
export function validateStatusCacheEntry(raw: unknown): { success: true; value: StatusCacheEntry } | { success: false; error: string } {
  const result = StatusCacheEntrySchema.safeParse(raw);
  if (result.success) {
    return { success: true, value: result.data };
  }
  return { success: false, error: result.error.message };
}
