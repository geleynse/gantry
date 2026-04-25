/**
 * Facilities scan request endpoint — operator-triggered nudge to populate the
 * facilities cache.
 *
 * POST /api/facilities-scan
 * Body: { agent?: string }   // omit / null for fleet-wide
 *
 * Drops a high-priority directive into the fleet_orders queue (same channel as
 * /api/fleet/broadcast and the comms /orders endpoint). The targeted agent(s)
 * pick the order up via getPendingOrders on their next turn and call
 * spacemolt(action="list_facilities") in-game, which populates the status
 * cache the Facilities page reads from.
 *
 * This is the closest thing the proxy has to "inject a tool call" — orders
 * are the established directive channel; we don't try to dispatch out-of-band.
 */
import { Router } from 'express';
import { createOrder } from '../../services/comms-db.js';
import { validateAgentName } from '../../config.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('facilities-scan');

const SCAN_MESSAGE =
  'Operator-requested facility scan. Call spacemolt(action="list_facilities") on your next turn so the dashboard can populate the Facilities view.';

const router: Router = Router();

router.post('/', (req, res) => {
  const body = (req.body ?? {}) as { agent?: unknown };
  let target: string | undefined;

  if (body.agent !== undefined && body.agent !== null && body.agent !== '') {
    if (typeof body.agent !== 'string' || !body.agent.trim()) {
      res.status(400).json({ error: 'agent must be a string or omitted for fleet-wide' });
      return;
    }
    const trimmed = body.agent.trim();
    if (!validateAgentName(trimmed)) {
      res.status(404).json({ error: `Unknown agent: ${trimmed}` });
      return;
    }
    target = trimmed;
  }

  // 30-minute expiry — if the agent isn't online to pick it up by then,
  // the operator will likely have moved on.
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  try {
    const orderId = createOrder({
      message: SCAN_MESSAGE,
      target_agent: target,
      priority: 'high',
      expires_at: expiresAt,
    });
    log.info('queued facility scan order', { orderId, target: target ?? '(fleet-wide)' });
    res.json({ ok: true, orderId, target: target ?? null });
  } catch (err) {
    log.error('failed to queue facility scan order', { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Failed to queue scan request' });
  }
});

export default router;
