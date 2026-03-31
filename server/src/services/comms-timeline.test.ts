import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseCommsTimeline } from './comms-timeline.js';

describe('comms-timeline', () => {
  const tempDirs: string[] = [];

  function makeTempBase(): string {
    const dir = mkdtempSync(join(tmpdir(), 'comms-timeline-'));
    mkdirSync(join(dir, 'logs'), { recursive: true });
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it('parses orders archive into timeline entries', () => {
    const base = makeTempBase();
    writeFileSync(
      join(base, 'logs', 'orders-archive.log'),
      '[2026-02-15 12:00] All agents mine asteroids\n[2026-02-15 13:00] Regroup at station\n'
    );

    const entries = parseCommsTimeline(base);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      timestamp: '2026-02-15 12:00',
      type: 'order',
      message: 'All agents mine asteroids',
    });
    expect(entries[1]).toEqual({
      timestamp: '2026-02-15 13:00',
      type: 'order',
      message: 'Regroup at station',
    });
  });

  it('parses agent comms archives into timeline entries', () => {
    const base = makeTempBase();
    writeFileSync(
      join(base, 'logs', 'drifter-gale-comms.log'),
      '[2026-02-15 10:00] Arrived at sector 7\n---\n[2026-02-15 11:00] Mining complete\n'
    );

    const entries = parseCommsTimeline(base);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      timestamp: '2026-02-15 10:00',
      type: 'report',
      agent: 'drifter-gale',
      message: 'Arrived at sector 7',
    });
    expect(entries[1]).toEqual({
      timestamp: '2026-02-15 11:00',
      type: 'report',
      agent: 'drifter-gale',
      message: 'Mining complete',
    });
  });

  it('returns entries sorted chronologically', () => {
    const base = makeTempBase();
    writeFileSync(
      join(base, 'logs', 'orders-archive.log'),
      '[2026-02-15 12:00] Late order\n'
    );
    writeFileSync(
      join(base, 'logs', 'sable-thorn-comms.log'),
      '[2026-02-15 10:00] Early report\n'
    );

    const entries = parseCommsTimeline(base);

    expect(entries).toHaveLength(2);
    expect(entries[0].timestamp).toBe('2026-02-15 10:00');
    expect(entries[0].type).toBe('report');
    expect(entries[1].timestamp).toBe('2026-02-15 12:00');
    expect(entries[1].type).toBe('order');
  });

  it('returns empty array when no logs directory exists', () => {
    const base = mkdtempSync(join(tmpdir(), 'comms-timeline-empty-'));
    tempDirs.push(base);

    const entries = parseCommsTimeline(base);

    expect(entries).toEqual([]);
  });
});
