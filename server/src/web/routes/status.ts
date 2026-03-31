import { Router } from 'express';
import type { AgentStatus, FleetStatus, BattleState } from '../../shared/types.js';
import { createLogger } from '../../lib/logger.js';
import { FleetStatusSchema } from '../../shared/schemas.js';

import { AGENTS, TURN_INTERVAL, getAgentLabel, getConfig } from '../config.js';
import * as proc from '../../services/process-manager.js';
import { parseAgentLog, formatAge } from '../../services/log-parser.js';
import { getHealthScore } from '../../services/health-scorer.js';
import { hasSignal } from '../../services/signals-db.js';
import { getProxyStatuses } from '../../services/proxy-health.js';
import { getActionProxyStatus } from '../../services/action-proxy-health.js';
import { getSessionInfo, getLatencyMetrics, getErrorRateBreakdown, getTurnCountFromDb } from '../../services/session-metrics.js';
import { getSessionShutdownManager } from '../../proxy/session-shutdown.js';
import { hasActiveProxySession, getLastActivityAt } from '../../services/agent-queries.js';
import { initSSE, writeSSE } from '../sse.js';
import type { BreakerRegistry } from '../../proxy/circuit-breaker.js';

const log = createLogger('status');
import type { MetricsWindow } from '../../proxy/instability-metrics.js';

let _battleCache: Map<string, BattleState | null> | null = null;
let _breakerRegistry: BreakerRegistry | null = null;

export function createStatusRouter(battleCache: Map<string, BattleState | null>, breakerRegistry: BreakerRegistry, _serverMetrics: MetricsWindow): Router {
  _battleCache = battleCache;
  _breakerRegistry = breakerRegistry;
  return router;
}

const router: Router = Router();

function hasRecentActivity(lastActivityAt: string | null, thresholdMs: number = 2 * 60 * 1000): boolean {
  if (!lastActivityAt) return false;
  const ts = new Date(lastActivityAt).getTime();
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < thresholdMs;
}

async function buildAgentStatus(agent: typeof AGENTS[number]): Promise<AgentStatus> {
  const running = await proc.hasSession(agent.name);
  const sessionInfo = getSessionInfo(agent.name);
  const proxySessionActiveRaw = hasActiveProxySession(agent.name);
  const lastActivityAt = getLastActivityAt(agent.name);
  const proxyRecentlyActive =
    hasRecentActivity(lastActivityAt) ||
    hasRecentActivity(sessionInfo.lastToolCallAt);
  const proxySessionActive = proxySessionActiveRaw || proxyRecentlyActive;

  const shutdownPending = hasSignal(agent.name, 'shutdown');

  // Fetch session and health metrics
  const latencyMetrics = getLatencyMetrics(agent.name);
  const errorRate = getErrorRateBreakdown(agent.name);

  // Fetch shutdown state
  const shutdownManager = getSessionShutdownManager();
  const inBattle = _battleCache?.has(agent.name) && _battleCache.get(agent.name) !== null;
  const llmRunning = running; // Only true if PID exists

  if (!running && !proxySessionActive) {
    const health = await getHealthScore(agent.name, _breakerRegistry!);
    // Distinguish graceful stop from crash: if no stopped_gracefully marker
    // and the agent was previously seen running (has session/log data), it likely crashed.
    // Graceful if: explicit stopped_gracefully flag OR shutdown signal was pending
    // (agent stopped on its own after receiving a shutdown instruction)
    const stoppedGracefully = hasSignal(agent.name, 'stopped_gracefully') || hasSignal(agent.name, 'shutdown');
    const stoppedState: 'stopped' | 'dead' = stoppedGracefully ? 'stopped' : 'dead';
    return {
      name: agent.name,
      backend: getAgentLabel(agent),
      model: agent.model || agent.backend,
      role: agent.role,
      state: stoppedState,
      turnCount: getTurnCountFromDb(agent.name),
      quotaHits: 0,
      authHits: 0,
      shutdownPending,
      lastGameOutput: [],
      healthScore: health.score,
      healthIssues: health.issues,
      proxy: agent.proxy,
      sessionStartedAt: sessionInfo.sessionStartedAt,
      lastToolCallAt: sessionInfo.lastToolCallAt,
      latencyMetrics,
      errorRate,
      connectionStatus: 'disconnected',
      inBattle: inBattle ?? false,
      shutdownState: shutdownManager.getShutdownState(agent.name),
      llmRunning,
      proxySessionActive,
      lastActivityAt,
    };
  }

  const parsedLog = await parseAgentLog(agent.name);
  const health = await getHealthScore(agent.name, _breakerRegistry!);

  return {
    name: agent.name,
    backend: getAgentLabel(agent),
    model: agent.model,
    role: agent.role,
    state: parsedLog?.state ?? 'unreachable',
    turnCount: getTurnCountFromDb(agent.name) || parsedLog?.turnCount || 0,
    lastTurnAge: parsedLog?.lastTurnAgeSeconds != null ? formatAge(parsedLog.lastTurnAgeSeconds) : undefined,
    lastTurnAgeSeconds: parsedLog?.lastTurnAgeSeconds ?? undefined,
    quotaHits: parsedLog?.quotaHits ?? 0,
    authHits: parsedLog?.authHits ?? 0,
    shutdownPending,
    lastGameOutput: parsedLog?.lastGameOutput ?? [],
    healthScore: health.score,
    healthIssues: health.issues,
    proxy: agent.proxy,
    sessionStartedAt: sessionInfo.sessionStartedAt,
    lastToolCallAt: sessionInfo.lastToolCallAt,
    latencyMetrics,
    errorRate,
    connectionStatus: proxySessionActive ? 'connected' : 'disconnected',
    inBattle: inBattle ?? false,
    shutdownState: shutdownManager.getShutdownState(agent.name),
    llmRunning: running,
    proxySessionActive,
    lastActivityAt,
  };
}

async function buildFleetStatus(): Promise<FleetStatus> {
  const [agents, proxies, actionProxy] = await Promise.all([
    Promise.all(AGENTS.map(buildAgentStatus)),
    getProxyStatuses(),
    getActionProxyStatus(),
  ]);
  const payload = {
    agents,
    proxies,
    actionProxy,
    turnSleepMs: TURN_INTERVAL,
    timestamp: new Date().toISOString(),
    fleetName: getConfig().fleetName,
  };

  // Validate shape at API boundary so mismatches surface as errors.
  const result = FleetStatusSchema.safeParse(payload);
  if (!result.success) {
    log.warn('FleetStatus shape validation failed', { issues: result.error.issues });
  }

  return payload;
}

router.get('/', async (req, res) => {
  const status = await buildFleetStatus();
  res.json(status);
});

router.get('/stream', async (req, res) => {
  initSSE(req, res);

  let aborted = false;
  req.on('close', () => {
    aborted = true;
  });

  try {
    while (!aborted) {
      try {
        const status = await buildFleetStatus();
        writeSSE(res, 'status', status);
      } catch (err) {
        if (aborted) break;
        log.error(`SSE buildFleetStatus error: ${err}`);
      }
      await new Promise(r => setTimeout(r, 5000));
    }
  } finally {
    res.end();
  }
});

// ---------------------------------------------------------------------------
// Startup status — polled by the splash screen during initial load
// ---------------------------------------------------------------------------

const SERVER_START = Date.now();

router.get('/startup', async (_req, res) => {
  const uptime = Math.round((Date.now() - SERVER_START) / 1000);
  const agents = AGENTS;
  let connectedCount = 0;
  for (const agent of agents) {
    if (await hasActiveProxySession(agent.name)) connectedCount++;
  }
  res.json({
    serverUptime: uptime,
    agentsConnected: connectedCount,
    agentsTotal: agents.length,
    serverReady: uptime > 30 || connectedCount > 0,
    services: [
      { name: 'Database', ready: true },
      { name: 'WebSocket', ready: true },
      { name: 'Fleet Agents', ready: connectedCount > 0, detail: `${connectedCount}/${agents.length}` },
      { name: 'Event Buffer', ready: true },
    ],
  });
});

export default router;
