import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FLEET_DIR } from '../config.js';

export interface ParsedLog {
  turnCount: number;
  lastTurnTime: string | null;
  lastTurnAgeSeconds: number | null;
  quotaHits: number;
  authHits: number;
  state: 'running' | 'backed-off' | 'stale';
  lastGameOutput: string[];
}

export async function parseAgentLog(agentName: string, maxLines = 200): Promise<ParsedLog | null> {
  const logPath = join(FLEET_DIR, 'logs', `${agentName}.log`);

  let content: string;
  try {
    content = await readFile(logPath, 'utf-8');
  } catch {
    return null;
  }

  const allLines = content.split('\n');
  const lines = allLines.slice(-maxLines);

  // Turn count (in this window)
  // Matches both formats:
  //   console log: "[2026-03-22T22:02:31Z] [turn 1] Starting turn"
  //   main .log:   "[2026-03-22T22:02:31Z] [turn 1]"
  const turnLines = lines.filter(l => l.includes('Starting turn') || l.includes('Starting [') || /\[turn \d+\]/.test(l));
  const turnCount = turnLines.length;

  // Last turn timestamp
  let lastTurnTime: string | null = null;
  let lastTurnAgeSeconds: number | null = null;
  if (turnLines.length > 0) {
    const lastTurn = turnLines.at(-1)!;
    const match = lastTurn.match(/^\[([^\]]+)\]/);
    if (match) {
      lastTurnTime = match[1];
      const turnDate = new Date(lastTurnTime);
      if (!isNaN(turnDate.getTime())) {
        lastTurnAgeSeconds = Math.floor((Date.now() - turnDate.getTime()) / 1000);
      }
    }
  }

  // Quota + auth hits in last 50 lines (single pass)
  const recentLines = lines.slice(-50);
  const quotaPattern = /rate limit|CLI rate limit|Server overload|backing off/i;
  const authPattern = /auth error|unauthorized|token.*expired|oauth|forbidden|credentials/i;
  let quotaHits = 0;
  let authHits = 0;
  for (const l of recentLines) {
    if (quotaPattern.test(l)) quotaHits++;
    if (authPattern.test(l)) authHits++;
  }

  // State detection
  let state: 'running' | 'backed-off' | 'stale' = 'running';
  const lastFew = lines.slice(-5);
  if (lastFew.some(l => /backing off/.test(l))) {
    state = 'backed-off';
  } else if (lastTurnAgeSeconds !== null && lastTurnAgeSeconds > 1800) {
    state = 'stale';
  }

  // Last game output (non-metadata lines)
  const gameLines = lines
    .filter(l => !l.startsWith('[') && l.trim() !== '' && l.trim() !== '---')
    .slice(-3);

  return {
    turnCount,
    lastTurnTime,
    lastTurnAgeSeconds,
    quotaHits,
    authHits,
    state,
    lastGameOutput: gameLines,
  };
}

export async function readFullLog(agentName: string): Promise<string> {
  const logPath = join(FLEET_DIR, 'logs', `${agentName}.log`);
  try {
    return await readFile(logPath, 'utf-8');
  } catch {
    return '';
  }
}

export function formatAge(seconds: number): string {
  if (seconds >= 3600) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h${m}m`;
  }
  if (seconds >= 60) {
    return `${Math.floor(seconds / 60)}m`;
  }
  return `${seconds}s`;
}
