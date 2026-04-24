import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'node:fs/promises';

import {
  readComms,
  appendOrder,
} from './file-manager.js';

describe('file-manager', () => {
  let readFileSpy: any;
  let appendFileSpy: any;
  let readdirSpy: any;
  let mkdirSpy: any;

  beforeEach(() => {
    // Use spyOn instead of mock.module to avoid process-wide leaks
    readFileSpy = spyOn(fs, 'readFile').mockImplementation((() => Promise.resolve('')) as unknown as typeof fs.readFile);
    appendFileSpy = spyOn(fs, 'appendFile').mockImplementation(async () => {});
    readdirSpy = spyOn(fs, 'readdir').mockImplementation(async () => []);
    mkdirSpy = spyOn(fs, 'mkdir').mockImplementation((() => Promise.resolve('')) as unknown as typeof fs.mkdir);
  });

  afterEach(() => {
    readFileSpy.mockRestore();
    appendFileSpy.mockRestore();
    readdirSpy.mockRestore();
    mkdirSpy.mockRestore();
  });

  describe('readComms', () => {
    it('returns orders, bulletin, and reports', async () => {
      readFileSpy
        .mockResolvedValueOnce('order 1\norder 2')  // orders.txt
        .mockResolvedValueOnce('bulletin content')    // bulletin.txt
        .mockResolvedValueOnce('report1 content')     // report1.txt
        .mockResolvedValueOnce('report2 content');     // report2.txt
      readdirSpy.mockResolvedValue(['report1.txt', 'report2.txt'] as any);

      const result = await readComms();
      expect(result.orders).toBe('order 1\norder 2');
      expect(result.bulletin).toBe('bulletin content');
      expect(result.reports).toEqual({
        report1: 'report1 content',
        report2: 'report2 content',
      });
    });
  });

  describe('appendOrder', () => {
    it('appends timestamped entry to orders.txt', async () => {
      await appendOrder('test order');

      expect(appendFileSpy).toHaveBeenCalledTimes(1);
      const call = appendFileSpy.mock.calls[0];
      expect(call[0]).toContain('orders.txt');
      expect(call[1]).toContain('test order');
      expect(call[1]).toMatch(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]/);
    });
  });
});
