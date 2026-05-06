import { Router } from 'express';
import type { AgentStatus, FleetStatus, BattleState } from '../../shared/types.js';
import { createLogger } from '../../lib/logger.js';
import { FleetStatusSchema } from '../../shared/schemas.js';
import { isRecent } from '../../lib/time.js';

import { AGENTS, TURN_SLEEP_MS, getAgentLabel, getConfig } from '../config.js';
import * as proc from '../../services/process-manager.js';
import { parseAgentLog, formatAge } from '../../services/log-parser.js';
import { getHealthScore } from '../../services/health-scorer.js';
import { hasSignal } from '../../services/signals-db.js';
import { proxyHealthService } from '../../services/proxy-health.js';
import { actionProxyHealthService } from '../../services/action-proxy-health.js';
import { getSessionInfo, getLatencyMetrics, getErrorRateBreakdown, getTurnCountFromDb } from '../../services/session-metrics.js';
import { getSessionShutdownManager } from '../../proxy/session-shutdown.js';
import { hasActiveProxySession, getLastActivityAt } from '../../services/agent-queries.js';
import { initSSE, writeSSE } from '../sse.js';
import type { BreakerRegistry } from '../../proxy/circuit-breaker.js';
import type { MetricsWindow } from '../../proxy/instability-metrics.js';

const log = createLogger('status');

let _battleCache: Map<string, BattleState | null> | null = null;
let _breakerRegistry: BreakerRegistry | null = null;

export function createStatusRouter(battleCache: Map<string, BattleState | null>, breakerRegistry: BreakerRegistry, _serverMetrics: MetricsWindow): Router {
  _battleCache = battleCache;
  _breakerRegistry = breakerRegistry;
  return router;
}

const router: Router = Router();

async function buildAgentStatus(agent: typeof AGENTS[number]): Promise<AgentStatus> {
  const running = await proc.hasSession(agent.name);
  const sessionInfo = getSessionInfo(agent.name);
  const proxySessionActiveRaw = hasActiveProxySession(agent.name);
  const lastActivityAt = getLastActivityAt(agent.name);
  const proxyRecentlyActive =
    isRecent(lastActivityAt) ||
    isRecent(sessionInfo.lastToolCallAt);
  const proxySessionActive = proxySessionActiveRaw || proxyRecentlyActive;

  const shutdownPending = hasSignal(agent.name, 'shutdown');

  // Fetch session and health metrics
  const latencyMetrics = getLatencyMetrics(agent.name);
  const errorRate = getErrorRateBreakdown(agent.name);

  const shutdownManager = getSessionShutdownManager();
  const inBattle = _battleCache?.has(agent.name) && _battleCache.get(agent.name) !== null;

  if (!running && !proxySessionActive) {
    const health = await getHealthScore(agent.name, _breakerRegistry!);
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
      lastToolName: sessionInfo.lastToolName,
      latencyMetrics,
      errorRate,
      connectionStatus: 'disconnected',
      inBattle: inBattle ?? false,
      shutdownState: shutdownManager.getShutdownState(agent.name),
      llmRunning: running,
      proxySessionActive,
      lastActivityAt,
      prayEnabled: agent.prayEnabled === true,
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
    lastToolName: sessionInfo.lastToolName,
    latencyMetrics,
    errorRate,
    connectionStatus: proxySessionActive ? 'connected' : 'disconnected',
    inBattle: inBattle ?? false,
    shutdownState: shutdownManager.getShutdownState(agent.name),
    llmRunning: running,
    proxySessionActive,
    lastActivityAt,
    prayEnabled: agent.prayEnabled === true,
  };
}

async function buildFleetStatus(): Promise<FleetStatus> {
  const [agents, proxies, actionProxy] = await Promise.all([
    Promise.all(AGENTS.map(buildAgentStatus)),
    proxyHealthService.getProxyStatuses(),
    actionProxyHealthService.getStatus(),
  ]);
  const payload = {
    agents,
    proxies,
    actionProxy,
    turnSleepMs: TURN_SLEEP_MS,
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

router.get('/', async (_req, res) => {
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
  // Exclude overseer from the startup count — it has a dedicated banner on the
  // dashboard and is not part of the operational fleet. Keeps "Fleet Agents: X/Y"
  // consistent with the top-bar and fleet-capacity counts.
  const agents = AGENTS.filter((a) => a.name !== 'overseer');
  const connectedCount = agents.filter((a) => hasActiveProxySession(a.name)).length;
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
