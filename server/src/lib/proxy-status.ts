import type { AgentStatus } from '@/hooks/use-fleet-status';
import { isRecent } from '@/lib/time';

/** Map agent state to human-readable proxy session status text. */
export function getProxyStatusText(agent: AgentStatus): string {
  if (agent.shutdownState === 'draining') return 'Proxy Blocking';
  if (agent.shutdownState === 'shutdown_waiting') return 'Waiting for Battle';
  if (agent.shutdownState === 'stopped') return 'Stopped';
  // Only show session state when the LLM process is actually running.
  // If !llmRunning, any proxy session is stale — showing "In Session" contradicts
  // the "Disconnected" or "Stopped" main badge.
  if (!agent.llmRunning) return '';
  if (agent.proxySessionActive || isRecent(agent.lastActivityAt) || isRecent(agent.lastToolCallAt)) {
    return 'In Session';
  }
  return '';
}
