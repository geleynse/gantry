/**
 * Prayer canary endpoint — one-shot operator verification for PrayerLang.
 *
 * POST /api/prayer-canary
 * Body: { agent: string }
 *
 * Starts the named agent with a canary system prompt that directs it to call
 * spacemolt_pray as its very first action and then exit. This lets the operator
 * confirm prayer routing is working end-to-end without waiting for the agent to
 * naturally hit a prayer-eligible moment during a normal run.
 */

import { Router } from 'express';
import { startAgentCanary } from '../../services/agent-manager.js';
import { validateAgentName } from '../../config.js';

const router = Router();

router.post('/', async (req, res) => {
  const { agent } = (req.body ?? {}) as { agent?: unknown };

  if (typeof agent !== 'string' || !agent.trim()) {
    res.status(400).json({ error: 'Body must include { agent: "<agent-name>" }' });
    return;
  }

  const agentName = agent.trim();
  if (!validateAgentName(agentName)) {
    res.status(404).json({ error: `Unknown agent: ${agentName}` });
    return;
  }

  const result = await startAgentCanary(agentName);
  res.status(result.ok ? 200 : 400).json(result);
});

export default router;
