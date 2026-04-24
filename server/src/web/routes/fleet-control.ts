import { Router } from 'express';
import { validateAgentName } from '../config.js';
import { createOrder } from '../../services/comms-db.js';
import { getAvailableRoutines, hasRoutine } from '../../routines/routine-runner.js';
import { getSessionShutdownManager } from '../../proxy/session-shutdown.js';
import { requireAgentOnline } from '../middleware/agent-online.js';
import { getRoutineJob, listRoutineJobs, toRoutineJobSnapshot, type RoutineJobStatus } from '../../services/routine-jobs.js';

// ---------------------------------------------------------------------------
// Agent fleet control routes (mounted at /api/agents)
// ---------------------------------------------------------------------------

export const agentFleetControlRouter: import("express").Router = Router();

/**
 * POST /api/agents/:name/order
 * Send a fleet order to a specific agent.
 *
 * Special order types (no message required):
 *   { type: "stop_after_turn" } — agent finishes its current turn, then stops cleanly.
 */
agentFleetControlRouter.post('/:name/order', requireAgentOnline, (req, res) => {
  const name = String(req.params.name);
  if (!validateAgentName(name)) {
    res.status(404).json({ error: 'Unknown agent' });
    return;
  }

  const body = req.body ?? {};
  const { message, priority, type } = body;

  // Handle special lifecycle order types
  if (type === 'stop_after_turn') {
    const shutdownManager = getSessionShutdownManager();
    const shutdownState = shutdownManager.requestStopAfterTurn(name, 'Order: stop_after_turn');
    res.json({ ok: true, state: shutdownState });
    return;
  }

  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  if (priority !== undefined && priority !== 'normal' && priority !== 'urgent') {
    res.status(400).json({ error: 'priority must be "normal" or "urgent"' });
    return;
  }

  const id = createOrder({ message, target_agent: name, priority });
  res.json({ ok: true, id });
});

/**
 * POST /api/agents/:name/routine
 * Trigger a named routine for a specific agent via fleet order.
 */
agentFleetControlRouter.post('/:name/routine', requireAgentOnline, (req, res) => {
  const name = String(req.params.name);
  if (!validateAgentName(name)) {
    res.status(404).json({ error: 'Unknown agent' });
    return;
  }

  const body = req.body ?? {};
  const { routine, params } = body;

  if (!routine || typeof routine !== 'string') {
    res.status(400).json({ error: 'routine is required' });
    return;
  }

  if (!hasRoutine(routine)) {
    res.status(400).json({ error: `Unknown routine: ${routine}`, available: getAvailableRoutines() });
    return;
  }

  const paramsStr = params ? JSON.stringify(params) : '{}';
  const message = `[OPERATOR] Execute routine: ${routine}\nParams: ${paramsStr}`;
  const id = createOrder({ message, target_agent: name, priority: 'urgent' });
  res.json({ ok: true, id });
});

// ---------------------------------------------------------------------------
// Routines listing (mounted at /api/routines)
// ---------------------------------------------------------------------------

export const routinesRouter: import("express").Router = Router();

/**
 * GET /api/routines
 * Returns the list of available routine names.
 */
routinesRouter.get('/', (_req, res) => {
  const routines = getAvailableRoutines();
  res.json({ routines });
});

/**
 * GET /api/routines/jobs
 * Returns recent routine job history, including async Codex routine state.
 */
routinesRouter.get('/jobs', (req, res) => {
  const agentName = typeof req.query.agent === 'string' ? req.query.agent : undefined;
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const limit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : undefined;

  if (status && !['running', 'completed', 'error'].includes(status)) {
    res.status(400).json({ error: 'status must be running, completed, or error' });
    return;
  }

  res.json({
    jobs: listRoutineJobs({
      agentName,
      status: status as RoutineJobStatus | undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
    }),
  });
});

/**
 * GET /api/routines/jobs/:id
 * Returns one routine job by id.
 */
routinesRouter.get('/jobs/:id', (req, res) => {
  const job = getRoutineJob(String(req.params.id));
  if (!job) {
    res.status(404).json({ error: 'Routine job not found' });
    return;
  }
  res.json({ job: toRoutineJobSnapshot(job) });
});
