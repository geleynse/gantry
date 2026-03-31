import { createConnection } from 'node:net';
import { AGENTS } from '../config.js';
import type { ProxyInfo } from '../shared/types.js';

const TIMEOUT_MS = 3000;
const CACHE_TTL_MS = 10_000;

export function checkProxyHealth(port: number): Promise<'up' | 'down'> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve('down');
    }, TIMEOUT_MS);

    socket.on('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve('up');
    });

    socket.on('error', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve('down');
    });
  });
}

/**
 * ProxyHealthService — Builds the list of proxies from agent configs with caching.
 * Each instance maintains its own cache state.
 */
export class ProxyHealthService {
  private cache: { proxies: ProxyInfo[]; ts: number } | null = null;

  async getProxyStatuses(): Promise<ProxyInfo[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.ts < CACHE_TTL_MS) {
      return this.cache.proxies;
    }

    // Collect unique proxy names from agent configs
    const proxyMap = new Map<string, { port: number; agents: string[] }>();
    const directAgents: string[] = [];

    for (const agent of AGENTS) {
      if (agent.proxy && agent.socksPort) {
        const entry = proxyMap.get(agent.proxy);
        if (entry) {
          entry.agents.push(agent.name);
        } else {
          proxyMap.set(agent.proxy, { port: agent.socksPort, agents: [agent.name] });
        }
      } else {
        directAgents.push(agent.name);
      }
    }

    const results: ProxyInfo[] = await Promise.all(
      Array.from(proxyMap.entries()).map(async ([name, { port, agents }]) => {
        const status = await checkProxyHealth(port);
        return { name, port, host: '127.0.0.1', status, agents };
      })
    );

    results.push({ name: 'direct', port: 0, host: 'localhost', status: 'up', agents: directAgents });

    this.cache = { proxies: results, ts: now };
    return results;
  }
}

// Default instance for backward compatibility
const defaultService = new ProxyHealthService();

/**
 * @deprecated Use ProxyHealthService instance directly. This function delegates to a module-level default instance.
 */
export async function getProxyStatuses(): Promise<ProxyInfo[]> {
  return defaultService.getProxyStatuses();
}
