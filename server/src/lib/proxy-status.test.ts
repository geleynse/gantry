import { describe, it, expect } from 'bun:test';
import { getProxyStatusText } from './proxy-status';
import { createMockAgentStatus } from '@/test/mocks/agents';

describe('getProxyStatusText', () => {
  it('returns "In Session" when proxySessionActive', () => {
    expect(getProxyStatusText(createMockAgentStatus())).toBe('In Session');
  });

  it('returns "" when llmRunning is false (process not running — any session label would contradict main badge)', () => {
    expect(getProxyStatusText(createMockAgentStatus({
      llmRunning: false,
      proxySessionActive: false,
      lastActivityAt: null,
      lastToolCallAt: null,
    }))).toBe('');
  });

  it('returns "In Session" when session is recently active via tool calls', () => {
    expect(getProxyStatusText(createMockAgentStatus({
      proxySessionActive: false,
      lastActivityAt: null,
      lastToolCallAt: new Date(Date.now() - 30_000).toISOString(),
    }))).toBe('In Session');
  });

  it('returns "Proxy Blocking" when in draining state', () => {
    expect(getProxyStatusText(createMockAgentStatus({ shutdownState: 'draining' }))).toBe('Proxy Blocking');
  });

  it('returns "Waiting for Battle" when in shutdown_waiting state', () => {
    expect(getProxyStatusText(createMockAgentStatus({ shutdownState: 'shutdown_waiting' }))).toBe('Waiting for Battle');
  });

  it('returns "Stopped" when shutdownState is stopped', () => {
    expect(getProxyStatusText(createMockAgentStatus({ shutdownState: 'stopped' }))).toBe('Stopped');
  });

  it('returns "" when llmRunning is true but proxySessionActive is false and no recent activity', () => {
    expect(getProxyStatusText(createMockAgentStatus({
      llmRunning: true,
      proxySessionActive: false,
      lastActivityAt: null,
      lastToolCallAt: null,
    }))).toBe('');
  });

  it('returns "" when llmRunning false with stale activity (no sub-label for stopped/disconnected agents)', () => {
    const staleTime = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 minutes ago
    expect(getProxyStatusText(createMockAgentStatus({
      llmRunning: false,
      proxySessionActive: false,
      lastActivityAt: staleTime,
      lastToolCallAt: staleTime,
    }))).toBe('');
  });

  it('returns "" when llmRunning is false but proxySessionActive is true (stale session — would cause contradictory "Disconnected (In Session)")', () => {
    expect(getProxyStatusText(createMockAgentStatus({
      llmRunning: false,
      proxySessionActive: true,
      lastActivityAt: null,
      lastToolCallAt: null,
    }))).toBe('');
  });
});
