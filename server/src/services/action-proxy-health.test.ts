import { describe, it, expect } from 'bun:test';
import { ActionProxyHealthService } from './action-proxy-health.js';

describe('ActionProxyHealthService', () => {
  it('returns healthy status with active agents when sessions are bound', () => {
    const service = new ActionProxyHealthService();
    service.bindSessions({ listActive: () => ['drifter-gale', 'sable-thorn'] }, 69);
    const result = service.getStatus();
    expect(result.processRunning).toBe(true);
    expect(result.healthy).toBe(true);
    expect(result.activeAgents).toEqual(['drifter-gale', 'sable-thorn']);
    expect(result.toolCount).toBe(69);
  });

  it('returns healthy with empty agent list when no active sessions', () => {
    const service = new ActionProxyHealthService();
    service.bindSessions({ listActive: () => [] }, 42);
    const result = service.getStatus();
    expect(result.processRunning).toBe(true);
    expect(result.healthy).toBe(true);
    expect(result.activeAgents).toEqual([]);
    expect(result.toolCount).toBe(42);
  });

  it('returns healthy with zero tools when sessions not yet bound', () => {
    // Proxy is always in-process — even before bindSessions is called it reports running
    const service = new ActionProxyHealthService();
    const result = service.getStatus();
    expect(result.processRunning).toBe(true);
    expect(result.healthy).toBe(true);
    expect(result.activeAgents).toEqual([]);
    expect(result.toolCount).toBe(0);
  });

  it('returns cached result within TTL', () => {
    const service = new ActionProxyHealthService();
    service.bindSessions({ listActive: () => ['drifter-gale'] }, 10);
    const first = service.getStatus();
    // Rebind with different data — should still return cached result
    service.bindSessions({ listActive: () => ['sable-thorn', 'rust-vane'] }, 99);
    const second = service.getStatus();
    expect(second).toBe(first);
  });
});
