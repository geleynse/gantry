import { describe, it, expect } from 'bun:test';
import { parseTurnFile, extractCombatEvents } from './turn-parser.js';

// Build realistic JSONL test data.
// In real Claude Code JSONL:
//   - tool_use blocks are in type:'assistant' messages
//   - tool_result blocks are in type:'user' messages
const toolUseId1 = 'toolu_status_001';
const toolUseId2 = 'toolu_mine_002';

const statusResult = JSON.stringify({
  credits: 15200,
  fuel: { current: 80, max: 100 },
  cargo: { used: 12, max: 60 },
  location: { system: 'Alpha Centauri', poi: 'Mining Outpost' },
  docked: true,
  hull: 85,
  max_hull: 100,
  shield: 40,
  max_shield: 50,
  ship_name: 'Nebula Drifter',
  ship_class: 'Corvette',
});

const assistantWithToolUse1 = JSON.stringify({
  type: 'assistant',
  message: {
    content: [
      {
        type: 'tool_use',
        id: toolUseId1,
        name: 'mcp__gantry__get_status',
        input: {},
      },
    ],
  },
});

const userWithToolResult1 = JSON.stringify({
  type: 'user',
  message: {
    content: [
      {
        type: 'tool_result',
        tool_use_id: toolUseId1,
        content: statusResult,
      },
    ],
  },
});

const assistantWithToolUse2 = JSON.stringify({
  type: 'assistant',
  message: {
    content: [
      {
        type: 'tool_use',
        id: toolUseId2,
        name: 'mcp__gantry__mine',
        input: { resource: 'iron' },
      },
    ],
  },
});

const userWithToolResult2 = JSON.stringify({
  type: 'user',
  message: {
    content: [
      {
        type: 'tool_result',
        tool_use_id: toolUseId2,
        content: 'Mined 12 iron ore',
      },
    ],
  },
});

const resultLine = JSON.stringify({
  type: 'result',
  total_cost_usd: 0.0342,
  usage: {
    input_tokens: 4500,
    output_tokens: 1200,
    cache_read_input_tokens: 3000,
    cache_creation_input_tokens: 500,
  },
  num_turns: 3,
  duration_ms: 18500,
  model: 'claude-sonnet-4-20250514',
});

const fullJsonl = [
  assistantWithToolUse1,
  userWithToolResult1,
  assistantWithToolUse2,
  userWithToolResult2,
  resultLine,
].join('\n');

describe('turn-parser', () => {
  describe('parseTurnFile', () => {
    it('extracts tool calls in order with correct sequence numbers and names', () => {
      const parsed = parseTurnFile(fullJsonl);
      expect(parsed.toolCalls).toHaveLength(2);
      expect(parsed.toolCalls[0].sequenceNumber).toBe(0);
      expect(parsed.toolCalls[0].toolName).toBe('mcp__gantry__get_status');
      expect(parsed.toolCalls[0].success).toBe(true);
      expect(parsed.toolCalls[1].sequenceNumber).toBe(1);
      expect(parsed.toolCalls[1].toolName).toBe('mcp__gantry__mine');
      expect(parsed.toolCalls[1].resultSummary).toBe('Mined 12 iron ore');
    });

    it('extracts turn summary from result line', () => {
      const parsed = parseTurnFile(fullJsonl);
      expect(parsed.summary).not.toBeNull();
      expect(parsed.summary!.costUsd).toBe(0.0342);
      expect(parsed.summary!.inputTokens).toBe(4500);
      expect(parsed.summary!.outputTokens).toBe(1200);
      expect(parsed.summary!.cacheReadTokens).toBe(3000);
      expect(parsed.summary!.cacheCreateTokens).toBe(500);
      expect(parsed.summary!.iterations).toBe(3);
      expect(parsed.summary!.durationMs).toBe(18500);
      expect(parsed.summary!.model).toBe('claude-sonnet-4-20250514');
    });

    it('extracts Codex usage from turn.completed events', () => {
      const codexJsonl = [
        JSON.stringify({
          type: 'turn.completed',
          usage: {
            input_tokens: 1_100_000,
            cached_input_tokens: 100_000,
            output_tokens: 100_000,
          },
          model: 'gpt-5.3-codex',
        }),
        JSON.stringify({
          type: 'result',
          usage: {
            cost: 0,
            inputTokens: 1_100_000,
            outputTokens: 100_000,
            cacheReadTokens: 100_000,
            durationMs: 0,
            numTurns: 1,
          },
        }),
      ].join('\n');

      const parsed = parseTurnFile(codexJsonl);
      expect(parsed.summary).not.toBeNull();
      expect(parsed.summary!.costUsd).toBeCloseTo(1.75 + 0.0175 + 1.4);
      expect(parsed.summary!.inputTokens).toBe(1_100_000);
      expect(parsed.summary!.outputTokens).toBe(100_000);
      expect(parsed.summary!.cacheReadTokens).toBe(100_000);
      expect(parsed.summary!.model).toBe('gpt-5.3-codex');
    });

    it('extracts game state from get_status result', () => {
      const parsed = parseTurnFile(fullJsonl);
      expect(parsed.gameState).not.toBeNull();
      expect(parsed.gameState!.credits).toBe(15200);
      expect(parsed.gameState!.fuel).toBe(80);
      expect(parsed.gameState!.fuelMax).toBe(100);
      expect(parsed.gameState!.cargoUsed).toBe(12);
      expect(parsed.gameState!.cargoMax).toBe(60);
      expect(parsed.gameState!.system).toBe('Alpha Centauri');
      expect(parsed.gameState!.poi).toBe('Mining Outpost');
      expect(parsed.gameState!.docked).toBe(true);
      expect(parsed.gameState!.hull).toBe(85);
      expect(parsed.gameState!.hullMax).toBe(100);
      expect(parsed.gameState!.shield).toBe(40);
      expect(parsed.gameState!.shieldMax).toBe(50);
      expect(parsed.gameState!.shipName).toBe('Nebula Drifter');
      expect(parsed.gameState!.shipClass).toBe('Corvette');
    });

    it('handles empty input', () => {
      const parsed = parseTurnFile('');
      expect(parsed.toolCalls).toEqual([]);
      expect(parsed.summary).toBeNull();
      expect(parsed.gameState).toBeNull();
    });

    it('handles malformed input', () => {
      const parsed = parseTurnFile('not json at all\n{broken json\n');
      expect(parsed.toolCalls).toEqual([]);
      expect(parsed.summary).toBeNull();
      expect(parsed.gameState).toBeNull();
    });

    it('handles lines with parse errors gracefully among valid lines', () => {
      const mixed = [
        'garbage line',
        assistantWithToolUse2,
        '{not valid json}',
        userWithToolResult2,
        resultLine,
      ].join('\n');
      const parsed = parseTurnFile(mixed);
      expect(parsed.toolCalls).toHaveLength(1);
      expect(parsed.toolCalls[0].toolName).toBe('mcp__gantry__mine');
      expect(parsed.summary).not.toBeNull();
    });

    it('truncates long argsJson and resultSummary to 500 chars', () => {
      const longInput = { data: 'x'.repeat(600) };
      const longResult = 'y'.repeat(600);
      const useId = 'toolu_long_003';

      const lines = [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: useId, name: 'long_tool', input: longInput },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: useId, content: longResult },
            ],
          },
        }),
      ].join('\n');

      const parsed = parseTurnFile(lines);
      expect(parsed.toolCalls).toHaveLength(1);
      expect(parsed.toolCalls[0].argsJson.length).toBeLessThanOrEqual(500);
      expect(parsed.toolCalls[0].resultSummary.length).toBeLessThanOrEqual(500);
    });

    it('handles flat game state format', () => {
      const flatStatus = JSON.stringify({
        credits: 5000,
        fuel: 50,
        fuelMax: 100,
        cargoUsed: 5,
        cargoMax: 30,
        system: 'Sol',
        poi: 'Earth Station',
        docked: false,
      });
      const useId = 'toolu_flat_004';

      const lines = [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: useId, name: 'get_status', input: {} },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: useId, content: flatStatus },
            ],
          },
        }),
      ].join('\n');

      const parsed = parseTurnFile(lines);
      expect(parsed.gameState).not.toBeNull();
      expect(parsed.gameState!.credits).toBe(5000);
      expect(parsed.gameState!.fuel).toBe(50);
      expect(parsed.gameState!.fuelMax).toBe(100);
      expect(parsed.gameState!.system).toBe('Sol');
      expect(parsed.gameState!.docked).toBe(false);
      expect(parsed.gameState!.hull).toBeNull();
      expect(parsed.gameState!.hullMax).toBeNull();
      expect(parsed.gameState!.shield).toBeNull();
      expect(parsed.gameState!.shieldMax).toBeNull();
      expect(parsed.gameState!.shipName).toBeNull();
      expect(parsed.gameState!.shipClass).toBeNull();
    });

    it('marks tool calls with is_error as not successful', () => {
      const useId = 'toolu_err_005';
      const lines = [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: useId, name: 'spacemolt', input: { action: 'mine' } },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: useId, content: 'Error: cooldown', is_error: true },
            ],
          },
        }),
      ].join('\n');

      const parsed = parseTurnFile(lines);
      expect(parsed.toolCalls).toHaveLength(1);
      expect(parsed.toolCalls[0].success).toBe(false);
      expect(parsed.toolCalls[0].resultSummary).toBe('Error: cooldown');
    });

    it('handles multiple tool_result blocks in a single user message', () => {
      const id1 = 'toolu_multi_001';
      const id2 = 'toolu_multi_002';
      const lines = [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: id1, name: 'spacemolt', input: { action: 'get_credits' } },
              { type: 'tool_use', id: id2, name: 'spacemolt', input: { action: 'get_fuel' } },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: id1, content: '15000' },
              { type: 'tool_result', tool_use_id: id2, content: '80/100' },
            ],
          },
        }),
      ].join('\n');

      const parsed = parseTurnFile(lines);
      expect(parsed.toolCalls).toHaveLength(2);
      expect(parsed.toolCalls[0].toolName).toBe('spacemolt');
      expect(parsed.toolCalls[0].resultSummary).toBe('15000');
      expect(parsed.toolCalls[1].resultSummary).toBe('80/100');
    });

    it('ignores plain text user messages', () => {
      const lines = [
        JSON.stringify({
          type: 'user',
          message: { content: 'Hello, start mining please' },
        }),
        assistantWithToolUse2,
        userWithToolResult2,
      ].join('\n');

      const parsed = parseTurnFile(lines);
      expect(parsed.toolCalls).toHaveLength(1);
      expect(parsed.toolCalls[0].toolName).toBe('mcp__gantry__mine');
    });
  });
});

describe('extractCombatEvents', () => {
  it('returns empty array when no events section', () => {
    expect(extractCombatEvents('some random text')).toHaveLength(0);
    expect(extractCombatEvents('')).toHaveLength(0);
  });

  it('extracts pirate_combat event', () => {
    const yaml = `cargo_used: 9
events:
  - type: pirate_combat
    data:
      damage: 15
      pirate_name: Drifter
      pirate_tier: small
      your_hull: 85
      your_max_hull: 100
      your_shield: 33
`;
    const events = extractCombatEvents(yaml, 'krynn');
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('pirate_combat');
    expect(events[0].damage).toBe(15);
    expect(events[0].pirateName).toBe('Drifter');
    expect(events[0].pirateTier).toBe('small');
    expect(events[0].hullAfter).toBe(85);
    expect(events[0].maxHull).toBe(100);
    expect(events[0].system).toBe('krynn');
    expect(events[0].died).toBe(false);
  });

  it('extracts pirate_warning event', () => {
    const yaml = `status: ok
events:
  - type: pirate_warning
    data:
      delay_ticks: 3
      pirate_name: Sentinel
      pirate_tier: large
`;
    const events = extractCombatEvents(yaml);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('pirate_warning');
    expect(events[0].pirateName).toBe('Sentinel');
    expect(events[0].pirateTier).toBe('large');
    expect(events[0].damage).toBeNull();
  });

  it('extracts player_died event with insurance payout', () => {
    const yaml = `status: ok
events:
  - type: player_died
    data:
      respawn_base: sol_base
      clone_cost: 0
      insurance_payout: 2210
      ship_lost: solarian_theoria
      cause: pirate
`;
    const events = extractCombatEvents(yaml);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('player_died');
    expect(events[0].died).toBe(true);
    expect(events[0].insurancePayout).toBe(2210);
  });

  it('extracts multiple events in one block', () => {
    const yaml = `events:
  - type: pirate_warning
    data:
      pirate_name: Drifter
      pirate_tier: small
      delay_ticks: 3
  - type: pirate_combat
    data:
      damage: 15
      pirate_name: Drifter
      pirate_tier: small
      your_hull: 85
      your_max_hull: 100
      your_shield: 0
  - type: player_died
    data:
      insurance_payout: 0
      cause: pirate
fleet_orders:
  - id: 1
`;
    const events = extractCombatEvents(yaml);
    expect(events).toHaveLength(3);
    expect(events[0].eventType).toBe('pirate_warning');
    expect(events[1].eventType).toBe('pirate_combat');
    expect(events[2].eventType).toBe('player_died');
  });

  it('parseTurnFile includes combatEvents', () => {
    const toolId = 'toolu_combat_001';
    const yamlResult = `cargo_used: 5
events:
  - type: pirate_combat
    data:
      damage: 20
      pirate_name: Enforcer
      pirate_tier: large
      your_hull: 60
      your_max_hull: 100
      your_shield: 0
`;
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: toolId, name: 'mcp__gantry__get_cargo_summary', input: {} }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolId, content: yamlResult }] } }),
      JSON.stringify({ type: 'result', total_cost_usd: 0.001, usage: { input_tokens: 100, output_tokens: 50 }, num_turns: 1, duration_ms: 5000, model: 'test' }),
    ].join('\n');

    const parsed = parseTurnFile(lines);
    expect(parsed.combatEvents).toHaveLength(1);
    expect(parsed.combatEvents[0].eventType).toBe('pirate_combat');
    expect(parsed.combatEvents[0].damage).toBe(20);
    expect(parsed.combatEvents[0].pirateName).toBe('Enforcer');
  });

  it('populates system on combat events when get_status appears before combat in turn', () => {
    // get_status fires, then the next tool call contains a combat event —
    // currentSystem should be set from the status result so the event gets attributed.
    const statusId = 'toolu_status_s1';
    const mineId = 'toolu_mine_s1';
    const statusResult = JSON.stringify({
      credits: 5000,
      fuel: { current: 60, max: 100 },
      cargo: { used: 3, max: 60 },
      location: { system: 'Krynn', poi: 'Asteroid Belt' },
      docked: false,
      hull: 90,
      max_hull: 100,
    });
    const mineResult = `cargo_used: 6
events:
  - type: pirate_combat
    data:
      damage: 10
      pirate_name: Raider
      pirate_tier: small
      your_hull: 80
      your_max_hull: 100
      your_shield: 0
`;
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', id: statusId, name: 'get_status', input: {} },
        { type: 'tool_use', id: mineId, name: 'mine', input: {} },
      ] } }),
      JSON.stringify({ type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: statusId, content: statusResult },
        { type: 'tool_result', tool_use_id: mineId, content: mineResult },
      ] } }),
      JSON.stringify({ type: 'result', total_cost_usd: 0.001, usage: { input_tokens: 100, output_tokens: 50 }, num_turns: 1, duration_ms: 5000, model: 'test' }),
    ].join('\n');

    const parsed = parseTurnFile(lines);
    expect(parsed.combatEvents).toHaveLength(1);
    expect(parsed.combatEvents[0].system).toBe('Krynn');
  });

  it('backfills system on combat events when get_status appears after combat in turn', () => {
    // Combat event fires before get_status — currentSystem is null at extraction
    // time, but the backfill pass should set it from the later get_status result.
    const mineId = 'toolu_mine_bf1';
    const statusId = 'toolu_status_bf1';
    const mineResult = `cargo_used: 4
events:
  - type: pirate_warning
    data:
      pirate_name: Sentinel
      pirate_tier: large
      delay_ticks: 2
`;
    const statusResult = JSON.stringify({
      credits: 3000,
      fuel: { current: 50, max: 100 },
      cargo: { used: 4, max: 60 },
      location: { system: 'Vega', poi: 'Gas Cloud' },
      docked: false,
      hull: 100,
      max_hull: 100,
    });
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', id: mineId, name: 'mine', input: {} },
      ] } }),
      JSON.stringify({ type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: mineId, content: mineResult },
      ] } }),
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', id: statusId, name: 'get_status', input: {} },
      ] } }),
      JSON.stringify({ type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: statusId, content: statusResult },
      ] } }),
      JSON.stringify({ type: 'result', total_cost_usd: 0.001, usage: { input_tokens: 100, output_tokens: 50 }, num_turns: 1, duration_ms: 5000, model: 'test' }),
    ].join('\n');

    const parsed = parseTurnFile(lines);
    expect(parsed.combatEvents).toHaveLength(1);
    expect(parsed.combatEvents[0].system).toBe('Vega');
  });

  it('extracts system from _current_system proxy injection in JSON tool result', () => {
    // The proxy injects _current_system into every tool response (see injection-registry.ts
    // "location-context"). This ensures combat events get attributed even in turns with no
    // get_status / get_location call.
    const mineId = 'toolu_mine_inj1';
    const mineResult = `cargo_used: 5
_current_system: Proxima
events:
  - type: pirate_combat
    data:
      damage: 12
      pirate_name: Scout
      pirate_tier: small
      your_hull: 70
      your_max_hull: 100
`;
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', id: mineId, name: 'mine', input: {} },
      ] } }),
      JSON.stringify({ type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: mineId, content: mineResult },
      ] } }),
      JSON.stringify({ type: 'result', total_cost_usd: 0.001, usage: { input_tokens: 100, output_tokens: 50 }, num_turns: 1, duration_ms: 5000, model: 'test' }),
    ].join('\n');

    const parsed = parseTurnFile(lines);
    expect(parsed.combatEvents).toHaveLength(1);
    expect(parsed.combatEvents[0].system).toBe('Proxima');
  });

  it('extracts system from _current_system in YAML tool result', () => {
    // For YAML-configured agents the proxy response is YAML; regex fallback handles it.
    const mineId = 'toolu_mine_yaml1';
    const mineResult = `cargo_used: 5
_current_system: Altair
events:
  - type: pirate_warning
    data:
      pirate_name: Hunter
      pirate_tier: medium
      delay_ticks: 2
`;
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', id: mineId, name: 'mine', input: {} },
      ] } }),
      JSON.stringify({ type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: mineId, content: mineResult },
      ] } }),
      JSON.stringify({ type: 'result', total_cost_usd: 0.001, usage: { input_tokens: 100, output_tokens: 50 }, num_turns: 1, duration_ms: 5000, model: 'test' }),
    ].join('\n');

    const parsed = parseTurnFile(lines);
    expect(parsed.combatEvents).toHaveLength(1);
    expect(parsed.combatEvents[0].system).toBe('Altair');
  });

  it('_current_system does not override system already known from get_status', () => {
    // get_status fires first and sets currentSystem; _current_system in a later tool
    // result should not overwrite it (get_status is authoritative).
    const statusId = 'toolu_status_prio';
    const mineId = 'toolu_mine_prio';
    const statusResult = JSON.stringify({
      credits: 5000,
      fuel: { current: 60, max: 100 },
      cargo: { used: 3, max: 60 },
      location: { system: 'Rigel', poi: 'Station' },
      docked: false,
      hull: 90,
      max_hull: 100,
    });
    const mineResult = `cargo_used: 6
_current_system: SomeOtherSystem
events:
  - type: pirate_combat
    data:
      damage: 10
      pirate_name: Raider
      pirate_tier: small
      your_hull: 80
      your_max_hull: 100
`;
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', id: statusId, name: 'get_status', input: {} },
        { type: 'tool_use', id: mineId, name: 'mine', input: {} },
      ] } }),
      JSON.stringify({ type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: statusId, content: statusResult },
        { type: 'tool_result', tool_use_id: mineId, content: mineResult },
      ] } }),
      JSON.stringify({ type: 'result', total_cost_usd: 0.001, usage: { input_tokens: 100, output_tokens: 50 }, num_turns: 1, duration_ms: 5000, model: 'test' }),
    ].join('\n');

    const parsed = parseTurnFile(lines);
    expect(parsed.combatEvents).toHaveLength(1);
    // get_status set currentSystem='Rigel'; _current_system in mine result should not override
    expect(parsed.combatEvents[0].system).toBe('Rigel');
  });

  it('backfills system from get_location when no get_status is present', () => {
    // Turn uses get_location instead of get_status. Combat event should still
    // get attributed to the system from the location result.
    const mineId = 'toolu_mine_loc1';
    const locId = 'toolu_loc_loc1';
    const mineResult = `events:
  - type: pirate_combat
    data:
      damage: 25
      pirate_name: Boss
      pirate_tier: large
      your_hull: 40
      your_max_hull: 100
      your_shield: 0
`;
    const locResult = JSON.stringify({ system: 'Dusk', poi: 'Nebula', docked: false });
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', id: mineId, name: 'mine', input: {} },
      ] } }),
      JSON.stringify({ type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: mineId, content: mineResult },
      ] } }),
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', id: locId, name: 'get_location', input: {} },
      ] } }),
      JSON.stringify({ type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: locId, content: locResult },
      ] } }),
      JSON.stringify({ type: 'result', total_cost_usd: 0.001, usage: { input_tokens: 100, output_tokens: 50 }, num_turns: 1, duration_ms: 5000, model: 'test' }),
    ].join('\n');

    const parsed = parseTurnFile(lines);
    expect(parsed.combatEvents).toHaveLength(1);
    expect(parsed.combatEvents[0].system).toBe('Dusk');
  });
});
