import { describe, it, expect } from 'bun:test';
import { getAgentDisplayState, getStateColor, getStateLabel } from './agent-display-state';
import { createMockAgentStatus } from '@/test/mocks/agents';

describe('getAgentDisplayState', () => {
  it('returns "active" when llmRunning && proxySessionActive && state=running && no shutdown', () => {
    expect(getAgentDisplayState(createMockAgentStatus())).toBe('active');
  });

  it('returns "draining" when shutdownState is draining (highest priority)', () => {
    expect(getAgentDisplayState(createMockAgentStatus({ shutdownState: 'draining' }))).toBe('draining');
  });

  it('returns "shutdown-waiting" when shutdownState is shutdown_waiting', () => {
    expect(getAgentDisplayState(createMockAgentStatus({ shutdownState: 'shutdown_waiting' }))).toBe('shutdown-waiting');
  });

  it('returns "in-battle" when inBattle is true', () => {
    expect(getAgentDisplayState(createMockAgentStatus({ inBattle: true }))).toBe('in-battle');
  });

  it('returns "disconnected" when llmRunning is false', () => {
    expect(getAgentDisplayState(createMockAgentStatus({
      llmRunning: false,
      proxySessionActive: false,
      lastActivityAt: null,
      lastToolCallAt: null,
    }))).toBe('disconnected');
  });

  it('returns "offline" when llmRunning but proxySessionActive is false', () => {
    expect(getAgentDisplayState(createMockAgentStatus({
      proxySessionActive: false,
      lastActivityAt: null,
      lastToolCallAt: null,
    }))).toBe('offline');
  });

  it('returns "active" when llm is running and recent tool activity exists', () => {
    expect(getAgentDisplayState(createMockAgentStatus({
      proxySessionActive: false,
      lastActivityAt: null,
      lastToolCallAt: new Date(Date.now() - 30_000).toISOString(),
    }))).toBe('active');
  });

  it('returns "degraded" when state is stale', () => {
    expect(getAgentDisplayState(createMockAgentStatus({ state: 'stale' }))).toBe('degraded');
  });

  it('returns "degraded" when state is backed-off', () => {
    expect(getAgentDisplayState(createMockAgentStatus({ state: 'backed-off' }))).toBe('degraded');
  });

  it('returns "degraded" when state is unreachable', () => {
    expect(getAgentDisplayState(createMockAgentStatus({ state: 'unreachable' }))).toBe('degraded');
  });

  it('returns "stopped" when state is stopped (graceful)', () => {
    expect(getAgentDisplayState(createMockAgentStatus({ state: 'stopped' }))).toBe('stopped');
  });

  it('returns "stopped" when state is stopped and llmRunning is false (real-world case: process exited after graceful stop)', () => {
    expect(getAgentDisplayState(createMockAgentStatus({
      state: 'stopped',
      llmRunning: false,
      proxySessionActive: false,
    }))).toBe('stopped');
  });

  it('returns "disconnected" when state is dead (unexpected exit)', () => {
    expect(getAgentDisplayState(createMockAgentStatus({
      state: 'dead',
      llmRunning: false,
      proxySessionActive: false,
      lastActivityAt: null,
      lastToolCallAt: null,
    }))).toBe('disconnected');
  });

  it('returns "disconnected" when stale and llm not running (disconnected beats degraded)', () => {
    expect(getAgentDisplayState(createMockAgentStatus({
      state: 'stale',
      llmRunning: false,
      proxySessionActive: false,
      lastActivityAt: null,
      lastToolCallAt: null,
    }))).toBe('disconnected');
  });

  it('returns "disconnected" when proxy session has recent activity but llmRunning is false', () => {
    expect(getAgentDisplayState(createMockAgentStatus({
      state: 'dead',
      llmRunning: false,
      proxySessionActive: true,
      lastActivityAt: new Date(Date.now() - 30_000).toISOString(),
    }))).toBe('disconnected');
  });

  it('prioritizes draining over in-battle', () => {
    expect(getAgentDisplayState(createMockAgentStatus({ shutdownState: 'draining', inBattle: true }))).toBe('draining');
  });

  it('prioritizes shutdown-waiting over in-battle', () => {
    expect(getAgentDisplayState(createMockAgentStatus({ shutdownState: 'shutdown_waiting', inBattle: true }))).toBe('shutdown-waiting');
  });

  it('handles undefined optional fields gracefully', () => {
    const agent = createMockAgentStatus();
    delete (agent as any).llmRunning;
    delete (agent as any).proxySessionActive;
    delete (agent as any).shutdownState;
    delete (agent as any).inBattle;
    // With defaults (true/true/none/false), should be active
    expect(getAgentDisplayState(agent)).toBe('active');
  });
});

describe('getStateColor', () => {
  it('returns green for active', () => {
    expect(getStateColor('active')).toContain('green');
  });

  it('returns amber for draining', () => {
    expect(getStateColor('draining')).toContain('amber');
  });

  it('returns red for in-battle', () => {
    expect(getStateColor('in-battle')).toContain('red');
  });

  it('returns yellow for offline (process running but connection dropped — needs attention)', () => {
    expect(getStateColor('offline')).toContain('yellow');
  });
});

describe('getStateLabel', () => {
  it('returns human-readable labels for all states', () => {
    expect(getStateLabel('active')).toBe('Active');
    expect(getStateLabel('disconnected')).toBe('Disconnected');
    expect(getStateLabel('draining')).toBe('Draining');
    expect(getStateLabel('shutdown-waiting')).toBe('Shutdown Waiting');
    expect(getStateLabel('in-battle')).toBe('In Battle');
    expect(getStateLabel('offline')).toBe('Reconnecting');
    expect(getStateLabel('degraded')).toBe('Degraded');
    expect(getStateLabel('stopped')).toBe('Stopped');
  });
});
