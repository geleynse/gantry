import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { FLEET_DIR } from '../config.js';

export interface TimelineEntry {
  timestamp: string;
  type: 'order' | 'report' | 'bulletin';
  agent?: string;
  message: string;
}

const TIMESTAMP_RE = /^\[(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?.*?)\]/;

export function parseCommsTimeline(baseDir?: string): TimelineEntry[] {
  const base = baseDir ?? FLEET_DIR;
  const logsDir = join(base, 'logs');
  const entries: TimelineEntry[] = [];

  // Parse orders archive
  try {
    const ordersPath = join(logsDir, 'orders-archive.log');
    const ordersContent = readFileSync(ordersPath, 'utf-8');
    for (const line of ordersContent.split('\n')) {
      const match = line.match(TIMESTAMP_RE);
      if (match) {
        entries.push({
          timestamp: match[1],
          type: 'order',
          message: line.slice(match[0].length).trim(),
        });
      }
    }
  } catch {
    // No orders archive — skip
  }

  // Parse agent comms logs
  try {
    const files = readdirSync(logsDir);
    for (const file of files) {
      if (!file.endsWith('-comms.log')) continue;
      const agent = basename(file, '-comms.log');
      try {
        const content = readFileSync(join(logsDir, file), 'utf-8');
        const blocks = content.split('---');
        for (const block of blocks) {
          const trimmed = block.trim();
          if (!trimmed) continue;
          const match = trimmed.match(TIMESTAMP_RE);
          if (match) {
            const message = trimmed.slice(match[0].length).trim();
            entries.push({
              timestamp: match[1],
              type: 'report',
              agent,
              message,
            });
          }
        }
      } catch {
        // Skip unreadable comms file
      }
    }
  } catch {
    // No logs directory — skip
  }

  // Sort chronologically
  entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return entries;
}
