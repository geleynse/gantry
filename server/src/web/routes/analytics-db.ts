import { Router } from 'express';
import type { Request } from 'express';
import { validateAgentName } from '../config.js';
import { queryString, queryInt } from '../middleware/query-helpers.js';
import {
  getCostOverTime,
  getToolFrequency,
  getCreditsOverTime,
  getAgentComparison,
  getHullShieldOverTime,
  getEconomicTransactions,
  getExpensiveTurns,
  getEfficiencyMetrics,
  getSystemPois,
  getAgentTrails,
  getModelCostComparison,
} from '../../services/analytics-query.js';

const router: Router = Router();

function parseFilter(req: Request) {
  const agentRaw = queryString(req, 'agent');
  return {
    hours: queryInt(req, 'hours'),
    agent: agentRaw && validateAgentName(agentRaw) ? agentRaw : undefined,
  };
}

router.get('/cost', (req, res) => {
  const filter = parseFilter(req);
  res.json(getCostOverTime(filter));
});

router.get('/tools', (req, res) => {
  const filter = parseFilter(req);
  res.json(getToolFrequency(filter));
});

router.get('/credits', (req, res) => {
  const filter = parseFilter(req);
  res.json(getCreditsOverTime(filter));
});

router.get('/comparison', (req, res) => {
  const filter = parseFilter(req);
  res.json(getAgentComparison(filter));
});

router.get('/hull-shield', (req, res) => {
  const filter = parseFilter(req);
  res.json(getHullShieldOverTime(filter));
});

router.get('/transactions', (req, res) => {
  const filter = parseFilter(req);
  res.json(getEconomicTransactions(filter));
});

// GET /api/analytics-db/expensive-turns?hours=24&agent=drifter-gale&limit=10
router.get('/expensive-turns', (req, res) => {
  const filter = parseFilter(req);
  const limit = queryInt(req, 'limit') ?? 10;
  res.json(getExpensiveTurns({ ...filter, limit }));
});

// GET /api/analytics-db/efficiency?hours=24&agent=drifter-gale
router.get('/efficiency', (req, res) => {
  const filter = parseFilter(req);
  res.json(getEfficiencyMetrics(filter));
});

// GET /api/analytics-db/system-pois?system=sys_0302
// Returns { [systemId]: string[] } — distinct POI names seen per system (or a single system).
router.get('/system-pois', (req, res) => {
  const system = queryString(req, 'system');
  res.json(getSystemPois(system));
});

// GET /api/analytics-db/agent-trails?hours=24&limit=10
// Returns { agent: string; systems: string[] }[] — recent system history per agent.
router.get('/agent-trails', (req, res) => {
  const filter = parseFilter(req);
  const limit = queryInt(req, 'limit') || 10;
  res.json(getAgentTrails(filter.hours ?? 24, limit));
});

// GET /api/analytics-db/model-costs?hours=24
// Per-model cost comparison: cost/turn, cost/hour, token efficiency.
router.get('/model-costs', (req, res) => {
  const filter = parseFilter(req);
  res.json(getModelCostComparison(filter));
});

export default router;
