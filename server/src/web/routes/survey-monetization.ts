/**
 * Survey monetization API route.
 *
 * GET /api/survey-monetization
 *   ?hours=<n>     Window for the totals + recent list (default 24, max 720 = 30d)
 *   ?agent=<name>  Restrict to a single agent (default: both spec agents)
 *
 * Reads `proxy_tool_calls` (+ `session_handoffs` for the per-session
 * timeline) and returns a `SurveyMonetizationReport`. The `sessions` field
 * buckets tagged-note posts/sales by fleet session so we can tell whether
 * the "≥1 saleable note posted per session" target is being hit.
 * No new tables, no behavior change to the proxy. Pure read path.
 */

import { Router } from 'express';
import { createLogger } from '../../lib/logger.js';
import { queryString, queryInt } from '../middleware/query-helpers.js';
import { getSurveyMonetizationReport } from '../../services/survey-monetization.js';

const log = createLogger('survey-monetization-route');

const router: Router = Router();

router.get('/', (req, res) => {
  try {
    const hours = Math.min(Math.max(queryInt(req, 'hours') ?? 24, 1), 720);
    const agent = queryString(req, 'agent') || undefined;

    const report = getSurveyMonetizationReport({ hours, agent });
    res.json(report);
  } catch (err) {
    log.error('Failed to build survey-monetization report', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to build report' });
  }
});

export default router;
