/**
 * Directive routes for per-agent standing orders and one-shot nudges.
 *
 * GET    /api/agents/:name/directives        — list active directives + nudge state
 * POST   /api/agents/:name/directives        — add a directive
 * DELETE /api/agents/:name/directives/:id    — deactivate a directive
 * POST   /api/agents/:name/nudge             — send a one-shot nudge (uses inject signal)
 */

import { Router } from 'express';
import { validateAgentName } from '../config.js';
import {
  getActiveDirectives,
  addDirective,
  removeDirective,
  type DirectivePriority,
} from '../../services/directives.js';
import { createSignal } from '../../services/signals-db.js';
import { getAgentNudgeState } from '../../proxy/nudge-integration.js';
import { agentControlLimiter } from '../middleware/rate-limit.js';
import { sanitizeInjectInstruction, validateInjectInstruction } from './inject.js';

export const MAX_DIRECTIVE_LENGTH = 2_048;

const VALID_PRIORITIES = new Set<DirectivePriority>(['low', 'normal', 'high', 'critical']);

function isValidPriority(p: unknown): p is DirectivePriority {
  return typeof p === 'string' && VALID_PRIORITIES.has(p as DirectivePriority);
}

const router: Router = Router();

// GET /api/agents/:name/directives
router.get('/:name/directives', (req, res) => {
  const name = req.params.name as string;
  if (!validateAgentName(name)) {
    res.status(404).json({ error: 'Unknown agent' });
    return;
  }

  const directives = getActiveDirectives(name);
  const nudgeState = getAgentNudgeState(name);

  res.json({ directives, nudgeState });
});

// POST /api/agents/:name/directives
router.post('/:name/directives', agentControlLimiter, (req, res) => {
  const name = req.params.name as string;
  if (!validateAgentName(name)) {
    res.status(404).json({ error: 'Unknown agent' });
    return;
  }

  const body = req.body ?? {};
  const text = body.text;
  const priority: DirectivePriority = isValidPriority(body.priority) ? body.priority : 'normal';
  const expiresInMinutes = typeof body.expires_in_minutes === 'number' ? body.expires_in_minutes : null;

  if (typeof text !== 'string' || text.trim().length === 0) {
    res.status(400).json({ error: 'validation_error', message: '`text` must be a non-empty string' });
    return;
  }

  const sanitized = sanitizeInjectInstruction(text);
  if (sanitized.length === 0) {
    res.status(400).json({ error: 'validation_error', message: '`text` must be a non-empty string' });
    return;
  }

  if (sanitized.length > MAX_DIRECTIVE_LENGTH) {
    res.status(400).json({
      error: 'validation_error',
      message: `\`text\` must not exceed ${MAX_DIRECTIVE_LENGTH} characters`,
    });
    return;
  }

  let expiresAt: string | null = null;
  if (expiresInMinutes !== null && expiresInMinutes > 0) {
    const expiry = new Date(Date.now() + expiresInMinutes * 60_000);
    expiresAt = expiry.toISOString().replace('T', ' ').slice(0, 19);
  }

  const id = addDirective(name, sanitized, priority, expiresAt);
  res.status(201).json({ ok: true, id });
});

// DELETE /api/agents/:name/directives/:id
router.delete('/:name/directives/:id', agentControlLimiter, (req, res) => {
  const name = req.params.name as string;
  if (!validateAgentName(name)) {
    res.status(404).json({ error: 'Unknown agent' });
    return;
  }

  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: 'Invalid directive ID' });
    return;
  }

  const ok = removeDirective(id);
  if (!ok) {
    res.status(404).json({ error: 'Directive not found or already inactive' });
    return;
  }

  res.json({ ok: true });
});

// POST /api/agents/:name/nudge — one-shot message (uses inject signal)
router.post('/:name/nudge', agentControlLimiter, (req, res) => {
  const name = req.params.name as string;
  if (!validateAgentName(name)) {
    res.status(404).json({ error: 'Unknown agent' });
    return;
  }

  const validation = validateInjectInstruction((req.body ?? {}).message);
  if (!validation.ok) {
    res.status(400).json({ error: 'validation_error', message: validation.message });
    return;
  }

  createSignal(name, 'inject', validation.value);
  res.json({ ok: true });
});

export default router;
