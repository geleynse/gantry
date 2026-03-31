import { describe, it, expect } from 'bun:test';
import { COMPOUND_TOOL_DESCRIPTIONS, COMPOUND_TOOL_NAMES } from './descriptions.js';

describe('compound tool descriptions', () => {
  it('contains all expected compound tools', () => {
    const expected = [
      'batch_mine',
      'travel_to',
      'jump_route',
      'multi_sell',
      'scan_and_attack',
      'loot_wrecks',
      'battle_readiness',
      'flee',
    ];
    for (const name of expected) {
      expect(COMPOUND_TOOL_NAMES.has(name)).toBe(true);
    }
  });

  it('descriptions are non-empty strings', () => {
    for (const [name, desc] of Object.entries(COMPOUND_TOOL_DESCRIPTIONS)) {
      expect(typeof desc).toBe('string');
      expect(desc.length).toBeGreaterThan(0);
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it('COMPOUND_TOOL_NAMES set matches COMPOUND_TOOL_DESCRIPTIONS keys', () => {
    const descKeys = new Set(Object.keys(COMPOUND_TOOL_DESCRIPTIONS));
    expect(COMPOUND_TOOL_NAMES.size).toBe(descKeys.size);
    for (const key of descKeys) {
      expect(COMPOUND_TOOL_NAMES.has(key)).toBe(true);
    }
  });
});
