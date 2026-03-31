import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import {
  hasSession,
  capturePane,
  newSession,
  killSession,
  scanOrphanedProcesses,
  _getTrackedProcesses,
} from './process-manager.js';
import { setConfigForTesting } from '../config.js';
import * as fs from 'node:fs';
import * as childProcess from 'node:child_process';

describe('process-manager', () => {
  let existsSpy: any;
  let readSpy: any;
  let unlinkSpy: any;
  let mkdirSpy: any;
  let writeSpy: any;
  let execSpy: any;
  let spawnSpy: any;

  beforeEach(() => {
    setConfigForTesting({
      agents: [
        { name: 'test-agent', backend: 'claude', model: 'haiku' },
      ],
      turnSleepMs: 90,
      auth: { adapter: 'token', config: { token: 'abc' } },
      gameUrl: 'ws://localhost:8000',
    } as unknown as import('../config/types.js').GantryConfig);

    existsSpy = spyOn(fs, 'existsSync').mockReturnValue(false);
    readSpy = spyOn(fs, 'readFileSync').mockReturnValue('');
    unlinkSpy = spyOn(fs, 'unlinkSync').mockImplementation(() => {});
    mkdirSpy = spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    writeSpy = spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    
    // Use spyOn instead of mock.module
    execSpy = spyOn(childProcess, 'exec').mockImplementation(((cmd: any, opts: any, cb: any) => {
      if (typeof opts === 'function') opts(null, '', '');
      else if (cb) cb(null, '', '');
    }) as any);
    
    spawnSpy = spyOn(childProcess, 'spawn').mockImplementation(() => ({
      unref: () => {},
      on: () => {},
      pid: 99999,
      exitCode: null,
      killed: false,
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      stdin: { write: () => {}, end: () => {} }
    } as any));

    // Clear tracked processes between tests
    _getTrackedProcesses().clear();
  });

  afterEach(() => {
    existsSpy.mockRestore();
    readSpy.mockRestore();
    unlinkSpy.mockRestore();
    mkdirSpy.mockRestore();
    writeSpy.mockRestore();
    execSpy.mockRestore();
    spawnSpy.mockRestore();
  });

  describe('hasSession', () => {
    it('returns false when no tracked process exists', async () => {
      const result = await hasSession('gantry-server');
      expect(result).toBe(false);
    });

    it('returns true when tracked process is alive', async () => {
      const fakeChild = {
        exitCode: null,
        killed: false,
        pid: 42,
        on: () => {},
        unref: () => {},
      };
      _getTrackedProcesses().set('gantry-server', fakeChild as any);
      const result = await hasSession('gantry-server');
      expect(result).toBe(true);
    });

    it('returns false and cleans up when tracked process has exited', async () => {
      const fakeChild = {
        exitCode: 0,
        killed: false,
        pid: 42,
        on: () => {},
        unref: () => {},
      };
      _getTrackedProcesses().set('gantry-server', fakeChild as any);
      const result = await hasSession('gantry-server');
      expect(result).toBe(false);
      expect(_getTrackedProcesses().has('gantry-server')).toBe(false);
    });

    it('throws for invalid agent name', async () => {
      await expect(hasSession('invalid-agent')).rejects.toThrow();
    });
  });

  describe('newSession', () => {
    it('spawns a detached process and registers it in trackedProcesses', async () => {
      const unref = mock(() => {});
      const on = mock(() => {});
      spawnSpy.mockImplementation(() => ({
        unref,
        on,
        pid: 12345,
        exitCode: null,
        killed: false,
      }));

      await newSession('test-agent', {
        executable: '/tmp/runner',
        args: ['--agent', 'test-agent'],
        cwd: '/tmp',
      });

      expect(spawnSpy).toHaveBeenCalledWith(
        '/tmp/runner',
        ['--agent', 'test-agent'],
        expect.objectContaining({
          detached: true,
          cwd: '/tmp',
        })
      );
      expect(unref).toHaveBeenCalled();
      expect(_getTrackedProcesses().has('test-agent')).toBe(true);
    });

    it('writes PID file as secondary record', async () => {
      const on = mock(() => {});
      spawnSpy.mockImplementation(() => ({
        unref: () => {},
        on,
        pid: 55555,
        exitCode: null,
        killed: false,
      }));

      await newSession('test-agent', {
        executable: '/tmp/runner',
        args: [],
      });

      expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('test-agent.pid'), '55555', 'utf-8');
    });

    it('registers exit handler that cleans up tracked ref', async () => {
      let exitHandler: (() => void) | undefined;
      const on = mock((event: string, cb: () => void) => {
        if (event === 'exit') exitHandler = cb;
      });
      spawnSpy.mockImplementation(() => ({
        unref: () => {},
        on,
        pid: 77777,
        exitCode: null,
        killed: false,
      }));

      await newSession('test-agent', { executable: '/tmp/runner', args: [] });
      expect(_getTrackedProcesses().has('test-agent')).toBe(true);

      exitHandler?.();
      expect(_getTrackedProcesses().has('test-agent')).toBe(false);
    });
  });

  describe('killSession', () => {
    it('calls kill on the tracked child process', async () => {
      const kill = mock(() => true);
      const fakeChild = {
        exitCode: null,
        killed: false,
        pid: 99,
        kill,
        on: () => {},
        unref: () => {},
      };
      _getTrackedProcesses().set('gantry-server', fakeChild as any);

      await killSession('gantry-server');
      expect(kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('cleans up dead ref without calling kill', async () => {
      const kill = mock(() => true);
      const fakeChild = {
        exitCode: 1,
        killed: false,
        pid: 99,
        kill,
        on: () => {},
        unref: () => {},
      };
      _getTrackedProcesses().set('gantry-server', fakeChild as any);

      await killSession('gantry-server');
      expect(kill).not.toHaveBeenCalled();
      expect(_getTrackedProcesses().has('gantry-server')).toBe(false);
    });

    it('does nothing if no tracked process', async () => {
      await expect(killSession('gantry-server')).resolves.toBeUndefined();
    });
  });

  describe('capturePane', () => {
    it('returns stdout from tailing log file via spawn', async () => {
      existsSpy.mockReturnValue(true);
      spawnSpy.mockImplementation(() => {
        const stdoutListeners: Record<string, (chunk: Buffer) => void> = {};
        const processListeners: Record<string, (code: number) => void> = {};
        return {
          stdout: {
            on: (event: string, cb: (chunk: Buffer) => void) => { stdoutListeners[event] = cb; },
          },
          on: (event: string, cb: (code: number) => void) => {
            processListeners[event] = cb;
            if (event === 'close') {
              Promise.resolve().then(() => {
                stdoutListeners['data']?.(Buffer.from('log content'));
                cb(0);
              });
            }
          },
          unref: () => {},
          pid: 12345,
          exitCode: null,
          killed: false,
        };
      });
      const result = await capturePane('gantry-server');
      expect(result).toBe('log content');
      expect(spawnSpy).toHaveBeenCalledWith(
        'tail', ['-n', '40', expect.stringContaining('gantry-server')]
      );
    });

    it('returns empty string if log file missing', async () => {
      existsSpy.mockReturnValue(false);
      const result = await capturePane('gantry-server');
      expect(result).toBe('');
    });

    it('returns empty string if spawn fails', async () => {
      existsSpy.mockReturnValue(true);
      spawnSpy.mockImplementation(() => {
        const processListeners: Record<string, (code: number | Error) => void> = {};
        return {
          stdout: { on: () => {} },
          on: (event: string, cb: (arg: number | Error) => void) => {
            processListeners[event] = cb;
            if (event === 'close') {
              Promise.resolve().then(() => cb(1));
            }
          },
          unref: () => {},
          pid: 0,
          exitCode: 1,
          killed: false,
        };
      });
      const result = await capturePane('gantry-server');
      expect(result).toBe('');
    });
  });

  describe('scanOrphanedProcesses', () => {
    it('returns orphaned processes not in trackedProcesses', async () => {
      const fakeChild = {
        exitCode: null,
        killed: false,
        pid: 12345,
        on: () => {},
        unref: () => {},
      };
      _getTrackedProcesses().set('test-agent', fakeChild as any);

      execSpy.mockImplementation((cmd: string, opts: any, cb: any) => {
        const callback = typeof opts === 'function' ? opts : cb;
        callback(null, '12345 bun gantry/dist/index.js\n99999 bun fleet-agents/run.ts\n', '');
      });

      const result = await scanOrphanedProcesses();
      expect(result.some((p) => p.pid === 99999)).toBe(true);
      expect(result.some((p) => p.pid === 12345)).toBe(false);
    });
  });
});
