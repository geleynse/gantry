import { Router } from 'express';
import { join } from 'node:path';
import { FileWatcher } from '../../services/file-watcher.js';
import { initSSE, writeSSE } from '../sse.js';

export function createServerLogsRouter(fleetDir: string): Router {
  const router: Router = Router();

  // SSE stream for server logs
  router.get('/stream', async (req, res) => {
    initSSE(req, res);

    const logPath = join(fleetDir, 'logs', 'server.log');
    const watcher = new FileWatcher(logPath);
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
        writeSSE(res, 'status', { message: 'Server log file is empty or not found' });
      }

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

  return router;
}

export default createServerLogsRouter;
