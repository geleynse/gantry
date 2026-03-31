import { describe, it, expect } from 'bun:test';
import {
  AgentStatusSchema,
  FleetStatusSchema,
  AgentGameStateSchema,
  FleetGameStateSchema,
  StatusCacheEntrySchema,
  validateStatusCacheEntry,
} from './schemas.js';

// ---------------------------------------------------------------------------
// AgentStatus
// ---------------------------------------------------------------------------

const validAgentStatus = {
  name: 'rust-vane',
  backend: 'claude',
  model: 'claude-3-5-sonnet-20241022',
  llmRunning: true,
  state: 'running' as const,
  turnCount: 42,
  quotaHits: 0,
  authHits: 0,
  shutdownPending: false,
  lastGameOutput: ['Mining copper', 'Sold 5 ore'],
  healthScore: 95,
  healthIssues: [],
  connectionStatus: 'connected' as const,
};

describe('AgentStatusSchema', () => {
  it('accepts a valid AgentStatus', () => {
    const result = AgentStatusSchema.safeParse(validAgentStatus);
    expect(result.success).toBe(true);
  });

  it('accepts all valid state values', () => {
    const states = ['running', 'backed-off', 'stale', 'stopped', 'unreachable', 'dead'] as const;
    for (const state of states) {
      const result = AgentStatusSchema.safeParse({ ...validAgentStatus, state });
      expect(result.success).toBe(true);
    }
  });

  it('rejects unknown state values', () => {
    const result = AgentStatusSchema.safeParse({ ...validAgentStatus, state: 'zombie' });
    expect(result.success).toBe(false);
  });

  it('rejects missing required fields', () => {
    const { name: _name, ...withoutName } = validAgentStatus;
    const result = AgentStatusSchema.safeParse(withoutName);
    expect(result.success).toBe(false);
  });

  it('accepts optional fields when absent', () => {
    const minimal = { ...validAgentStatus };
    delete (minimal as Record<string, unknown>).model;
    delete (minimal as Record<string, unknown>).connectionStatus;
    const result = AgentStatusSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it('accepts latencyMetrics when present', () => {
    const withLatency = {
      ...validAgentStatus,
      latencyMetrics: { agent: 'rust-vane', p50Ms: 120, p95Ms: 400, p99Ms: 800, avgMs: 150 },
    };
    const result = AgentStatusSchema.safeParse(withLatency);
    expect(result.success).toBe(true);
  });

  it('accepts null latency values', () => {
    const withNullLatency = {
      ...validAgentStatus,
      latencyMetrics: { agent: 'rust-vane', p50Ms: null, p95Ms: null, p99Ms: null, avgMs: null },
    };
    const result = AgentStatusSchema.safeParse(withNullLatency);
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FleetStatus
// ---------------------------------------------------------------------------

const validFleetStatus = {
  agents: [validAgentStatus],
  proxies: [{ name: 'proxy-1', port: 8080, host: 'localhost', status: 'up', agents: ['rust-vane'] }],
  actionProxy: { processRunning: true, healthy: true, activeAgents: ['rust-vane'], toolCount: 12 },
  turnSleepMs: 90,
  timestamp: new Date().toISOString(),
};

describe('FleetStatusSchema', () => {
  it('accepts a valid FleetStatus', () => {
    const result = FleetStatusSchema.safeParse(validFleetStatus);
    expect(result.success).toBe(true);
  });

  it('accepts optional fleetName', () => {
    const result = FleetStatusSchema.safeParse({ ...validFleetStatus, fleetName: 'Alpha Fleet' });
    expect(result.success).toBe(true);
  });

  it('accepts empty agents array', () => {
    const result = FleetStatusSchema.safeParse({ ...validFleetStatus, agents: [] });
    expect(result.success).toBe(true);
  });

  it('rejects invalid proxy status', () => {
    const bad = {
      ...validFleetStatus,
      proxies: [{ name: 'p', port: 8080, host: 'localhost', status: 'broken', agents: [] }],
    };
    const result = FleetStatusSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects missing timestamp', () => {
    const { timestamp: _ts, ...withoutTs } = validFleetStatus;
    const result = FleetStatusSchema.safeParse(withoutTs);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AgentGameState
// ---------------------------------------------------------------------------

const validGameState = {
  credits: 228573,
  current_system: 'alpha_centauri',
  current_poi: 'alpha_cen_station',
  docked_at_base: 'alpha_cen_station',
  ship: {
    name: 'Rustbucket',
    class: 'freighter',
    hull: 80,
    max_hull: 100,
    shield: 50,
    max_shield: 50,
    fuel: 40,
    max_fuel: 60,
    cargo_used: 10,
    cargo_capacity: 50,
    modules: [{ slot_type: 'weapon', item_id: 'laser_mk1', item_name: 'Laser Mk1' }],
    cargo: [{ item_id: 'copper_ore', name: 'Copper Ore', quantity: 10 }],
  },
  skills: {
    mining: { name: 'Mining', level: 3, xp: 500, xp_to_next: 1000 },
  },
  data_age_s: 30,
  last_seen: new Date().toISOString(),
};

describe('AgentGameStateSchema', () => {
  it('accepts a valid game state', () => {
    const result = AgentGameStateSchema.safeParse(validGameState);
    expect(result.success).toBe(true);
  });

  it('accepts null ship', () => {
    const result = AgentGameStateSchema.safeParse({ ...validGameState, ship: null });
    expect(result.success).toBe(true);
  });

  it('accepts null location fields', () => {
    const result = AgentGameStateSchema.safeParse({
      ...validGameState,
      current_system: null,
      current_poi: null,
      docked_at_base: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts empty skills', () => {
    const result = AgentGameStateSchema.safeParse({ ...validGameState, skills: {} });
    expect(result.success).toBe(true);
  });

  it('rejects missing credits', () => {
    const { credits: _c, ...withoutCredits } = validGameState;
    const result = AgentGameStateSchema.safeParse(withoutCredits);
    expect(result.success).toBe(false);
  });

  it('accepts optional data_age_s and last_seen', () => {
    const { data_age_s: _a, last_seen: _l, ...minimal } = validGameState;
    const result = AgentGameStateSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });
});

describe('FleetGameStateSchema', () => {
  it('accepts a map of agent game states', () => {
    const fleet = {
      'rust-vane': validGameState,
      'sable-thorn': { ...validGameState, credits: 50000 },
    };
    const result = FleetGameStateSchema.safeParse(fleet);
    expect(result.success).toBe(true);
  });

  it('accepts empty map', () => {
    const result = FleetGameStateSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// StatusCacheEntry + validateStatusCacheEntry
// ---------------------------------------------------------------------------

describe('StatusCacheEntrySchema', () => {
  it('accepts valid { data, fetchedAt } shape', () => {
    const entry = { data: { player: { credits: 1000 } }, fetchedAt: Date.now() };
    const result = StatusCacheEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it('rejects raw game state (legacy format missing wrapper)', () => {
    // Raw game state without { data, fetchedAt } wrapper
    const legacyRaw = { player: { credits: 1000, current_system: 'sol' }, ship: { hull: 80 } };
    const result = StatusCacheEntrySchema.safeParse(legacyRaw);
    expect(result.success).toBe(false);
  });

  it('rejects null', () => {
    const result = StatusCacheEntrySchema.safeParse(null);
    expect(result.success).toBe(false);
  });
});

describe('validateStatusCacheEntry', () => {
  it('returns success for valid entry', () => {
    const entry = { data: { player: { credits: 1000 } }, fetchedAt: 1000000 };
    const result = validateStatusCacheEntry(entry);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.fetchedAt).toBe(1000000);
    }
  });

  it('returns failure for legacy format', () => {
    const legacy = { player: { credits: 1000 }, ship: {} };
    const result = validateStatusCacheEntry(legacy);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeTruthy();
    }
  });

  it('returns failure for null', () => {
    const result = validateStatusCacheEntry(null);
    expect(result.success).toBe(false);
  });
});
