/**
 * Tests for game-state route flatten() logic.
 *
 * The statusCache can have data in several formats depending on game version and
 * how skills were merged in. All formats must yield correct output from /api/game-state/all.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { createDatabase, closeDb } from '../../services/database.js';
import { persistGameState, restoreAllCaches } from '../../proxy/cache-persistence.js';
import { createGameStateRouter } from './game-state.js';

function createTestApp(cacheEntries: Record<string, { data: Record<string, unknown>; fetchedAt: number }>) {
  const app = express();
  app.use(express.json());
  const statusCache = new Map(Object.entries(cacheEntries));
  app.use('/api/game-state', createGameStateRouter(statusCache));
  return app;
}

const FULL_NESTED_DATA = {
  tick: 42,
  player: {
    credits: 5000,
    current_system: 'Krynn',
    current_poi: 'Krynn Station Alpha',
    docked_at_base: 'Krynn Station Alpha',
    home_system: 'Solara',
    home_poi: 'Solara Base',
    skills: { mining: { name: 'Mining', level: 5, xp: 1200, xp_to_next: 800 } },
  },
  ship: {
    name: 'Drifter',
    class_id: 'scout',
    hull: 95,
    max_hull: 100,
    fuel: 80,
    max_fuel: 100,
    cargo_used: 10,
    cargo_capacity: 100,
    modules: [],
    cargo: [{ item_id: 'abc', name: 'Iron Ore', quantity: 5 }],
  },
  modules: [],
};

describe('game-state flatten — nested format', () => {
  it('extracts all fields from canonical nested format', async () => {
    const app = createTestApp({
      'drifter-gale': { data: FULL_NESTED_DATA, fetchedAt: Date.now() },
    });
    const res = await request(app).get('/api/game-state/all');
    expect(res.status).toBe(200);
    const agent = res.body['drifter-gale'];
    expect(agent.credits).toBe(5000);
    expect(agent.current_system).toBe('Krynn');
    expect(agent.current_poi).toBe('Krynn Station Alpha');
    expect(agent.ship).not.toBeNull();
    expect(agent.ship.fuel).toBe(80);
    expect(agent.ship.hull).toBe(95);
    expect(agent.ship.cargo).toHaveLength(1);
    expect(agent.skills.mining.level).toBe(5);
  });
});

describe('game-state flatten — flat format', () => {
  it('extracts all fields when credits/system are at root level (no player wrapper)', async () => {
    const flatData = {
      credits: 3000,
      current_system: 'Velox',
      current_poi: 'Velox Depot',
      home_system: null,
      home_poi: null,
      ship: {
        name: 'Rust Vane',
        class_id: 'freighter',
        hull: 70,
        max_hull: 120,
        fuel: 60,
        max_fuel: 120,
        cargo_used: 20,
        cargo_capacity: 200,
        modules: [],
        cargo: [],
      },
    };
    const app = createTestApp({
      'rust-vane': { data: flatData, fetchedAt: Date.now() },
    });
    const res = await request(app).get('/api/game-state/all');
    const agent = res.body['rust-vane'];
    expect(agent.credits).toBe(3000);
    expect(agent.current_system).toBe('Velox');
    expect(agent.current_poi).toBe('Velox Depot');
    expect(agent.ship.fuel).toBe(60);
    expect(agent.ship.hull).toBe(70);
  });
});

describe('game-state flatten — mixed format (skills-merge artifact)', () => {
  it('correctly extracts all fields when player wrapper only contains skills', async () => {
    // This format is created when skills are merged into flat-format game data:
    // onStateUpdate fires with { credits, current_system, ship } (no player wrapper)
    // then skills merge adds player: { skills } → { credits, current_system, ship, player: { skills } }
    // flatten() must NOT discard credits/current_system just because player wrapper exists.
    const mixedData = {
      credits: 7500,
      current_system: 'Nullspace',
      current_poi: 'Nullspace Outpost',
      ship: {
        hull: 88,
        max_hull: 100,
        fuel: 45,
        max_fuel: 100,
        cargo_used: 5,
        cargo_capacity: 50,
        modules: [],
        cargo: [],
      },
      player: {
        // Only skills here — rest of player data is at root level
        skills: { piloting: { name: 'Piloting', level: 3, xp: 400, xp_to_next: 600 } },
      },
    };
    const app = createTestApp({
      'null-spark': { data: mixedData, fetchedAt: Date.now() },
    });
    const res = await request(app).get('/api/game-state/all');
    expect(res.status).toBe(200);
    const agent = res.body['null-spark'];
    // All three fields that would be WRONG before the fix
    expect(agent.credits).toBe(7500);
    expect(agent.current_system).toBe('Nullspace');
    expect(agent.current_poi).toBe('Nullspace Outpost');
    // Ship data should also be intact
    expect(agent.ship).not.toBeNull();
    expect(agent.ship.fuel).toBe(45);
    expect(agent.ship.hull).toBe(88);
    // Skills should come through too
    expect(agent.skills?.piloting?.level).toBe(3);
  });

  it('player fields take precedence over root fields in mixed format', async () => {
    const mixedData = {
      credits: 100,            // root level (stale)
      current_system: 'Root',  // root level (stale)
      player: {
        credits: 999,          // player level (newer)
        current_system: 'Player',
        skills: {},
      },
      ship: { hull: 50, max_hull: 100, fuel: 30, max_fuel: 100, cargo_used: 0, cargo_capacity: 50, modules: [], cargo: [] },
    };
    const app = createTestApp({
      'test-agent': { data: mixedData, fetchedAt: Date.now() },
    });
    const res = await request(app).get('/api/game-state/all');
    const agent = res.body['test-agent'];
    expect(agent.credits).toBe(999);
    expect(agent.current_system).toBe('Player');
  });
});

describe('game-state flatten — full persist/restore round-trip', () => {
  beforeEach(() => createDatabase(':memory:'));
  afterEach(() => closeDb());

  it('restores full nested format and returns all fields via /api/game-state/all', async () => {
    const state = { data: FULL_NESTED_DATA, fetchedAt: 12345 };
    await persistGameState('drifter-gale', state);

    const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
    const battleCache = new Map();
    const callTrackers = new Map();
    await restoreAllCaches(statusCache, battleCache, callTrackers);

    const app = express();
    app.use(express.json());
    app.use('/api/game-state', createGameStateRouter(statusCache));

    const res = await request(app).get('/api/game-state/all');
    expect(res.status).toBe(200);
    const agent = res.body['drifter-gale'];
    expect(agent.credits).toBe(5000);
    expect(agent.current_system).toBe('Krynn');
    expect(agent.current_poi).toBe('Krynn Station Alpha');
    expect(agent.ship.fuel).toBe(80);
    expect(agent.ship.hull).toBe(95);
    expect(agent.skills.mining.level).toBe(5);
    expect(agent.data_age_s).toBeGreaterThanOrEqual(0);
  });

  it('restores mixed format and returns all fields via /api/game-state/all', async () => {
    const mixedData = {
      credits: 7500,
      current_system: 'Nullspace',
      current_poi: 'Outpost',
      ship: { hull: 88, max_hull: 100, fuel: 45, max_fuel: 100, cargo_used: 0, cargo_capacity: 50, modules: [], cargo: [] },
      player: { skills: { mining: { name: 'Mining', level: 2, xp: 100, xp_to_next: 900 } } },
    };
    await persistGameState('null-spark', { data: mixedData, fetchedAt: 99999 });

    const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
    await restoreAllCaches(statusCache, new Map(), new Map());

    const app = express();
    app.use(express.json());
    app.use('/api/game-state', createGameStateRouter(statusCache));

    const res = await request(app).get('/api/game-state/all');
    const agent = res.body['null-spark'];
    // These would be wrong (0/null) before the flatten fix
    expect(agent.credits).toBe(7500);
    expect(agent.current_system).toBe('Nullspace');
    expect(agent.ship.fuel).toBe(45);
    expect(agent.skills.mining.level).toBe(2);
  });

  it('fetchedAt is preserved through persist/restore cycle', async () => {
    await persistGameState('test-agent', { data: { player: { credits: 100 } }, fetchedAt: 42000 });
    const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
    await restoreAllCaches(statusCache, new Map(), new Map());
    expect(statusCache.get('test-agent')?.fetchedAt).toBe(42000);
  });

  it('returns last-known location for disconnected agent (statusCache not cleared on logout)', async () => {
    // Simulate: agent was online, cached data persisted, then agent disconnected.
    // The statusCache entry should survive logout and server restart.
    const stateBeforeDisconnect = {
      data: FULL_NESTED_DATA, // has current_system: 'Krynn', current_poi: 'Krynn Station Alpha'
      fetchedAt: Date.now() - 30 * 60 * 1000, // 30 minutes ago (stale)
    };
    await persistGameState('drifter-gale', stateBeforeDisconnect);

    // Simulate server restart — restore from DB
    const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
    await restoreAllCaches(statusCache, new Map(), new Map());

    const app = express();
    app.use(express.json());
    app.use('/api/game-state', createGameStateRouter(statusCache));

    const res = await request(app).get('/api/game-state/all');
    expect(res.status).toBe(200);
    const agent = res.body['drifter-gale'];

    // Location must be present even though data is stale
    expect(agent.current_system).toBe('Krynn');
    expect(agent.current_poi).toBe('Krynn Station Alpha');
    expect(agent.credits).toBe(5000);
    // data_age_s should indicate staleness
    expect(agent.data_age_s).toBeGreaterThan(29 * 60); // at least 29 minutes old
    expect(agent.last_seen).toBeDefined();
  });
});
