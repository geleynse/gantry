/**
 * crafting-profit.test.ts
 *
 * Tests for the BOM-based crafting chain analyzer.
 * Uses a fixture BOM so tests are not coupled to the vendored JSON file.
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import {
  loadBom,
  evaluateRecipe,
  findCraftChains,
  findAllChains,
  type BomRecipe,
  type PricePoint,
} from './crafting-profit.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Fixture BOM — small synthetic dataset for deterministic tests
// ---------------------------------------------------------------------------

const FIXTURE_BOM = {
  _meta: {
    source: 'test-fixture',
    note: 'Small fixture BOM for unit tests',
  },
  recipes: [
    {
      id: 'smelt_iron',
      name: 'Smelt Iron',
      output_item_id: 'steel_plate',
      output_qty: 1,
      ticks: 3,
      skills: [],
      inputs: [{ item_id: 'iron_ore', qty: 10 }],
    },
    {
      id: 'refine_iron_fast',
      name: 'Refine Iron (Fast)',
      output_item_id: 'steel_plate',
      output_qty: 2,
      ticks: 2,
      skills: ['Ore Refinement 1'],
      inputs: [{ item_id: 'iron_ore', qty: 5 }],
    },
    {
      id: 'copper_to_wiring',
      name: 'Copper to Wiring',
      output_item_id: 'copper_wiring',
      output_qty: 1,
      ticks: 3,
      skills: [],
      inputs: [{ item_id: 'copper_ore', qty: 8 }],
    },
    {
      id: 'multi_input_circuit',
      name: 'Multi-Input Circuit Board',
      output_item_id: 'circuit_board',
      output_qty: 2,
      ticks: 3,
      skills: ['Basic Crafting 2'],
      inputs: [
        { item_id: 'copper_ore', qty: 3 },
        { item_id: 'silicon_ore', qty: 2 },
      ],
    },
  ] as BomRecipe[],
};

let fixturePath: string;

beforeAll(() => {
  const dir = join(tmpdir(), `bom-test-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  fixturePath = join(dir, 'bom.json');
  writeFileSync(fixturePath, JSON.stringify(FIXTURE_BOM));
});

// ---------------------------------------------------------------------------
// loadBom
// ---------------------------------------------------------------------------

describe('loadBom', () => {
  it('loads and returns recipes array', () => {
    const recipes = loadBom(fixturePath);
    expect(recipes.length).toBe(4);
    expect(recipes[0].id).toBe('smelt_iron');
  });

  it('throws on missing file', () => {
    expect(() => loadBom('/nonexistent/path.json')).toThrow();
  });

  it('throws on malformed JSON', () => {
    const badPath = join(tmpdir(), 'bad-bom.json');
    writeFileSync(badPath, 'not-json{{{');
    expect(() => loadBom(badPath)).toThrow(/Failed to parse/);
  });

  it('throws on JSON without recipes array', () => {
    const noRecipesPath = join(tmpdir(), 'no-recipes-bom.json');
    writeFileSync(noRecipesPath, JSON.stringify({ _meta: {}, notRecipes: [] }));
    expect(() => loadBom(noRecipesPath)).toThrow(/missing "recipes"/);
  });
});

// ---------------------------------------------------------------------------
// evaluateRecipe
// ---------------------------------------------------------------------------

describe('evaluateRecipe', () => {
  const smeltRecipe = FIXTURE_BOM.recipes[0];
  const fastRefine = FIXTURE_BOM.recipes[1];
  const circuitRecipe = FIXTURE_BOM.recipes[3];

  it('returns null when output has no price', () => {
    const prices = new Map<string, PricePoint>([
      ['iron_ore', { bid: 4, ask: 5 }],
      // steel_plate intentionally missing
    ]);
    expect(evaluateRecipe(smeltRecipe, prices)).toBeNull();
  });

  it('returns null when output bid is 0', () => {
    const prices = new Map<string, PricePoint>([
      ['iron_ore', { bid: 4, ask: 5 }],
      ['steel_plate', { bid: 0, ask: 25 }],
    ]);
    expect(evaluateRecipe(smeltRecipe, prices)).toBeNull();
  });

  it('returns null when an input has no price', () => {
    const prices = new Map<string, PricePoint>([
      ['steel_plate', { bid: 100, ask: 110 }],
      // iron_ore missing
    ]);
    expect(evaluateRecipe(smeltRecipe, prices)).toBeNull();
  });

  it('calculates correct profit for simple recipe', () => {
    // smelt_iron: 10 iron_ore (ask=5 each = 50 cost) → 1 steel_plate (bid=80 revenue)
    const prices = new Map<string, PricePoint>([
      ['iron_ore', { bid: 4, ask: 5 }],
      ['steel_plate', { bid: 80, ask: 90 }],
    ]);
    const result = evaluateRecipe(smeltRecipe, prices);
    expect(result).not.toBeNull();
    expect(result!.total_input_cost).toBe(50);   // 10 * 5
    expect(result!.total_output_value).toBe(80);  // 1 * 80
    expect(result!.profit).toBe(30);
    expect(result!.margin_pct).toBe(60);          // 30/50 = 60%
    expect(result!.output_item_id).toBe('steel_plate');
  });

  it('handles output_qty > 1 correctly', () => {
    // refine_iron_fast: 5 iron_ore (ask=5 = 25) → 2 steel_plate (bid=80 = 160)
    const prices = new Map<string, PricePoint>([
      ['iron_ore', { bid: 4, ask: 5 }],
      ['steel_plate', { bid: 80, ask: 90 }],
    ]);
    const result = evaluateRecipe(fastRefine, prices);
    expect(result).not.toBeNull();
    expect(result!.total_input_cost).toBe(25);
    expect(result!.total_output_value).toBe(160);
    expect(result!.profit).toBe(135);
  });

  it('calculates profit_per_tick', () => {
    const prices = new Map<string, PricePoint>([
      ['iron_ore', { bid: 4, ask: 5 }],
      ['steel_plate', { bid: 80, ask: 90 }],
    ]);
    const result = evaluateRecipe(smeltRecipe, prices)!;
    // profit = 30, ticks = 3, so 10/tick
    expect(result.profit_per_tick).toBe(10);
  });

  it('handles multi-input recipes', () => {
    const prices = new Map<string, PricePoint>([
      ['copper_ore', { bid: 6, ask: 8 }],
      ['silicon_ore', { bid: 3, ask: 4 }],
      ['circuit_board', { bid: 200, ask: 220 }],
    ]);
    const result = evaluateRecipe(circuitRecipe, prices);
    expect(result).not.toBeNull();
    // 3*8 + 2*4 = 24 + 8 = 32 input cost, 2*200 = 400 output value
    expect(result!.total_input_cost).toBe(32);
    expect(result!.total_output_value).toBe(400);
    expect(result!.profit).toBe(368);
    expect(result!.inputs.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// findCraftChains
// ---------------------------------------------------------------------------

describe('findCraftChains', () => {
  beforeAll(() => {
    loadBom(fixturePath);
  });

  it('returns empty array when no ingredient filter and no profitable chains', () => {
    const prices = new Map<string, PricePoint>();
    const result = findCraftChains(undefined, prices);
    expect(result).toEqual([]);
  });

  it('filters by ingredient correctly', () => {
    const prices = new Map<string, PricePoint>([
      ['iron_ore', { bid: 4, ask: 5 }],
      ['steel_plate', { bid: 80, ask: 90 }],
    ]);
    const result = findCraftChains('iron_ore', prices);
    expect(result.length).toBe(2); // smelt_iron and refine_iron_fast
    expect(result.every((r) => r.recipe_id.includes('iron') || r.ingredient === 'iron_ore')).toBe(true);
  });

  it('returns chains sorted by profit descending', () => {
    const prices = new Map<string, PricePoint>([
      ['iron_ore', { bid: 4, ask: 5 }],
      ['steel_plate', { bid: 80, ask: 90 }],
    ]);
    const result = findCraftChains('iron_ore', prices);
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].profit).toBeGreaterThanOrEqual(result[i].profit);
    }
  });

  it('returns empty when ingredient has no recipes', () => {
    const prices = new Map<string, PricePoint>([
      ['platinum_ore', { bid: 500, ask: 600 }],
    ]);
    const result = findCraftChains('platinum_ore', prices);
    expect(result).toEqual([]);
  });

  it('filters by target output', () => {
    const prices = new Map<string, PricePoint>([
      ['copper_ore', { bid: 6, ask: 8 }],
      ['silicon_ore', { bid: 3, ask: 4 }],
      ['circuit_board', { bid: 200, ask: 220 }],
      ['copper_wiring', { bid: 50, ask: 60 }],
    ]);
    const result = findCraftChains('copper_ore', prices, 'circuit_board');
    expect(result.every((r) => r.output_item_id === 'circuit_board')).toBe(true);
  });

  it('excludes unprofitable chains (profit <= 0)', () => {
    const prices = new Map<string, PricePoint>([
      ['iron_ore', { bid: 4, ask: 5 }],
      ['steel_plate', { bid: 2, ask: 3 }], // output sells for less than inputs
    ]);
    const result = findCraftChains('iron_ore', prices);
    expect(result).toEqual([]);
  });

  it('returns all profitable chains when no ingredient specified', () => {
    const prices = new Map<string, PricePoint>([
      ['iron_ore', { bid: 4, ask: 5 }],
      ['steel_plate', { bid: 80, ask: 90 }],
      ['copper_ore', { bid: 6, ask: 8 }],
      ['copper_wiring', { bid: 50, ask: 60 }],
    ]);
    const result = findCraftChains(undefined, prices);
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((r) => r.profit > 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// findAllChains
// ---------------------------------------------------------------------------

describe('findAllChains', () => {
  beforeAll(() => {
    loadBom(fixturePath);
  });

  it('returns unpriceable when prices are missing', () => {
    const prices = new Map<string, PricePoint>();
    const result = findAllChains('iron_ore', prices);
    expect(result.unpriceable.length).toBeGreaterThan(0);
    expect(result.profitable).toEqual([]);
  });

  it('separates profitable from unpriceable', () => {
    const prices = new Map<string, PricePoint>([
      ['iron_ore', { bid: 4, ask: 5 }],
      ['steel_plate', { bid: 80, ask: 90 }],
      // copper_ore → copper_wiring missing prices → unpriceable
    ]);
    const result = findAllChains(undefined, prices);
    expect(result.profitable.length).toBeGreaterThan(0);
    expect(result.unpriceable.length).toBeGreaterThan(0);
  });
});
