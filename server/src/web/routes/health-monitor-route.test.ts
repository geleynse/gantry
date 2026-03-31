/**
 * Tests for the health monitor watchdog route and getAllStates().
 */
import { describe, it, expect } from 'bun:test';
import request from 'supertest';
import express from 'express';
import { createHealthMonitor } from '../../services/health-monitor.js';
import { createHealthMonitorRouter } from './health-monitor-route.js';
import type { AgentConfig } from '../../config.js';

// Minimal AgentConfig stubs
const AGENTS: AgentConfig[] = [
  { name: 'drifter-gale' } as AgentConfig,
  { name: 'sable-thorn' } as AgentConfig,
];

function makeApp(healthMonitor = createHealthMonitor(AGENTS)) {
  const app = express();
  app.use(express.json());
  app.use('/api/diagnostics', createHealthMonitorRouter({ healthMonitor }));
  return { app, healthMonitor };
}

// ── Unit tests for getAllStates ────────────────────────────────────────────────

describe('HealthMonitor.getAllStates()', () => {
  it('returns an empty object when no state has been set', () => {
    const monitor = createHealthMonitor(AGENTS);
    const states = monitor.getAllStates();
    // States map is lazily populated — no entries yet
    expect(typeof states).toBe('object');
    expect(Object.keys(states)).toHaveLength(0);
  });

  it('returns state after markRunning', () => {
    const monitor = createHealthMonitor(AGENTS);
    monitor.markRunning('drifter-gale');
    const states = monitor.getAllStates();
    expect(states['drifter-gale']).toBeDefined();
    expect(states['drifter-gale'].desiredState).toBe('running');
    expect(states['drifter-gale'].consecutiveRestarts).toBe(0);
    expect(states['drifter-gale'].nextRestartAfterMs).toBe(0);
  });

  it('returns state after markStopped', () => {
    const monitor = createHealthMonitor(AGENTS);
    monitor.markStopped('sable-thorn');
    const states = monitor.getAllStates();
    expect(states['sable-thorn']).toBeDefined();
    expect(states['sable-thorn'].desiredState).toBe('stopped');
  });

  it('returns states for multiple agents independently', () => {
    const monitor = createHealthMonitor(AGENTS);
    monitor.markRunning('drifter-gale');
    monitor.markStopped('sable-thorn');
    const states = monitor.getAllStates();
    expect(states['drifter-gale'].desiredState).toBe('running');
    expect(states['sable-thorn'].desiredState).toBe('stopped');
  });

  it('getState and getAllStates agree', () => {
    const monitor = createHealthMonitor(AGENTS);
    monitor.markRunning('drifter-gale');
    const allStates = monitor.getAllStates();
    const singleState = monitor.getState('drifter-gale')!;
    expect(allStates['drifter-gale']).toEqual(singleState);
  });

  it('returns a plain object (not a Map)', () => {
    const monitor = createHealthMonitor(AGENTS);
    monitor.markRunning('drifter-gale');
    const states = monitor.getAllStates();
    expect(states instanceof Map).toBe(false);
    expect(typeof states).toBe('object');
  });
});

// ── Route integration tests ───────────────────────────────────────────────────

describe('GET /api/diagnostics/health-monitor', () => {
  it('returns 200 with agents object', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/diagnostics/health-monitor');
    expect(res.status).toBe(200);
    expect(typeof res.body.agents).toBe('object');
  });

  it('returns empty agents when no state initialized', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/diagnostics/health-monitor');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.agents)).toHaveLength(0);
  });

  it('includes agent entry after markRunning', async () => {
    const { app, healthMonitor } = makeApp();
    healthMonitor.markRunning('drifter-gale');
    const res = await request(app).get('/api/diagnostics/health-monitor');
    expect(res.status).toBe(200);
    const agent = res.body.agents['drifter-gale'];
    expect(agent).toBeDefined();
    expect(agent.desiredState).toBe('running');
    expect(agent.consecutiveRestarts).toBe(0);
    expect(typeof agent.backoffRemainingSec).toBe('number');
    expect(agent.backoffRemainingSec).toBe(0);
  });

  it('includes agent entry after markStopped', async () => {
    const { app, healthMonitor } = makeApp();
    healthMonitor.markStopped('sable-thorn');
    const res = await request(app).get('/api/diagnostics/health-monitor');
    expect(res.status).toBe(200);
    const agent = res.body.agents['sable-thorn'];
    expect(agent).toBeDefined();
    expect(agent.desiredState).toBe('stopped');
  });

  it('backoffRemainingSec is 0 when no backoff active', async () => {
    const { app, healthMonitor } = makeApp();
    healthMonitor.markRunning('drifter-gale');
    const res = await request(app).get('/api/diagnostics/health-monitor');
    expect(res.body.agents['drifter-gale'].backoffRemainingSec).toBe(0);
  });

  it('backoffRemainingSec is positive when backoff is set', async () => {
    const monitor = createHealthMonitor(AGENTS);
    // Simulate a future restart time (30s from now) by hacking state via getState
    monitor.markRunning('drifter-gale');
    const state = monitor.getState('drifter-gale');
    if (state) {
      state.nextRestartAfterMs = Date.now() + 30_000;
    }

    const { app } = makeApp(monitor);
    const res = await request(app).get('/api/diagnostics/health-monitor');
    const agent = res.body.agents['drifter-gale'];
    expect(agent.backoffRemainingSec).toBeGreaterThan(0);
    expect(agent.backoffRemainingSec).toBeLessThanOrEqual(30);
  });

  it('backoffRemainingSec is clamped to 0 when backoff time is in the past', async () => {
    const monitor = createHealthMonitor(AGENTS);
    monitor.markRunning('drifter-gale');
    const state = monitor.getState('drifter-gale');
    if (state) {
      state.nextRestartAfterMs = Date.now() - 10_000; // 10s ago
    }

    const { app } = makeApp(monitor);
    const res = await request(app).get('/api/diagnostics/health-monitor');
    expect(res.body.agents['drifter-gale'].backoffRemainingSec).toBe(0);
  });

  it('response includes nextRestartAfterMs field', async () => {
    const { app, healthMonitor } = makeApp();
    healthMonitor.markRunning('drifter-gale');
    const res = await request(app).get('/api/diagnostics/health-monitor');
    const agent = res.body.agents['drifter-gale'];
    expect(typeof agent.nextRestartAfterMs).toBe('number');
  });

  it('returns multiple agents when multiple have state', async () => {
    const { app, healthMonitor } = makeApp();
    healthMonitor.markRunning('drifter-gale');
    healthMonitor.markStopped('sable-thorn');
    const res = await request(app).get('/api/diagnostics/health-monitor');
    expect(Object.keys(res.body.agents)).toHaveLength(2);
    expect(res.body.agents['drifter-gale'].desiredState).toBe('running');
    expect(res.body.agents['sable-thorn'].desiredState).toBe('stopped');
  });
});
