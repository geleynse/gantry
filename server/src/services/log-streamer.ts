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
 *
 * Multi-subscriber fan-out (bug #116):
 * - There is at most ONE underlying tail (fs.watchFile registration + byte
 *   offset) per agent, but it may have MANY subscribers (e.g. two browser
 *   tabs watching the same agent's live log via separate SSE connections).
 * - `startTailing` starts the underlying tail only for the FIRST subscriber;
 *   subsequent calls for the same agent just add another callback to the
 *   existing tailer's subscriber set (mirrors the Set<Subscriber> fan-out
 *   pattern already used in proxy/tool-call-logger.ts).
 * - `stopTailing(agentName, onLine)` removes only that one subscriber; the
 *   underlying tail is torn down (unwatchFile) only when the LAST subscriber
 *   leaves. Calling `stopTailing(agentName)` with no callback force-stops the
 *   tail for everyone (used by stopAllTailers / shutdown).
 */

import { watchFile, unwatchFile } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { FLEET_DIR } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { FileWatcher } from './file-watcher.js';

const log = createLogger('log-streamer');

/** Interval for fs.watchFile polling, in milliseconds. */
const POLL_INTERVAL_MS = 500;

export type LineCallback = (line: string) => void;

interface Tailer {
  logPath: string;
  watcher: FileWatcher;
  offset: number;
  /** All viewers currently subscribed to this agent's live log. */
  subscribers: Set<LineCallback>;
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
 * Start tailing an agent's log file, pushing new assistant-output lines via callback.
 *
 * Multiple viewers may watch the same agent concurrently: if a tailer is
 * already active for `agentName`, `onLine` is simply added as an additional
 * subscriber and the existing tail (offset, fs.watchFile registration) is left
 * untouched. The underlying tail is only started for the very first subscriber.
 */
export async function startTailing(agentName: string, onLine: LineCallback): Promise<void> {
  const existing = activeTailers.get(agentName);
  if (existing) {
    existing.subscribers.add(onLine);
    return;
  }

  const logPath = join(FLEET_DIR, 'logs', `${agentName}.log`);

  const tailer: Tailer = {
    logPath,
    watcher: new FileWatcher(logPath),
    offset: 0,
    subscribers: new Set([onLine]),
  };

  // Register synchronously (before the `await stat` below) so a concurrent
  // startTailing() call for the same agent — which can interleave here since
  // this function is async — finds this tailer and joins it as a subscriber
  // instead of racing to create a second, independent tail.
  activeTailers.set(agentName, tailer);

  // Seek to current end so we only stream new output
  try {
    tailer.offset = (await stat(logPath)).size;
  } catch {
    // File may not exist yet — start at 0, will create when agent starts
  }

  // If every subscriber unsubscribed while we were awaiting the initial stat
  // (e.g. the sole viewer disconnected immediately), the tailer has already
  // been torn down by stopTailing. Don't start a poller nobody is listening
  // to — that would leak an fs.watchFile registration forever.
  if (activeTailers.get(agentName) !== tailer) {
    return;
  }

  watchFile(logPath, { interval: POLL_INTERVAL_MS, persistent: false }, async () => {
    const current = activeTailers.get(agentName);
    if (!current) return; // was stopped

    try {
      const { lines, offset } = await current.watcher.readFrom(current.offset);
      current.offset = offset;

      for (const line of lines) {
        if (shouldSkipLine(line)) continue;
        // Fan out to every subscriber; one subscriber's error must not
        // affect delivery to the others.
        for (const cb of current.subscribers) {
          try {
            cb(line);
          } catch (err) {
            log.warn(`Line callback error for ${agentName}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    } catch (err) {
      log.warn(`Poll error for ${agentName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  log.debug(`Started tailing ${agentName} at offset ${tailer.offset}`);
}

/**
 * Stop tailing for a specific agent.
 *
 * When `onLine` is provided, only that subscriber is removed; the underlying
 * tail keeps running as long as at least one subscriber remains. It is only
 * unwatched (unwatchFile) once the LAST subscriber leaves.
 *
 * When `onLine` is omitted, every subscriber is dropped and the tail is force
 * stopped regardless of how many viewers remain — used by stopAllTailers()
 * and other admin/shutdown paths, not by individual SSE viewers.
 */
export function stopTailing(agentName: string, onLine?: LineCallback): void {
  const tailer = activeTailers.get(agentName);
  if (!tailer) return;

  if (onLine) {
    tailer.subscribers.delete(onLine);
    if (tailer.subscribers.size > 0) return; // other viewers still watching
  } else {
    tailer.subscribers.clear();
  }

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

/**
 * Return the number of active subscribers for an agent's tail (0 if not
 * tailing). Used for diagnostics and tests.
 */
export function getSubscriberCount(agentName: string): number {
  return activeTailers.get(agentName)?.subscribers.size ?? 0;
}
