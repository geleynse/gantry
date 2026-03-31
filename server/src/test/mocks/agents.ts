import type { AgentStatus, FleetStatus, ProxyInfo, ActionProxyStatus } from '../../shared/types.js';

export function createMockAgentStatus(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    name: 'drifter-gale',
    backend: 'claude',
    model: 'haiku',
    role: 'Scout',
    llmRunning: true,
    state: 'running',
    turnCount: 42,
    lastTurnAge: '2m',
    lastTurnAgeSeconds: 120,
    quotaHits: 0,
    authHits: 0,
    shutdownPending: false,
    lastGameOutput: [],
    healthScore: 85,
    healthIssues: [],
    proxy: 'proxy-a',
    sessionStartedAt: new Date(Date.now() - 3600_000).toISOString(),
    lastToolCallAt: new Date(Date.now() - 60_000).toISOString(),
    connectionStatus: 'connected',
    inBattle: false,
    shutdownState: 'none',
    proxySessionActive: true,
    lastActivityAt: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  };
}

export function createMockProxyInfo(overrides: Partial<ProxyInfo> = {}): ProxyInfo {
  return {
    name: 'proxy-a',
    port: 3200,
    host: '10.0.0.1',
    status: 'up',
    agents: ['drifter-gale'],
    ...overrides,
  };
}

export function createMockActionProxyStatus(overrides: Partial<ActionProxyStatus> = {}): ActionProxyStatus {
  return {
    processRunning: true,
    healthy: true,
    activeAgents: ['drifter-gale'],
    toolCount: 12,
    ...overrides,
  };
}

export function createMockFleetStatus(
  agentOverrides: Partial<AgentStatus>[] = [],
): FleetStatus {
  const agents = agentOverrides.length > 0
    ? agentOverrides.map((o) => createMockAgentStatus(o))
    : [
        createMockAgentStatus({ name: 'drifter-gale' }),
        createMockAgentStatus({ name: 'sable-thorn', state: 'stale', healthScore: 55 }),
        createMockAgentStatus({ name: 'rust-vane', state: 'dead', healthScore: 0, llmRunning: false }),
        createMockAgentStatus({ name: 'cinder-wake' }),
        createMockAgentStatus({ name: 'lumen-shoal', state: 'backed-off', healthScore: 40 }),
      ];

  return {
    agents,
    proxies: [createMockProxyInfo()],
    actionProxy: createMockActionProxyStatus(),
    turnSleepMs: 90,
    timestamp: new Date().toISOString(),
    fleetName: 'Test Fleet',
  };
}
