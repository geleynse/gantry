/**
 * GET /api/diagnostics/schema
 * GET /api/diagnostics/rate-limits
 *
 * Schema returns the list of database tables.
 * Rate-limits returns a snapshot of all rate limiter state.
 */
import { Router } from 'express';
import { queryAll } from '../../services/database.js';
import { createLogger } from '../../lib/logger.js';
import rateLimitsRouter from './rate-limits.js';

const log = createLogger("diagnostics");

const router: Router = Router();

router.get('/schema', (_req, res) => {
  try {
    const tables = queryAll<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    res.json({ tables: tables.map(t => t.name) });
  } catch (err) {
    log.error("Diagnostics error", { error: String(err) });
    res.status(500).json({ error: "Internal diagnostics error" });
  }
});

router.get('/migrations', (_req, res) => {
  res.json({ migrations: [], note: "Schema applied inline at startup via SCHEMA_SQL in database.ts" });
});

// Rate limit stats (no DI needed — reads from module-level registry)
router.use(rateLimitsRouter);

export default router;
