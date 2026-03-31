import { Router } from 'express';
import { AGENTS, validateAgentName } from '../config.js';
import {
  getSessionInfo,
  getLatencyMetrics,
  getErrorRateBreakdown,
  getLastSuccessfulCommand,
} from '../../services/session-metrics.js';
import { getAllHealthScores } from '../../services/health-scorer.js';
import type { BreakerRegistry } from '../../proxy/circuit-breaker.js';
import type { AgentHealthDetails } from '../../shared/types.js';

/**
 * Map a circuit breaker state to a connection status string.
 *
 * The breakerRegistry is populated by SessionManager when a GameClient is created
 * for an agent (see src/proxy/session-manager.ts). Each GameClient registers its
 * own CircuitBreaker under the agent's label.
 *
 * Circuit state → connectionStatus:
 *   closed    → 'connected'     (normal operation)
 *   open      → 'disconnected'  (server is down, connections rejected)
 *   half-open → 'reconnecting'  (cooldown expired, probing recovery)
 *   (no entry) → 'disconnected' (GameClient not yet created for this agent)
 */
export function getConnectionStatus(
  agentName: string,
  registry: BreakerRegistry,
): AgentHealthDetails['connectionStatus'] {
  const breakers = registry.getAll();
  const breaker = breakers.get(agentName);
  if (!breaker) {
    // No GameClient registered yet — agent hasn't connected
    return 'disconnected';
  }
  const state = breaker.getState();
  switch (state) {
    case 'closed':    return 'connected';
    case 'open':      return 'disconnected';
    case 'half-open': return 'reconnecting';
    default:          return 'disconnected';
  }
}

/**
 * Create the health router.
 * Accepts an optional breakerRegistry for dependency injection in tests.
 */
export function createHealthRouter(registry: BreakerRegistry): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const scores = await getAllHealthScores(registry);
    res.json(scores);
  });

  /**
   * GET /api/health/sessions/:agent
   * Get session start and last tool call info for a specific agent.
   */
  router.get('/sessions/:agent', (req, res) => {
    const agent = req.params.agent;
    if (!validateAgentName(agent)) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const sessionInfo = getSessionInfo(agent);
    res.json(sessionInfo);
  });

  /**
   * GET /api/health/sessions
   * Get session info for all agents.
   */
  router.get('/sessions', (req, res) => {
    const sessions = AGENTS.map(a => getSessionInfo(a.name));
    res.json(sessions);
  });

  /**
   * GET /api/health/latency/:agent
   * Get latency percentiles for a specific agent.
   */
  router.get('/latency/:agent', (req, res) => {
    const agent = req.params.agent;
    if (!validateAgentName(agent)) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const metrics = getLatencyMetrics(agent);
    res.json(metrics);
  });

  /**
   * GET /api/health/latency
   * Get latency metrics for all agents.
   */
  router.get('/latency', (req, res) => {
    const metrics = AGENTS.map(a => getLatencyMetrics(a.name));
    res.json(metrics);
  });

  /**
   * GET /api/health/errors/:agent
   * Get error rate and breakdown for a specific agent.
   */
  router.get('/errors/:agent', (req, res) => {
    const agent = req.params.agent;
    if (!validateAgentName(agent)) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const breakdown = getErrorRateBreakdown(agent);
    res.json(breakdown);
  });

  /**
   * GET /api/health/errors
   * Get error rates for all agents.
   */
  router.get('/errors', (req, res) => {
    const errors = AGENTS.map(a => getErrorRateBreakdown(a.name));
    res.json(errors);
  });

  /**
   * GET /api/health/detailed/:agent
   * Get comprehensive health details for a specific agent.
   */
  router.get('/detailed/:agent', (req, res) => {
    const agent = req.params.agent;
    if (!validateAgentName(agent)) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const details: AgentHealthDetails = {
      agent,
      latency: getLatencyMetrics(agent),
      errorRate: getErrorRateBreakdown(agent),
      lastSuccessfulCommand: getLastSuccessfulCommand(agent),
      connectionStatus: getConnectionStatus(agent, registry),
    };

    res.json(details);
  });

  /**
   * GET /api/health/detailed
   * Get comprehensive health details for all agents.
   */
  router.get('/detailed', (req, res) => {
    const details = AGENTS.map(a => ({
      agent: a.name,
      latency: getLatencyMetrics(a.name),
      errorRate: getErrorRateBreakdown(a.name),
      lastSuccessfulCommand: getLastSuccessfulCommand(a.name),
      connectionStatus: getConnectionStatus(a.name, registry),
    } satisfies AgentHealthDetails));

    res.json(details);
  });

  return router;
}


