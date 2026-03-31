import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  writeFileSync,
  mkdirSync,
  rmSync,
  appendFileSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// We test shouldSkipLine logic by importing the filtering patterns indirectly
// via the log-streamer module's tailing behavior on a controlled log file.
// We cannot easily mock FLEET_DIR so we test the internal helpers by constructing
// a minimal scenario with a known log path.

// ---------------------------------------------------------------------------
// Inline helper tests for line filtering (unit-level, no file system)
// ---------------------------------------------------------------------------

/** Mirrors the SKIP_LINE_PATTERNS from log-streamer.ts */
const SKIP_LINE_PATTERNS = [
  /^\s*\{.*"jsonrpc"/,
  /^\s*Tool:/,
  /^\s*Result:/,
  /^\s*\[[\d-T:.Z]+\]/,
  /^---+\s*$/,
];

function shouldSkipLine(line: string): boolean {
  if (!line.trim()) return true;
  for (const pattern of SKIP_LINE_PATTERNS) {
    if (pattern.test(line)) return true;
  }
  return false;
}

describe('log-streamer line filtering', () => {
  it('skips empty lines', () => {
    expect(shouldSkipLine('')).toBe(true);
    expect(shouldSkipLine('   ')).toBe(true);
  });

  it('skips JSON-RPC lines', () => {
    expect(shouldSkipLine('{"jsonrpc":"2.0","method":"tools/call"}')).toBe(true);
  });

  it('skips Tool: prefix lines', () => {
    expect(shouldSkipLine('Tool: batch_mine')).toBe(true);
  });

  it('skips Result: lines', () => {
    expect(shouldSkipLine('Result: {"ok":true}')).toBe(true);
  });

  it('skips timestamp-prefixed metadata lines', () => {
    expect(shouldSkipLine('[2026-03-07T12:00:00.000Z] Starting turn')).toBe(true);
  });

  it('skips separator lines', () => {
    expect(shouldSkipLine('---')).toBe(true);
    expect(shouldSkipLine('--------')).toBe(true);
  });

  it('passes through assistant reasoning lines', () => {
    expect(shouldSkipLine('I should consider mining the asteroid belt next.')).toBe(false);
    expect(shouldSkipLine('Let me check the market before selling.')).toBe(false);
  });

  it('passes through regular narrative lines', () => {
    expect(shouldSkipLine('Docking at Cinder Station to sell ore.')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FileWatcher integration: test readFrom behavior (used by log-streamer)
// ---------------------------------------------------------------------------

import { FileWatcher } from './file-watcher.js';

describe('log-streamer file tailing (via FileWatcher)', () => {
  let testDir: string;
  let logFile: string;

  beforeEach(() => {
    testDir = join(tmpdir(), 'log-streamer-test-' + Date.now());
    mkdirSync(testDir, { recursive: true });
    logFile = join(testDir, 'agent.log');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('starts at end of file so existing lines are skipped', async () => {
    writeFileSync(logFile, 'old line 1\nold line 2\n');
    const watcher = new FileWatcher(logFile);
    const initial = await watcher.readTail(1000);
    // Offset is at end of existing content
    expect(initial.offset).toBeGreaterThan(0);

    // Append new content after we "connected"
    appendFileSync(logFile, 'new line 1\n');
    const { lines } = await watcher.readFrom(initial.offset);
    expect(lines).toContain('new line 1');
    // Old lines should NOT appear
    expect(lines).not.toContain('old line 1');
    watcher.close();
  });

  it('emits multiple new lines appended after offset', async () => {
    writeFileSync(logFile, 'existing\n');
    const watcher = new FileWatcher(logFile);
    const initial = await watcher.readTail(1000);

    appendFileSync(logFile, 'line A\nline B\nline C\n');
    const { lines } = await watcher.readFrom(initial.offset);
    expect(lines).toEqual(['line A', 'line B', 'line C']);
    watcher.close();
  });

  it('handles file truncation by resetting to 0', async () => {
    writeFileSync(logFile, 'initial content\n');
    const watcher = new FileWatcher(logFile);
    const initial = await watcher.readTail(1000);
    const bigOffset = initial.offset + 9999; // simulate stale offset after rotation

    // Write new content (truncate = fresh write)
    writeFileSync(logFile, 'rotated line\n');
    const { lines, offset } = await watcher.readFrom(bigOffset);
    // Should reset and read from 0
    expect(lines).toContain('rotated line');
    expect(offset).toBeGreaterThan(0);
    watcher.close();
  });

  it('returns empty when no new content', async () => {
    writeFileSync(logFile, 'static content\n');
    const watcher = new FileWatcher(logFile);
    const initial = await watcher.readTail(1000);
    const { lines } = await watcher.readFrom(initial.offset);
    expect(lines).toEqual([]);
    watcher.close();
  });
});
