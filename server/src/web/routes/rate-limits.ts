/**
 * GET /api/diagnostics/rate-limits
 *
 * Returns a snapshot of current state for all registered rate limiters:
 * active IPs, requests in current window, and total rejections (429s).
 */
import { Router } from 'express';
import { getRateLimitStats } from '../middleware/rate-limit.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger("rate-limits-route");

const router: Router = Router();

router.get('/rate-limits', (_req, res) => {
  try {
    const stats = getRateLimitStats();
    res.json(stats);
  } catch (err) {
    log.error("Failed to get rate limit stats", { error: String(err) });
    res.status(500).json({ error: "Internal error fetching rate limit stats" });
  }
});

export default router;
