import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FLEET_DIR } from '../config.js';
import type { UsageSummary } from '../shared/types.js';

export type { UsageSummary };

export interface ClaudeUsageEntry {
  timestamp: string;
  turn: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  iterations: number;
  durationMs: number;
}

export interface CodexUsageEntry {
  timestamp: string;
  turn: number;
  totalTokens: number | null;
}

export type UsageEntry = ClaudeUsageEntry | CodexUsageEntry;

// ---------------------------------------------------------------------------
// Codex cost estimation — static pricing table ($/1K tokens, blended input+output avg)
// Source: https://openai.com/api/pricing (March 2026)
// ---------------------------------------------------------------------------

const CODEX_PRICING: Record<string, number> = {
  // GPT-5.x flagship
  'gpt-5.4':            0.00875,  // $2.50 in / $15.00 out per 1M
  'gpt-5.4-mini':       0.002625, // $0.75 in / $4.50 out per 1M
  'gpt-5.4-nano':       0.000725, // $0.20 in / $1.25 out per 1M
  // GPT-5.x codex-optimized
  'gpt-5.3-codex':      0.007875, // $1.75 in / $14.00 out per 1M
  'gpt-5.2-codex':      0.007875, // $1.75 in / $14.00 out per 1M
  'gpt-5.1-codex-max':  0.005625, // $1.25 in / $10.00 out per 1M
  'gpt-5.1-codex':      0.005625, // $1.25 in / $10.00 out per 1M
  'gpt-5-codex':        0.005625, // $1.25 in / $10.00 out per 1M
  // GPT-5.x chat
  'gpt-5.3-chat-latest': 0.007875, // $1.75 in / $14.00 out per 1M
  'gpt-5.2-chat-latest': 0.007875, // $1.75 in / $14.00 out per 1M
  'gpt-5.1-chat-latest': 0.005625, // $1.25 in / $10.00 out per 1M
  'gpt-5-chat-latest':   0.005625, // $1.25 in / $10.00 out per 1M
  // GPT-5.x mini
  'gpt-5.1-codex-mini':  0.0015,  // est. $1.50/M blended
  'gpt-5-codex-mini':    0.0015,  // est. $1.50/M blended
  // GPT-4.1
  'gpt-4.1-mini':       0.002,    // $0.80 in / $3.20 out per 1M (fine-tuned pricing)
  'gpt-4.1-nano':       0.0005,   // $0.20 in / $0.80 out per 1M
  // Reasoning
  'o4-mini':            0.010,    // $4.00 in / $16.00 out per 1M
  'o3-mini':            0.0011,   // $1.10/M est.
  'codex-mini':         0.0015,
};

const DEFAULT_CODEX_RATE = 0.007875; // $1.75+$14.00 blended — matches gpt-5.3-codex

/** Estimate USD cost from total token count using model-based pricing. */
export function estimateCodexCost(totalTokens: number, model?: string): number {
  const rate = (model && CODEX_PRICING[model.toLowerCase()]) || DEFAULT_CODEX_RATE;
  return (totalTokens / 1000) * rate;
}

const CLAUDE_PATTERN = /^\[([^\]]+)\] \[turn (\d+)\] cost=([\d.]+) +input=(\d+) +output=(\d+) +cache_read=(\d+) +cache_create=(\d+) +iters=(\d+) +duration=(\d+)ms$/;
const CODEX_PATTERN = /^\[([^\]]+)\] \[turn (\d+)\] tokens=(\w+)$/;

export async function parseUsageLog(agentName: string): Promise<UsageEntry[]> {
  const logPath = join(FLEET_DIR, 'logs', `${agentName}-usage.log`);

  let content: string;
  try {
    content = await readFile(logPath, 'utf-8');
  } catch {
    return [];
  }

  const entries: UsageEntry[] = [];

  for (const line of content.split('\n')) {
    const claudeMatch = line.match(CLAUDE_PATTERN);
    if (claudeMatch) {
      entries.push({
        timestamp: claudeMatch[1],
        turn: parseInt(claudeMatch[2], 10),
        cost: parseFloat(claudeMatch[3]),
        inputTokens: parseInt(claudeMatch[4], 10),
        outputTokens: parseInt(claudeMatch[5], 10),
        cacheReadTokens: parseInt(claudeMatch[6], 10),
        cacheCreateTokens: parseInt(claudeMatch[7], 10),
        iterations: parseInt(claudeMatch[8], 10),
        durationMs: parseInt(claudeMatch[9], 10),
      });
      continue;
    }

    const codexMatch = line.match(CODEX_PATTERN);
    if (codexMatch) {
      const tokStr = codexMatch[3];
      entries.push({
        timestamp: codexMatch[1],
        turn: parseInt(codexMatch[2], 10),
        totalTokens: tokStr === 'unknown' ? null : parseInt(tokStr, 10),
      });
    }
  }

  return entries;
}

function isClaudeEntry(e: UsageEntry): e is ClaudeUsageEntry {
  return 'cost' in e;
}

function computeCostPerHour(totalCost: number, firstTimestamp: string, lastTimestamp: string): number | undefined {
  const elapsedMs = new Date(lastTimestamp).getTime() - new Date(firstTimestamp).getTime();
  return elapsedMs > 0 ? totalCost / (elapsedMs / 3_600_000) : undefined;
}

export async function getAgentUsageSummary(agentName: string, model?: string): Promise<UsageSummary> {
  const entries = await parseUsageLog(agentName);

  if (entries.length === 0) {
    return { turnCount: 0 };
  }

  const claudeEntries = entries.filter(isClaudeEntry);
  const codexEntries = entries.filter((e): e is CodexUsageEntry => !isClaudeEntry(e));

  if (claudeEntries.length > 0) {
    let totalCost = 0, totalInputTokens = 0, totalOutputTokens = 0;
    let totalCacheReadTokens = 0, totalCacheCreateTokens = 0;
    let totalIterations = 0, totalDurationMs = 0;
    for (const e of claudeEntries) {
      totalCost += e.cost;
      totalInputTokens += e.inputTokens;
      totalOutputTokens += e.outputTokens;
      totalCacheReadTokens += e.cacheReadTokens;
      totalCacheCreateTokens += e.cacheCreateTokens;
      totalIterations += e.iterations;
      totalDurationMs += e.durationMs;
    }

    const costPerHour = computeCostPerHour(totalCost, claudeEntries[0].timestamp, claudeEntries[claudeEntries.length - 1].timestamp);

    return {
      turnCount: entries.length,
      costPerHour,
      totalCost,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalCacheCreateTokens,
      totalIterations,
      avgCostPerTurn: totalCost / claudeEntries.length,
      avgDurationMs: Math.round(totalDurationMs / claudeEntries.length),
    };
  }

  const knownEntries = codexEntries.filter(e => e.totalTokens !== null);
  const totalTokens = knownEntries.reduce((s, e) => s + (e.totalTokens ?? 0), 0);

  // Estimate costs from token counts
  const totalCost = knownEntries.length > 0 ? estimateCodexCost(totalTokens, model) : undefined;
  const avgCostPerTurn = totalCost !== undefined && knownEntries.length > 0
    ? totalCost / knownEntries.length
    : undefined;

  const costPerHour = totalCost !== undefined && codexEntries.length >= 2
    ? computeCostPerHour(totalCost, codexEntries[0].timestamp, codexEntries[codexEntries.length - 1].timestamp)
    : undefined;

  return {
    turnCount: codexEntries.length,
    totalCost,
    avgCostPerTurn,
    costPerHour,
    totalTokens,
    avgTokensPerTurn: knownEntries.length > 0 ? Math.round(totalTokens / knownEntries.length) : undefined,
  };
}
