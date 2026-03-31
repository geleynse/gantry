import type { AgentStatus } from '@/hooks/use-fleet-status';
import { isRecent } from '@/lib/time';

export type AgentDisplayState =
  | 'active'
  | 'disconnected'
  | 'draining'
  | 'shutdown-waiting'
  | 'in-battle'
  | 'offline'
  | 'degraded'
  | 'stopped';

/** Determine the visual display state for an agent, applying priority rules. */
export function getAgentDisplayState(agent: AgentStatus): AgentDisplayState {
  const llmRunning = agent.llmRunning ?? true;
  const proxySessionActive = agent.proxySessionActive ?? true;
  const isRecentlyActive = isRecent(agent.lastActivityAt) || isRecent(agent.lastToolCallAt);
  const proxyActive = proxySessionActive || isRecentlyActive;
  const shutdownState = agent.shutdownState ?? 'none';
  const inBattle = agent.inBattle ?? false;

  // Shutdown states take highest priority
  if (shutdownState === 'draining') return 'draining';
  if (shutdownState === 'shutdown_waiting') return 'shutdown-waiting';

  // Battle state
  if (inBattle) return 'in-battle';

  // Stopped (explicit graceful stop) — check before llmRunning since stopping kills the process
  if (agent.state === 'stopped') return 'stopped';

  // LLM not running = disconnected (process crashed or was killed)
  // We ignore proxyActive here because credentials restoration on startup
  // makes the proxy think it's active even if no loop is running.
  if (!llmRunning) {
    return 'disconnected';
  }

  // Dead = unexpected crash
  if (agent.state === 'dead') {
    if (proxyActive && isRecentlyActive) return 'active';
    return 'disconnected';
  }

  // LLM running but no proxy session = offline
  if (!proxyActive) return 'offline';

  // Degraded states (server connection issues, but still running)
  if (agent.state === 'stale' || agent.state === 'backed-off' || agent.state === 'unreachable') {
    return 'degraded';
  }

  // Check for recent activity (within last 2 minutes) — indicates active turn execution
  // This catches agents with recent tool calls even if state field hasn't updated yet
  if (isRecentlyActive) return 'active';

  // Everything looks good
  if (agent.state === 'running') return 'active';

  // Fallback
  return 'disconnected';
}

/** Tailwind color classes for each display state. */
export function getStateColor(state: AgentDisplayState): string {
  switch (state) {
    case 'active':
      return 'bg-green-500 text-white';
    case 'disconnected':
      return 'bg-gray-400 text-white';
    case 'draining':
      return 'bg-amber-500 text-white';
    case 'shutdown-waiting':
      return 'bg-orange-500 text-white';
    case 'in-battle':
      return 'bg-red-500 text-white';
    case 'offline':
      return 'bg-yellow-500 text-white';
    case 'degraded':
      return 'bg-yellow-500 text-white';
    case 'stopped':
      return 'bg-gray-500 text-white';
  }
}

/** Human-readable label for each display state. */
export function getStateLabel(state: AgentDisplayState): string {
  switch (state) {
    case 'active':
      return 'Active';
    case 'disconnected':
      return 'Disconnected';
    case 'draining':
      return 'Draining';
    case 'shutdown-waiting':
      return 'Shutdown Waiting';
    case 'in-battle':
      return 'In Battle';
    case 'offline':
      return 'Reconnecting';
    case 'degraded':
      return 'Degraded';
    case 'stopped':
      return 'Stopped';
  }
}
