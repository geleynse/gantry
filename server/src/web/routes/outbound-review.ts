/**
 * Outbound content review API routes.
 *
 * Provides admin endpoints for reviewing, approving, and rejecting
 * agent-generated content before it reaches public channels.
 *
 * GET /api/outbound/pending?channel=        — list pending (admin)
 * GET /api/outbound/pending/count?channel=  — pending count badge (viewer)
 * GET /api/outbound/history?agent=&channel=&limit= — history (admin)
 * POST /api/outbound/approve/:id            — approve + replay (admin)
 * POST /api/outbound/reject/:id             — reject with optional reason (admin)
 * POST /api/outbound/approve-all?channel=   — batch approve (admin)
 */
import { Router } from 'express';
import { createLogger } from '../../lib/logger.js';
import {
  getPending, getPendingCount, getHistory,
  approveMessage, rejectMessage,
  type OutboundChannel,
} from '../../services/outbound-review.js';

const log = createLogger('outbound-review');

/** Minimal interface for executing game commands on behalf of an agent. */
export interface AgentSessionExecutor {
  getClient(agentName: string): {
    execute(cmd: string, args?: Record<string, unknown>): Promise<{ result?: unknown; error?: unknown }>;
  } | undefined;
}

const VALID_CHANNELS = new Set<string>(["forum", "discord", "chat"]);

function parseChannel(raw: unknown): OutboundChannel | undefined {
  if (typeof raw === 'string' && VALID_CHANNELS.has(raw)) return raw as OutboundChannel;
  return undefined;
}

function requireAdmin(req: { auth?: { role?: string } }, res: { status: (n: number) => { json: (o: unknown) => void } }): boolean {
  if (req.auth?.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return false;
  }
  return true;
}

export function createOutboundReviewRouter(executor?: AgentSessionExecutor): Router {
  const router = Router();

  // GET /pending/count — viewer-accessible for badge display
  router.get('/pending/count', (req, res) => {
    const channel = parseChannel(req.query.channel);
    const count = getPendingCount(channel);
    res.json({ count });
  });

  // GET /pending — admin only (content is private)
  router.get('/pending', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const channel = parseChannel(req.query.channel);
    const messages = getPending(channel);
    res.json(messages);
  });

  // GET /history — admin only
  router.get('/history', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const agent = typeof req.query.agent === 'string' ? req.query.agent : undefined;
    const channel = parseChannel(req.query.channel);
    const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) || 50 : 50;
    const messages = getHistory({ agent, channel, limit });
    res.json(messages);
  });

  async function replayMessage(
    id: number,
    agentName: string,
    metadata: Record<string, unknown>,
  ): Promise<string | null> {
    if (!executor) return null;
    try {
      const v1Action = typeof metadata.v1_action === 'string' ? metadata.v1_action : null;
      const v1Params = metadata.v1_params && typeof metadata.v1_params === 'object'
        ? metadata.v1_params as Record<string, unknown>
        : {};
      if (!v1Action) return null;
      const client = executor.getClient(agentName);
      if (!client) {
        log.warn('Outbound replay: no active session', { id, agentName });
        return `Agent "${agentName}" has no active session — message approved but not sent`;
      }
      const result = await client.execute(v1Action, v1Params);
      if (result.error) {
        log.warn('Outbound replay failed', { id, agentName, v1Action, error: result.error });
        return `Game server error: ${JSON.stringify(result.error)}`;
      }
      log.info('Outbound replay success', { id, agentName, v1Action });
      return null;
    } catch (err) {
      log.error('Outbound replay exception', { id, error: err });
      return `Replay exception: ${(err as Error).message}`;
    }
  }

  // POST /approve/:id — approve and replay to game server
  router.post('/approve/:id', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid message ID' });
      return;
    }
    const reviewer = req.auth?.identity ?? 'admin';
    const msg = approveMessage(id, reviewer);
    if (!msg) {
      res.status(404).json({ error: 'Message not found or already reviewed' });
      return;
    }

    const replayError = await replayMessage(id, msg.agentName, msg.metadata);
    res.json({ ok: true, message: msg, replayError });
  });

  // POST /reject/:id
  router.post('/reject/:id', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid message ID' });
      return;
    }
    const reviewer = req.auth?.identity ?? 'admin';
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
    const ok = rejectMessage(id, reviewer, reason);
    if (!ok) {
      res.status(404).json({ error: 'Message not found or already reviewed' });
      return;
    }
    res.json({ ok: true });
  });

  // POST /approve-all?channel= — batch approve all pending
  router.post('/approve-all', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const channel = parseChannel(req.query.channel);
    const reviewer = req.auth?.identity ?? 'admin';

    const pending = getPending(channel);
    const results: Array<{ id: number; ok: boolean; replayError?: string }> = [];

    for (const msg of pending) {
      approveMessage(msg.id, reviewer);
      const replayError = await replayMessage(msg.id, msg.agentName, msg.metadata) ?? undefined;
      results.push({ id: msg.id, ok: !replayError, replayError });
    }

    log.info(`Batch approved ${results.length} messages`, { channel: channel ?? 'all', reviewer });
    res.json({ ok: true, approved: results.length, results });
  });

  return router;
}
