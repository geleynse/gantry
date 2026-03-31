import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createDatabase, closeDb } from './database.js';
import {
  parseActionLog,
  persistActionLogEntries,
  syncActionLog,
  type ActionLogEntry,
} from './action-log-parser.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(() => {
  createDatabase(':memory:');
});

afterAll(() => {
  closeDb();
});

// ---------------------------------------------------------------------------
// parseActionLog — JSON formats
// ---------------------------------------------------------------------------

describe('parseActionLog — JSON array of entries', () => {
  it('parses a sell action from a JSON array', () => {
    const raw = JSON.stringify([
      {
        type: 'sell',
        item: 'Iron Ore',
        quantity: 10,
        price: 150,
        station: 'Anchor Station',
        system: 'krynn',
        timestamp: '2026-03-01T10:00:00Z',
      },
    ]);

    const entries = parseActionLog('sable-thorn', raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].actionType).toBe('sell');
    expect(entries[0].item).toBe('Iron Ore');
    expect(entries[0].quantity).toBe(10);
    expect(entries[0].creditsDelta).toBe(1500); // price * quantity
    expect(entries[0].station).toBe('Anchor Station');
    expect(entries[0].system).toBe('krynn');
    expect(entries[0].gameTimestamp).toBe('2026-03-01T10:00:00Z');
    expect(entries[0].agent).toBe('sable-thorn');
  });

  it('parses a buy action and negates credits delta', () => {
    const raw = JSON.stringify([
      {
        type: 'buy',
        item: 'Steel',
        quantity: 5,
        price: 200,
        station: 'Port Nexus',
        timestamp: '2026-03-01T11:00:00Z',
      },
    ]);

    const entries = parseActionLog('drifter-gale', raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].actionType).toBe('buy');
    expect(entries[0].creditsDelta).toBe(-1000); // -(price * quantity)
  });

  it('parses a rescue action with direct credits_delta', () => {
    const raw = JSON.stringify([
      {
        type: 'rescue',
        credits_delta: 500,
        timestamp: '2026-03-01T12:00:00Z',
      },
    ]);

    const entries = parseActionLog('ember-drift', raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].actionType).toBe('rescue');
    expect(entries[0].creditsDelta).toBe(500);
    expect(entries[0].item).toBeUndefined();
  });

  it('parses faction_deposit action type', () => {
    const raw = JSON.stringify([
      {
        action_type: 'faction_deposit',
        total_credits: 750,
        station: 'HQ Station',
        timestamp: '2026-03-01T13:00:00Z',
      },
    ]);

    const entries = parseActionLog('rust-vane', raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].actionType).toBe('faction_deposit');
    expect(entries[0].creditsDelta).toBe(750);
  });

  it('parses bulk_order action with item_name and amount fields', () => {
    const raw = JSON.stringify([
      {
        action: 'bulk_order',
        item_name: 'Copper Wire',
        amount: 20,
        price: 75,
        poi: 'Trade Hub',
        timestamp: '2026-03-01T14:00:00Z',
      },
    ]);

    const entries = parseActionLog('null-spark', raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].actionType).toBe('bulk_order');
    expect(entries[0].item).toBe('Copper Wire');
    expect(entries[0].quantity).toBe(20);
    expect(entries[0].station).toBe('Trade Hub'); // poi maps to station
  });

  it('normalises action type names (spaces and hyphens -> underscores)', () => {
    const raw = JSON.stringify([
      { type: 'Self Destruct', credits_delta: -200, timestamp: '2026-03-01T15:00:00Z' },
    ]);

    const entries = parseActionLog('agent', raw);
    expect(entries[0].actionType).toBe('self_destruct');
  });

  it('handles entries wrapper object shape', () => {
    const raw = JSON.stringify({
      entries: [
        { type: 'sell', item: 'Coal', quantity: 3, price: 100, timestamp: '2026-03-01T16:00:00Z' },
      ],
      page: 1,
    });

    const entries = parseActionLog('agent', raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].item).toBe('Coal');
  });

  it('handles actions wrapper object shape', () => {
    const raw = JSON.stringify({
      actions: [
        { type: 'sell', item_id: 'ore_001', quantity: 5, price: 90, timestamp: '2026-03-01T17:00:00Z' },
      ],
    });

    const entries = parseActionLog('agent', raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].item).toBe('ore_001');
  });

  it('skips entries with no recognisable action type', () => {
    const raw = JSON.stringify([
      { item: 'Iron', quantity: 5 }, // no type/action/action_type/event
    ]);

    const entries = parseActionLog('agent', raw);
    expect(entries).toHaveLength(0);
  });

  it('skips non-object array elements', () => {
    const raw = JSON.stringify(['text line', null, { type: 'sell', price: 100, quantity: 1 }]);

    const entries = parseActionLog('agent', raw);
    expect(entries).toHaveLength(1);
  });

  it('returns empty for empty JSON array', () => {
    const entries = parseActionLog('agent', JSON.stringify([]));
    expect(entries).toHaveLength(0);
  });

  it('returns empty for empty string', () => {
    const entries = parseActionLog('agent', '');
    expect(entries).toHaveLength(0);
  });

  it('preserves raw_data as JSON string of the original entry', () => {
    const entry = { type: 'sell', item: 'Gold', quantity: 1, price: 5000, timestamp: '2026-03-01T18:00:00Z' };
    const raw = JSON.stringify([entry]);
    const entries = parseActionLog('agent', raw);
    expect(entries[0].rawData).toBe(JSON.stringify(entry));
  });

  it('uses item_name over item over item_id in that priority order', () => {
    const raw = JSON.stringify([{
      type: 'sell',
      item_name: 'The Good Name',
      item: 'item_id_fallback',
      item_id: 'raw_id',
      price: 100,
      quantity: 1,
    }]);

    const entries = parseActionLog('agent', raw);
    expect(entries[0].item).toBe('The Good Name');
  });

  it('uses cost field as negative credits_delta', () => {
    const raw = JSON.stringify([{
      type: 'commission',
      cost: 2500,
      item: 'Freighter',
      timestamp: '2026-03-01T19:00:00Z',
    }]);

    const entries = parseActionLog('agent', raw);
    expect(entries[0].creditsDelta).toBe(-2500);
  });
});

// ---------------------------------------------------------------------------
// parseActionLog — plain text / regex fallback
// ---------------------------------------------------------------------------

describe('parseActionLog — plain text fallback', () => {
  it('parses sell line in plain text format', () => {
    const raw = 'Sold 5x Iron Ore at Anchor Station for 1,250 credits';
    const entries = parseActionLog('agent', raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].actionType).toBe('sell');
    expect(entries[0].quantity).toBe(5);
    expect(entries[0].item).toBe('Iron Ore');
    expect(entries[0].creditsDelta).toBe(1250);
    expect(entries[0].station).toBe('Anchor Station');
  });

  it('parses buy line in plain text format', () => {
    const raw = 'Bought 3x Steel at Port Nexus for 900 credits';
    const entries = parseActionLog('agent', raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].actionType).toBe('buy');
    expect(entries[0].creditsDelta).toBe(-900);
  });

  it('parses rescue payment line', () => {
    const raw = 'Rescue payment: 500 credits';
    const entries = parseActionLog('agent', raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].actionType).toBe('rescue');
    expect(entries[0].creditsDelta).toBe(500);
  });

  it('parses insurance payout line', () => {
    const raw = 'Insurance payout: 2210 credits';
    const entries = parseActionLog('agent', raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].actionType).toBe('insurance_payout');
    expect(entries[0].creditsDelta).toBe(2210);
  });

  it('parses self-destruct fee line', () => {
    const raw = 'Self-destruct fee: 200 credits';
    const entries = parseActionLog('agent', raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].actionType).toBe('self_destruct');
    expect(entries[0].creditsDelta).toBe(200);
  });

  it('parses faction deposit line', () => {
    const raw = 'Faction deposit: 750 credits';
    const entries = parseActionLog('agent', raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].actionType).toBe('faction_deposit');
    expect(entries[0].creditsDelta).toBe(750);
  });

  it('handles multi-line plain text (one entry per line)', () => {
    const raw = [
      'Sold 2x Coal at Station A for 100 credits',
      'Bought 1x Steel at Station B for 200 credits',
    ].join('\n');

    const entries = parseActionLog('agent', raw);
    expect(entries).toHaveLength(2);
    expect(entries[0].actionType).toBe('sell');
    expect(entries[1].actionType).toBe('buy');
  });

  it('returns empty for unrecognised text', () => {
    const raw = 'No transactions found for this period.';
    const entries = parseActionLog('agent', raw);
    expect(entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// persistActionLogEntries — deduplication
// ---------------------------------------------------------------------------

describe('persistActionLogEntries', () => {
  it('inserts entries and returns inserted count', () => {
    const entries: ActionLogEntry[] = [
      {
        agent: 'test-agent',
        actionType: 'sell',
        item: 'Ore',
        quantity: 5,
        creditsDelta: 500,
        station: 'Test Station',
        system: 'test-system',
        rawData: '{}',
        gameTimestamp: '2026-03-01T20:00:00Z',
      },
    ];

    const inserted = persistActionLogEntries(entries);
    expect(inserted).toBe(1);
  });

  it('deduplicates entries with the same agent + action_type + game_timestamp', () => {
    const entry: ActionLogEntry = {
      agent: 'dedup-agent',
      actionType: 'buy',
      item: 'Steel',
      quantity: 3,
      creditsDelta: -300,
      rawData: '{}',
      gameTimestamp: '2026-03-01T21:00:00Z',
    };

    const first  = persistActionLogEntries([entry]);
    const second = persistActionLogEntries([entry]);

    expect(first).toBe(1);
    expect(second).toBe(0); // duplicate — not inserted
  });

  it('inserts entries with no game_timestamp without deduplication', () => {
    const entry: ActionLogEntry = {
      agent: 'no-ts-agent',
      actionType: 'rescue',
      creditsDelta: 500,
      rawData: 'Rescue payment: 500 credits',
    };

    const first  = persistActionLogEntries([entry]);
    const second = persistActionLogEntries([entry]);

    // Both inserted since there's no timestamp to dedup on
    expect(first).toBe(1);
    expect(second).toBe(1);
  });

  it('handles empty entries array gracefully', () => {
    const inserted = persistActionLogEntries([]);
    expect(inserted).toBe(0);
  });

  it('inserts multiple entries in a single call', () => {
    const entries: ActionLogEntry[] = [
      { agent: 'multi-agent', actionType: 'sell', rawData: '{}', gameTimestamp: '2026-03-01T22:00:00Z' },
      { agent: 'multi-agent', actionType: 'buy',  rawData: '{}', gameTimestamp: '2026-03-01T22:01:00Z' },
      { agent: 'multi-agent', actionType: 'sell', rawData: '{}', gameTimestamp: '2026-03-01T22:02:00Z' },
    ];

    const inserted = persistActionLogEntries(entries);
    expect(inserted).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// syncActionLog — end-to-end
// ---------------------------------------------------------------------------

describe('syncActionLog', () => {
  it('parses and inserts entries from raw JSON', () => {
    const raw = JSON.stringify([
      { type: 'sell', item: 'Titanium', quantity: 2, price: 1000, timestamp: '2026-03-02T10:00:00Z' },
    ]);

    // Should not throw
    expect(() => syncActionLog('sync-agent', raw)).not.toThrow();
  });

  it('silently handles empty result', () => {
    expect(() => syncActionLog('sync-agent', '')).not.toThrow();
  });

  it('silently handles unparseable garbage', () => {
    expect(() => syncActionLog('sync-agent', '!!!invalid???')).not.toThrow();
  });
});
