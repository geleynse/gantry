import type { ActionProxyStatus } from '../shared/types.js';

/**
 * Interface for the subset of SessionManager used by ActionProxyHealthService.
 * The proxy runs in-process so we read state directly rather than via HTTP.
 */
export interface ProxySessionHandle {
  listActive(): string[];
}

const CACHE_TTL_MS = 10_000;

/**
 * ActionProxyHealthService — Tracks action proxy health with caching.
 * Each instance maintains its own sessions binding and cache state.
 */
export class ActionProxyHealthService {
  private sessions: ProxySessionHandle | null = null;
  private toolCount = 0;
  private cache: { status: ActionProxyStatus; ts: number } | null = null;

  /**
   * Bind the in-process proxy session manager so getStatus() can
   * read active agents and tool count without making an HTTP call.
   */
  bindSessions(sessions: ProxySessionHandle, toolCount: number): void {
    this.sessions = sessions;
    this.toolCount = toolCount;
  }

  getStatus(): ActionProxyStatus {
    const now = Date.now();
    if (this.cache && now - this.cache.ts < CACHE_TTL_MS) {
      return this.cache.status;
    }

    // The proxy always runs in-process — processRunning is always true.
    const status: ActionProxyStatus = {
      processRunning: true,
      healthy: true,
      activeAgents: this.sessions?.listActive() ?? [],
      toolCount: this.toolCount,
    };
    this.cache = { status, ts: now };
    return status;
  }
}

// Default instance for backward compatibility
const defaultService = new ActionProxyHealthService();

/**
 * @deprecated Use ActionProxyHealthService instance directly.
 */
export function bindProxySessions(sessions: ProxySessionHandle, toolCount: number): void {
  defaultService.bindSessions(sessions, toolCount);
}

/**
 * @deprecated Use ActionProxyHealthService instance directly.
 */
export function getActionProxyStatus(): ActionProxyStatus {
  return defaultService.getStatus();
}
