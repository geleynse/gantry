import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileWatcher } from './file-watcher.js';

describe('FileWatcher', () => {
  let testDir: string;
  let logFile: string;

  beforeEach(() => {
    testDir = join(tmpdir(), 'file-watcher-test-' + Date.now());
    mkdirSync(testDir, { recursive: true });
    logFile = join(testDir, 'test.log');
    writeFileSync(logFile, 'line1\nline2\nline3\n');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('reads tail of file on initial connect', async () => {
    const watcher = new FileWatcher(logFile);
    const result = await watcher.readTail(100);
    expect(result.lines).toEqual(['line1', 'line2', 'line3']);
    expect(result.offset).toBeGreaterThan(0);
    watcher.close();
  });

  it('reads new lines after append', async () => {
    const watcher = new FileWatcher(logFile);
    const initial = await watcher.readTail(100);

    appendFileSync(logFile, 'line4\nline5\n');

    const newLines = await watcher.readFrom(initial.offset);
    expect(newLines.lines).toEqual(['line4', 'line5']);
    watcher.close();
  });

  it('reads history with offset and limit', async () => {
    writeFileSync(logFile, Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n') + '\n');
    const watcher = new FileWatcher(logFile);

    const result = await watcher.readHistory(0, 10);
    expect(result.lines.length).toBe(10);
    expect(result.lines[0]).toBe('line0');
    watcher.close();
  });

  it('returns empty for nonexistent file', async () => {
    const watcher = new FileWatcher(join(testDir, 'nope.log'));
    const result = await watcher.readTail(100);
    expect(result.lines).toEqual([]);
    expect(result.offset).toBe(0);
    watcher.close();
  });
});
