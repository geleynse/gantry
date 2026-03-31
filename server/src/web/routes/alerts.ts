/**
 * Agent alerts API routes.
 *
 * GET  /api/alerts           — list pending alerts (optional ?agent= filter)
 * GET  /api/alerts/count     — unacknowledged count (for nav badge)
 * POST /api/alerts/:id/acknowledge  — mark one alert acknowledged
 * POST /api/alerts/acknowledge-all  — bulk acknowledge (optional ?agent= filter)
 */
import { Router } from 'express';
import {
  getPendingAlerts,
  getAlertCount,
  acknowledgeAlert,
  acknowledgeAll,
} from '../../services/alerts-db.js';

const router = Router();

// GET /count — unacknowledged count for badge display
router.get('/count', (_req, res) => {
  const count = getAlertCount();
  res.json({ count });
});

// POST /acknowledge-all — must be before /:id routes
router.post('/acknowledge-all', (req, res) => {
  const agent = typeof req.query.agent === 'string' ? req.query.agent : undefined;
  const by = req.auth?.identity ?? 'operator';
  const count = acknowledgeAll(agent);
  res.json({ ok: true, acknowledged: count, by });
});

// GET / — list pending alerts
router.get('/', (req, res) => {
  const agent = typeof req.query.agent === 'string' ? req.query.agent : undefined;
  const alerts = getPendingAlerts(agent);
  res.json(alerts);
});

// POST /:id/acknowledge
router.post('/:id/acknowledge', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: 'Invalid alert ID' });
    return;
  }
  const by = req.auth?.identity ?? 'operator';
  const ok = acknowledgeAlert(id, by);
  if (!ok) {
    res.status(404).json({ error: 'Alert not found or already acknowledged' });
    return;
  }
  res.json({ ok: true });
});

export default router;
