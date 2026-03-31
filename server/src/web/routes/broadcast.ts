import { Router } from 'express';
import { getConfig } from '../config.js';
import { createOrder } from '../../services/comms-db.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('broadcast');
const router: Router = Router();

// In-memory broadcast history (last 20)
interface BroadcastRecord {
  id: string;
  message: string;
  targets: string[];
  sent: string[];
  failed: string[];
  timestamp: string;
}

const broadcastHistory: BroadcastRecord[] = [];
const MAX_HISTORY = 20;

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/**
 * POST /api/fleet/broadcast
 * Send a directive to all (or selected) agents simultaneously.
 * Body: { message: string, targets?: string[], priority?: 'normal' | 'urgent' }
 * Returns: { sent: string[], failed: string[], id: string }
 */
router.post('/', (req, res) => {
  const body = req.body ?? {};
  const { message, targets, priority } = body;

  if (!message || typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  if (priority !== undefined && priority !== 'normal' && priority !== 'urgent') {
    res.status(400).json({ error: 'priority must be "normal" or "urgent"' });
    return;
  }

  const config = getConfig();
  const allAgentNames = config.agents.map((a) => a.name);

  // Resolve target list — default to all agents
  let resolvedTargets: string[];
  if (Array.isArray(targets) && targets.length > 0) {
    // Validate each requested target
    const invalid = targets.filter((t) => !allAgentNames.includes(t));
    if (invalid.length > 0) {
      res.status(400).json({ error: `Unknown agents: ${invalid.join(', ')}` });
      return;
    }
    resolvedTargets = targets;
  } else {
    resolvedTargets = allAgentNames;
  }

  const sent: string[] = [];
  const failed: string[] = [];

  for (const target of resolvedTargets) {
    try {
      createOrder({ message, target_agent: target, priority: priority ?? 'normal' });
      sent.push(target);
    } catch (err) {
      log.error(`Failed to create order for ${target}`, { error: err instanceof Error ? err.message : String(err) });
      failed.push(target);
    }
  }

  const record: BroadcastRecord = {
    id: generateId(),
    message,
    targets: resolvedTargets,
    sent,
    failed,
    timestamp: new Date().toISOString(),
  };

  // Prepend and trim to last MAX_HISTORY
  broadcastHistory.unshift(record);
  if (broadcastHistory.length > MAX_HISTORY) {
    broadcastHistory.splice(MAX_HISTORY);
  }

  log.info(`Broadcast to ${sent.length}/${resolvedTargets.length} agents`, { message: message.slice(0, 80), sent, failed });

  res.json({ ok: true, id: record.id, sent, failed });
});

/**
 * GET /api/fleet/broadcast/history
 * Returns the last 20 broadcasts.
 */
router.get('/history', (_req, res) => {
  res.json({ history: broadcastHistory });
});

export default router;
