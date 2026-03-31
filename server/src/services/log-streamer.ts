/**
 * log-streamer.ts
 *
 * Tails agent log files in real-time using fs.watchFile() and pushes new lines
 * to registered callbacks. Used by the /api/activity/agent-stream/:name SSE
 * endpoint to stream live agent output.
 *
 * Design notes:
 * - Uses fs.watchFile() (stat polling) rather than fs.watch() for portability.
 *   fs.watch() uses inotify on Linux but has subtleties on network mounts;
 *   fs.watchFile() polls at a configurable interval and works everywhere.
 * - Each tailer tracks its byte offset so only new bytes are read on each change.
 * - Lines that look like tool call JSON-RPC are filtered; only assistant
 *   reasoning lines are forwarded.
 * - File rotation / truncation is handled: if the file shrinks we reset to 0.
 */

import { watchFile, unwatchFile } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { FLEET_DIR } from '../config.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('log-streamer');

/** Interval for fs.watchFile polling, in milliseconds. */
const POLL_INTERVAL_MS = 500;

/** Max bytes to read per poll cycle (safety limit). */
const MAX_READ_BYTES = 65536; // 64 KB

export type LineCallback = (line: string) => void;

interface Tailer {
  logPath: string;
  offset: number;
  callback: LineCallback;
}

const activeTailers = new Map<string, Tailer>();

/**
 * Lines matching these patterns are already captured by the tool-call-logger;
 * skip them to avoid duplication.
 */
const SKIP_LINE_PATTERNS = [
  /^\s*\{.*"jsonrpc"/,           // JSON-RPC messages
  /^\s*Tool:/,                    // "Tool: name" lines
  /^\s*Result:/,                  // "Result: ..." lines
  /^\s*\[[\d-T:.Z]+\]/,          // Timestamp-prefixed metadata lines from log-parser
  /^---+\s*$/,                    // Separator lines
];

function shouldSkipLine(line: string): boolean {
  return !line.trim() || SKIP_LINE_PATTERNS.some(p => p.test(line));
}

/**
 * Read new bytes from offset, return new lines and updated offset.
 * Handles truncation by resetting offset to 0 if file shrank.
 */
async function readNewLines(logPath: string, fromOffset: number): Promise<{ lines: string[]; offset: number }> {
  let fh;
  try {
    fh = await open(logPath, 'r');
    const stat = await fh.stat();
    const size = stat.size;

    // File was truncated / rotated
    if (fromOffset > size) fromOffset = 0;
    if (fromOffset === size) return { lines: [], offset: size };

    const toRead = Math.min(size - fromOffset, MAX_READ_BYTES);
    const buf = Buffer.alloc(toRead);
    const { bytesRead } = await fh.read(buf, 0, toRead, fromOffset);
    const text = buf.subarray(0, bytesRead).toString('utf-8');

    const lines = text.split('\n').filter((l) => l !== '');
    return { lines, offset: fromOffset + bytesRead };
  } catch {
    return { lines: [], offset: fromOffset };
  } finally {
    await fh?.close();
  }
}

/**
 * Start tailing an agent's log file, pushing new assistant-output lines via callback.
 * Safe to call multiple times for the same agent — previous tailer is stopped first.
 */
export async function startTailing(agentName: string, onLine: LineCallback): Promise<void> {
  // Stop any existing tailer for this agent
  stopTailing(agentName);

  const logPath = join(FLEET_DIR, 'logs', `${agentName}.log`);

  // Seek to current end so we only stream new output
  let initialOffset = 0;
  try {
    const fh = await open(logPath, 'r');
    const stat = await fh.stat();
    initialOffset = stat.size;
    await fh.close();
  } catch {
    // File may not exist yet — start at 0, will create when agent starts
  }

  const tailer: Tailer = {
    logPath,
    offset: initialOffset,
    callback: onLine,
  };

  activeTailers.set(agentName, tailer);

  watchFile(logPath, { interval: POLL_INTERVAL_MS, persistent: false }, async () => {
    const current = activeTailers.get(agentName);
    if (!current) return; // was stopped

    try {
      const { lines, offset } = await readNewLines(current.logPath, current.offset);
      current.offset = offset;

      for (const line of lines) {
        if (!shouldSkipLine(line)) {
          try {
            current.callback(line);
          } catch (err) {
            log.warn(`Line callback error for ${agentName}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    } catch (err) {
      log.warn(`Poll error for ${agentName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  log.debug(`Started tailing ${agentName} at offset ${initialOffset}`);
}

/**
 * Stop tailing for a specific agent.
 */
export function stopTailing(agentName: string): void {
  const tailer = activeTailers.get(agentName);
  if (!tailer) return;

  activeTailers.delete(agentName);
  try {
    unwatchFile(tailer.logPath);
  } catch {
    // Already unwatched or path invalid — ignore
  }
  log.debug(`Stopped tailing ${agentName}`);
}

/**
 * Stop all active tailers. Call during graceful shutdown.
 */
export function stopAllTailers(): void {
  for (const agentName of activeTailers.keys()) {
    stopTailing(agentName);
  }
  log.debug('All tailers stopped');
}

/**
 * Return the names of all currently-active tailers (for diagnostics).
 */
export function getActiveTailers(): string[] {
  return [...activeTailers.keys()];
}
