import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createDatabase, closeDb, getDb } from './database.js';
import {
  getActiveDirectives,
  addDirective,
  removeDirective,
  listDirectives,
} from './directives.js';

describe('directives service', () => {
  beforeEach(() => {
    createDatabase(':memory:');
  });

  afterEach(() => {
    closeDb();
  });

  it('returns empty array when no directives exist', () => {
    const result = getActiveDirectives('drifter-gale');
    expect(result).toHaveLength(0);
  });

  it('adds a directive and retrieves it', () => {
    const id = addDirective('drifter-gale', 'Stay in Sol system', 'high');
    expect(id).toBeGreaterThan(0);

    const rows = getActiveDirectives('drifter-gale');
    expect(rows).toHaveLength(1);
    expect(rows[0].directive).toBe('Stay in Sol system');
    expect(rows[0].priority).toBe('high');
    expect(rows[0].active).toBe(1);
    expect(rows[0].agent_name).toBe('drifter-gale');
  });

  it('defaults priority to normal', () => {
    addDirective('drifter-gale', 'Mine iron ore');
    const rows = getActiveDirectives('drifter-gale');
    expect(rows[0].priority).toBe('normal');
  });

  it('removes a directive by deactivating it', () => {
    const id = addDirective('drifter-gale', 'Go to Proxima');
    const ok = removeDirective(id);
    expect(ok).toBe(true);

    const rows = getActiveDirectives('drifter-gale');
    expect(rows).toHaveLength(0);
  });

  it('remove returns false for non-existent id', () => {
    const ok = removeDirective(99999);
    expect(ok).toBe(false);
  });

  it('remove returns false for already-inactive directive', () => {
    const id = addDirective('drifter-gale', 'Test');
    removeDirective(id);
    const ok = removeDirective(id);
    expect(ok).toBe(false);
  });

  it('isolates directives per agent', () => {
    addDirective('drifter-gale', 'Gale directive');
    addDirective('sable-thorn', 'Sable directive');

    expect(getActiveDirectives('drifter-gale')).toHaveLength(1);
    expect(getActiveDirectives('sable-thorn')).toHaveLength(1);
    expect(getActiveDirectives('drifter-gale')[0].directive).toBe('Gale directive');
  });

  it('orders by priority (critical first)', () => {
    addDirective('drifter-gale', 'Low priority', 'low');
    addDirective('drifter-gale', 'Critical priority', 'critical');
    addDirective('drifter-gale', 'Normal priority', 'normal');
    addDirective('drifter-gale', 'High priority', 'high');

    const rows = getActiveDirectives('drifter-gale');
    expect(rows[0].priority).toBe('critical');
    expect(rows[1].priority).toBe('high');
    expect(rows[2].priority).toBe('normal');
    expect(rows[3].priority).toBe('low');
  });

  it('filters expired directives', () => {
    // Insert with an already-past expiry
    getDb().prepare(
      `INSERT INTO agent_directives (agent_name, directive, priority, expires_at)
       VALUES (?, ?, ?, datetime('now', '-1 minute'))`,
    ).run('drifter-gale', 'Expired directive', 'normal');

    const rows = getActiveDirectives('drifter-gale');
    expect(rows).toHaveLength(0);
  });

  it('includes non-expired directives with future expiry', () => {
    const future = new Date(Date.now() + 60_000).toISOString().replace('T', ' ').slice(0, 19);
    addDirective('drifter-gale', 'Future expiry directive', 'normal', future);

    const rows = getActiveDirectives('drifter-gale');
    expect(rows).toHaveLength(1);
  });

  it('listDirectives returns inactive directives too', () => {
    const id = addDirective('drifter-gale', 'Will be removed');
    removeDirective(id);

    const all = listDirectives('drifter-gale');
    expect(all).toHaveLength(1);
    expect(all[0].active).toBe(0);
  });

  it('listDirectives without agent returns all agents', () => {
    addDirective('drifter-gale', 'Gale dir');
    addDirective('sable-thorn', 'Sable dir');

    const all = listDirectives();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });
});
