import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import * as net from 'node:net';
import { checkProxyHealth } from './proxy-health.js';

describe('proxy-health', () => {
  let connSpy: any;

  beforeEach(() => {
    // Use spyOn instead of mock.module
    connSpy = spyOn(net, 'createConnection').mockImplementation(() => ({
      on: () => {},
      destroy: () => {},
      end: () => {},
    } as any));
  });

  afterEach(() => {
    connSpy.mockRestore();
  });

  it('returns up when TCP connection succeeds', async () => {
    const mockSocket = {
      on: mock((_event: string, _cb: any) => {}),
      destroy: mock(() => {}),
      end: mock(() => {}),
    };
    connSpy.mockReturnValue(mockSocket as any);

    const promise = checkProxyHealth(1081);
    const connectHandler = mockSocket.on.mock.calls.find((c: any[]) => c[0] === 'connect')?.[1];
    connectHandler?.();

    const result = await promise;
    expect(result).toBe('up');
    expect(mockSocket.end).toHaveBeenCalled();
  });

  it('returns down when TCP connection fails', async () => {
    const mockSocket = {
      on: mock((_event: string, _cb: any) => {}),
      destroy: mock(() => {}),
      end: mock(() => {}),
    };
    connSpy.mockReturnValue(mockSocket as any);

    const promise = checkProxyHealth(1081);
    const errorHandler = mockSocket.on.mock.calls.find((c: any[]) => c[0] === 'error')?.[1];
    errorHandler?.(new Error('ECONNREFUSED'));

    const result = await promise;
    expect(result).toBe('down');
    expect(mockSocket.destroy).toHaveBeenCalled();
  });
});
