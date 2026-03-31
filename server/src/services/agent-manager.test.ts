import { describe, it, expect, mock, spyOn, beforeEach } from 'bun:test';
import { setConfigForTesting, setSoftStopTimingForTesting } from '../config.js';
import type { GantryConfig } from '../config.js';

// Use setConfigForTesting instead of mock.module('../config.js') to avoid
// cross-test contamination. mock.module() persists for the entire worker
// process with maxConcurrency=1 (CI), breaking subsequent tests that import config.

const testConfig: GantryConfig = {
  agents: [
    { name: 'drifter-gale', backend: 'claude', model: 'haiku', extraTools: 'Bash Glob Grep' },
    { name: 'sable-thorn', backend: 'claude', model: 'sonnet' },
    { name: 'rust-vane', backend: 'claude', model: 'haiku' },
    { name: 'lumen-shoal', backend: 'claude', model: 'sonnet' },
    { name: 'cinder-wake', backend: 'codex' },
  ] as GantryConfig['agents'],
  gameUrl: 'ws://localhost',
  gameApiUrl: 'http://localhost',
  agentDeniedTools: {},
  callLimits: {},
  turnSleepMs: 90,
  staggerDelay: 20,
};

// Use spyOn on namespace imports instead of mock.module to avoid
// poisoning process-manager.test.ts (mock.module persists across files).
import * as proc from './process-manager.js';
import * as signalsDb from './signals-db.js';
import { startAgent, stopAgent, forceStopAgent, softStopAgent, softRestartAgent } from './agent-manager.js';

describe('agent-manager', () => {
  let mockedHasSession: ReturnType<typeof spyOn>;
  let mockedNewSession: ReturnType<typeof spyOn>;
  let mockedKillSession: ReturnType<typeof spyOn>;
  let mockedCreateSignal: ReturnType<typeof spyOn>;
  let mockedClearSignal: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setConfigForTesting(testConfig);
    setSoftStopTimingForTesting(100, 10); // Fast timeouts for tests
    mockedHasSession = spyOn(proc, 'hasSession').mockImplementation(async (_name: string) => false);
    mockedNewSession = spyOn(proc, 'newSession').mockImplementation(async () => {});
    mockedKillSession = spyOn(proc, 'killSession').mockImplementation(async () => {});
    mockedCreateSignal = spyOn(signalsDb, 'createSignal').mockImplementation(() => {});
    mockedClearSignal = spyOn(signalsDb, 'clearSignal').mockImplementation(() => {});
  });

  describe('startAgent', () => {
    it('starts agent when not running', async () => {
      mockedHasSession.mockResolvedValue(false);
      mockedNewSession.mockResolvedValue(undefined);

      const result = await startAgent('drifter-gale');
      expect(result.ok).toBe(true);
      expect(mockedNewSession).toHaveBeenCalledTimes(1);
    });

    it('clears stopped_gracefully signal on start', async () => {
      mockedHasSession.mockResolvedValue(false);
      mockedNewSession.mockResolvedValue(undefined);

      await startAgent('drifter-gale');
      expect(mockedClearSignal).toHaveBeenCalledWith('drifter-gale', 'stopped_gracefully');
    });

    it('fails when agent already running', async () => {
      mockedHasSession.mockResolvedValue(true);

      const result = await startAgent('drifter-gale');
      expect(result.ok).toBe(false);
      expect(result.message).toContain('already running');
    });

    it('fails for unknown agent', async () => {
      const result = await startAgent('unknown-agent');
      expect(result.ok).toBe(false);
    });

    it('builds correct command for drifter-gale with encoded tools', async () => {
      mockedHasSession.mockResolvedValue(false);
      mockedNewSession.mockResolvedValue(undefined);

      await startAgent('drifter-gale');

      expect(mockedNewSession).toHaveBeenCalledWith(
        'drifter-gale',
        expect.objectContaining({
          executable: expect.stringContaining('gantry-runner'),
          args: expect.arrayContaining(['--agent', 'drifter-gale']),
        })
      );
    });

    it('builds correct command for agent without extra tools', async () => {
      mockedHasSession.mockResolvedValue(false);
      mockedNewSession.mockResolvedValue(undefined);

      await startAgent('rust-vane');

      expect(mockedNewSession).toHaveBeenCalledWith(
        'rust-vane',
        expect.objectContaining({
          executable: expect.stringContaining('gantry-runner'),
          args: expect.arrayContaining(['--agent', 'rust-vane']),
        })
      );
    });
  });

  describe('stopAgent', () => {
    it('soft stops running agent', async () => {
      mockedHasSession
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      const result = await stopAgent('drifter-gale');
      expect(result.ok).toBe(true);
      expect(result.message).toContain('gracefully');
      expect(mockedCreateSignal).toHaveBeenCalledWith('drifter-gale', 'inject', expect.stringContaining('SHUTDOWN'));
      expect(mockedCreateSignal).toHaveBeenCalledWith('drifter-gale', 'shutdown');
      expect(mockedCreateSignal).toHaveBeenCalledWith('drifter-gale', 'stopped_gracefully');
      expect(mockedClearSignal).toHaveBeenCalledWith('drifter-gale', 'shutdown');
    });

    it('fails when agent not running', async () => {
      mockedHasSession.mockResolvedValue(false);

      const result = await stopAgent('drifter-gale');
      expect(result.ok).toBe(false);
    });
  });

  describe('forceStopAgent', () => {
    it('kills session immediately', async () => {
      mockedHasSession.mockResolvedValue(true);
      mockedKillSession.mockResolvedValue(undefined);

      const result = await forceStopAgent('drifter-gale');
      expect(result.ok).toBe(true);
      expect(result.message).toContain('force-stopped');
      expect(mockedKillSession).toHaveBeenCalledWith('drifter-gale');
    });

    it('fails for unknown agent', async () => {
      const result = await forceStopAgent('unknown-agent');
      expect(result.ok).toBe(false);
    });

    it('fails when not running', async () => {
      mockedHasSession.mockResolvedValue(false);

      const result = await forceStopAgent('drifter-gale');
      expect(result.ok).toBe(false);
    });
  });

  describe('softStopAgent', () => {
    it('injects shutdown and polls until stopped', async () => {
      mockedHasSession
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      const result = await softStopAgent('drifter-gale');
      expect(result.ok).toBe(true);
      expect(result.message).toContain('gracefully');
      expect(mockedCreateSignal).toHaveBeenCalledTimes(3); // inject + shutdown + stopped_gracefully
      expect(mockedClearSignal).toHaveBeenCalledTimes(1); // clear shutdown
    });

    it('sets stopped_gracefully signal on clean exit', async () => {
      mockedHasSession
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      await softStopAgent('drifter-gale');
      expect(mockedCreateSignal).toHaveBeenCalledWith('drifter-gale', 'stopped_gracefully');
    });

    it('does NOT set stopped_gracefully on timeout/force-kill', async () => {
      mockedHasSession.mockResolvedValue(true);
      mockedKillSession.mockResolvedValue(undefined);

      await softStopAgent('drifter-gale');
      const calls = mockedCreateSignal.mock.calls as Array<[string, string, ...unknown[]]>;
      const gracefulCalls = calls.filter(([, sig]) => sig === 'stopped_gracefully');
      expect(gracefulCalls).toHaveLength(0);
    });

    it('times out and force-kills', async () => {
      mockedHasSession.mockResolvedValue(true);
      mockedKillSession.mockResolvedValue(undefined);

      const result = await softStopAgent('drifter-gale');
      expect(result.ok).toBe(true);
      expect(result.message).toContain('force-stopped after timeout');
      expect(mockedKillSession).toHaveBeenCalledWith('drifter-gale');
      expect(mockedClearSignal).toHaveBeenCalledWith('drifter-gale', 'shutdown');
    });

    it('fails for unknown agent', async () => {
      const result = await softStopAgent('unknown-agent');
      expect(result.ok).toBe(false);
    });

    it('fails when not running', async () => {
      mockedHasSession.mockResolvedValue(false);

      const result = await softStopAgent('drifter-gale');
      expect(result.ok).toBe(false);
    });
  });

  describe('softRestartAgent', () => {
    it('soft stops then starts', async () => {
      mockedHasSession
        .mockResolvedValueOnce(true)   // softStop: is running?
        .mockResolvedValueOnce(false)  // softStop: poll — stopped
        .mockResolvedValueOnce(false); // startAgent: is running?
      mockedNewSession.mockResolvedValue(undefined);

      const result = await softRestartAgent('drifter-gale');
      expect(result.ok).toBe(true);
      // inject + shutdown + stopped_gracefully
      expect(mockedCreateSignal).toHaveBeenCalledTimes(3);
      // clearSignal: shutdown on stop + stopped_gracefully/shutdown/inject on start
      expect(mockedClearSignal).toHaveBeenCalledTimes(4);
      expect(mockedNewSession).toHaveBeenCalledTimes(1);
    });
  });
});
