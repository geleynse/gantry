import type { Analytics } from '../shared/types.js';
import { AGENTS, getAgentLabel } from '../config.js';
import { readFullLog } from './log-parser.js';
import { getAgentUsageSummary } from './usage-parser.js';

export async function getAnalytics(agentName: string): Promise<Analytics> {
  const agent = AGENTS.find(a => a.name === agentName);
  if (!agent) {
    return { name: agentName, backend: 'unknown', totalTurns: 0, quotaHits: 0, successRate: 0 };
  }

  const log = await readFullLog(agentName);
  if (!log) {
    return {
      name: agentName,
      backend: getAgentLabel(agent),
      model: agent.model,
      totalTurns: 0,
      quotaHits: 0,
      successRate: 0,
    };
  }

  const lines = log.split('\n');

  const turnLines = lines.filter(l => l.includes('Starting turn') || l.includes('Starting ['));
  const totalTurns = turnLines.length;

  const quotaPattern = /rate limit|CLI rate limit|Server overload|backing off/i;
  const quotaHits = lines.filter(l => quotaPattern.test(l)).length;

  const successRate = totalTurns > 0
    ? Math.max(0, Math.round(((totalTurns - quotaHits) / totalTurns) * 100))
    : 0;

  let uptimeFormatted: string | undefined;
  let turnsPerHour: number | undefined;

  if (turnLines.length >= 2) {
    const firstMatch = turnLines[0].match(/^\[([^\]]+)\]/);
    const lastMatch = turnLines[turnLines.length - 1].match(/^\[([^\]]+)\]/);
    if (firstMatch && lastMatch) {
      const firstTime = new Date(firstMatch[1]).getTime();
      const lastTime = new Date(lastMatch[1]).getTime();
      if (firstTime > 0 && lastTime > firstTime) {
        const elapsed = (lastTime - firstTime) / 1000;
        const hours = Math.floor(elapsed / 3600);
        const mins = Math.floor((elapsed % 3600) / 60);
        uptimeFormatted = `${hours}h ${mins}m`;
        const hoursElapsed = Math.max(1, Math.floor(elapsed / 3600));
        turnsPerHour = Math.round(totalTurns / hoursElapsed);
      }
    }
  }

  const usage = await getAgentUsageSummary(agentName);
  const tokenSum = (usage.totalInputTokens ?? 0) + (usage.totalOutputTokens ?? 0);
  const totalTokens = usage.totalTokens ?? (tokenSum || undefined);

  return {
    name: agentName,
    backend: getAgentLabel(agent),
    model: agent.model,
    totalTurns,
    quotaHits,
    successRate,
    uptimeFormatted,
    turnsPerHour,
    totalCost: usage.totalCost,
    avgCostPerTurn: usage.avgCostPerTurn,
    totalTokens,
  };
}

export async function getAllAnalytics(): Promise<Analytics[]> {
  // Exclude overseer from fleet-wide analytics — it's a supervisor, not a
  // trader/combat agent. Its cost/turn metrics live on the dedicated
  // /overseer page (see web/routes/overseer.ts).
  return Promise.all(
    AGENTS
      .filter((a) => a.name !== 'overseer')
      .map((a) => getAnalytics(a.name)),
  );
}
