import { Router } from 'express';
import { join } from 'node:path';
import { access } from 'node:fs/promises';
import type { GantryConfig } from '../../config.js';
import { FileWatcher } from '../../services/file-watcher.js';
import { initSSE, writeSSE } from '../sse.js';
import { queryString, queryInt } from '../middleware/query-helpers.js';

export function createLogsRouter(fleetDir: string, config: GantryConfig): Router {
  const router: Router = Router();

  function isValidAgent(name: string): boolean {
    return config.agents.some((a) => a.name === name);
  }

  function logPath(agentName: string): string {
    return join(fleetDir, 'logs', `${agentName}.log`);
  }

  // SSE log stream from file
  router.get('/:name/logs/stream', async (req, res) => {
    const name = req.params.name;
    if (!isValidAgent(name)) {
      res.status(404).json({ error: `Unknown agent: ${name}` });
      return;
    }

    initSSE(req, res);

    const filePath = logPath(name);
    const watcher = new FileWatcher(filePath);
    let aborted = false;

    req.on('close', () => {
      aborted = true;
      watcher.close();
    });

    try {
      // Send initial tail
      const initial = await watcher.readTail(100);
      if (initial.lines.length > 0) {
        writeSSE(res, 'log', { lines: initial.lines, offset: initial.offset });
      } else {
        // Check if file actually exists
        try {
          await access(filePath);
          // File exists but is empty
          writeSSE(res, 'status', { message: `Log file exists but is empty for ${name}`, path: filePath });
        } catch {
          writeSSE(res, 'status', { message: `No log file found for ${name}`, path: filePath });
        }
      }

      writeSSE(res, 'meta', { fileSize: initial.offset, path: filePath });

      let currentOffset = initial.offset;

      while (!aborted) {
        const result = await watcher.readFrom(currentOffset);
        if (result.lines.length > 0) {
          writeSSE(res, 'log', { lines: result.lines, offset: result.offset });
          currentOffset = result.offset;
        }
        await new Promise(r => setTimeout(r, 200));
      }
    } finally {
      watcher.close();
      res.end();
    }
  });

  // Log history (paginated by byte offset)
  router.get('/:name/logs/history', async (req, res) => {
    const name = req.params.name;
    if (!isValidAgent(name)) {
      res.status(404).json({ error: `Unknown agent: ${name}` });
      return;
    }

    const offset = queryInt(req, 'offset') ?? 0;
    const limit = queryInt(req, 'limit') ?? 100;

    const watcher = new FileWatcher(logPath(name));
    const result = await watcher.readHistory(offset, limit);
    watcher.close();

    res.json(result);
  });

  // Log search
  router.get('/:name/logs/search', async (req, res) => {
    const name = req.params.name;
    if (!isValidAgent(name)) {
      res.status(404).json({ error: `Unknown agent: ${name}` });
      return;
    }

    const query = queryString(req, 'q') ?? '';
    const limit = queryInt(req, 'limit') ?? 50;
    if (!query) {
      res.json({ results: [] });
      return;
    }

    const watcher = new FileWatcher(logPath(name));
    const { lines } = await watcher.readFrom(0);
    watcher.close();

    const results: Array<{ line: string; lineNumber: number }> = [];
    const lowerQuery = query.toLowerCase();
    for (let i = 0; i < lines.length && results.length < limit; i++) {
      if (lines[i].toLowerCase().includes(lowerQuery)) {
        results.push({ line: lines[i], lineNumber: i + 1 });
      }
    }

    res.json({ results, count: results.length });
  });

  // Raw log file tail (kept for backward compat)
  router.get('/:name/logfile', async (req, res) => {
    const name = req.params.name;
    if (!isValidAgent(name)) {
      res.status(404).json({ error: `Unknown agent: ${name}` });
      return;
    }

    const maxLines = queryInt(req, 'lines') ?? 200;
    const watcher = new FileWatcher(logPath(name));
    const { lines: allLines } = await watcher.readFrom(0);
    watcher.close();
    const tailLines = allLines.slice(-maxLines);
    res.json({ lines: tailLines.join('\n') });
  });

  return router;
}

export default createLogsRouter;
