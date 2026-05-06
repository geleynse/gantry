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

function parseLogLines(content: string): { timestamp: string; message: string }[] {
  const results: { timestamp: string; message: string }[] = [];
  for (const line of content.split('\n')) {
    const match = line.match(TIMESTAMP_RE);
    if (match) {
      results.push({
        timestamp: match[1],
        message: line.slice(match[0].length).trim(),
      });
    }
  }
  return results;
}

export function parseCommsTimeline(baseDir?: string): TimelineEntry[] {
  const base = baseDir ?? FLEET_DIR;
  const logsDir = join(base, 'logs');
  const entries: TimelineEntry[] = [];

  // Parse orders archive
  try {
    const ordersContent = readFileSync(join(logsDir, 'orders-archive.log'), 'utf-8');
    for (const parsed of parseLogLines(ordersContent)) {
      entries.push({
        timestamp: parsed.timestamp,
        type: 'order',
        message: parsed.message,
      });
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
        for (const parsed of parseLogLines(content)) {
          entries.push({
            timestamp: parsed.timestamp,
            type: 'report',
            agent,
            message: parsed.message,
          });
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
