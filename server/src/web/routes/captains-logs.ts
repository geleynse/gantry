/**
 * Captain's Logs API Routes
 *
 * Provides endpoints for querying and filtering captain's log entries
 * stored in the database.
 */

import { Router, type Request, type Response } from 'express';
import { createLogger } from '../../lib/logger.js';
import { queryString, queryInt } from '../middleware/query-helpers.js';
import {
  getCaptainsLogs,
  searchCaptainsLogs,
  getCaptainsLogsByLocation,
  getCaptainsLogStats,
  getFleetCaptainsLogs,
} from '../../services/captains-logs-db.js';

const log = createLogger('captains-logs-route');

export function createCaptainsLogsRouter(): import("express").Router {
  const router = Router();

  /**
   * GET /api/captains-logs/:agent
   * Get captain's logs for a specific agent
   *
   * Query parameters:
   *   - limit: number (default 50, max 200)
   *   - daysBack: number (optional, filter to last N days)
   */
  router.get('/:agent', (req: Request, res: Response) => {
    try {
      const agent = req.params.agent as string;
      const limit = Math.min(queryInt(req, 'limit') ?? 50, 200);
      const daysBack = queryInt(req, 'daysBack');

      const logs = getCaptainsLogs(agent, limit, daysBack);
      res.json({ agent, logs, count: logs.length });
    } catch (err) {
      log.error('Failed to get captain logs', { error: String(err) });
      res.status(500).json({ error: 'Failed to retrieve logs' });
    }
  });

  /**
   * POST /api/captains-logs/:agent/search
   * Search captain's logs by entry text
   *
   * Body:
   *   - query: string (search term)
   *   - limit: number (default 20, max 100)
   */
  router.post('/:agent/search', (req: Request, res: Response) => {
    try {
      const agent = req.params.agent as string;
      const { query } = req.body as Record<string, unknown>;

      if (!query || typeof query !== 'string') {
        return res.status(400).json({ error: 'Missing or invalid query parameter' });
      }

      const limit = Math.min(
        parseInt((req.body.limit as string) || '20'),
        100
      );

      const results = searchCaptainsLogs(agent, query, limit);
      res.json({ agent, query, results, count: results.length });
    } catch (err) {
      log.error('Failed to search captain logs', { error: String(err) });
      res.status(500).json({ error: 'Search failed' });
    }
  });

  /**
   * GET /api/captains-logs/:agent/location/:system
   * Get logs for a specific system
   *
   * Query parameters:
   *   - limit: number (default 50, max 200)
   */
  router.get('/:agent/location/:system', (req: Request, res: Response) => {
    try {
      const agent = req.params.agent as string;
      const system = req.params.system as string;
      const limit = Math.min(queryInt(req, 'limit') ?? 50, 200);

      const logs = getCaptainsLogsByLocation(agent, system, limit);
      res.json({ agent, system, logs, count: logs.length });
    } catch (err) {
      log.error('Failed to get logs by location', { error: String(err) });
      res.status(500).json({ error: 'Failed to retrieve logs' });
    }
  });

  /**
   * GET /api/captains-logs/:agent/stats
   * Get statistics about an agent's captain's logs
   */
  router.get('/:agent/stats', (req: Request, res: Response) => {
    try {
      const agent = req.params.agent as string;
      const stats = getCaptainsLogStats(agent);
      res.json({ agent, stats });
    } catch (err) {
      log.error('Failed to get captain logs stats', { error: String(err) });
      res.status(500).json({ error: 'Failed to retrieve stats' });
    }
  });

  /**
   * GET /api/captains-logs/fleet
   * Get captain's logs from all agents (fleet-wide view)
   *
   * Query parameters:
   *   - agents: comma-separated agent names (optional, defaults to all)
   *   - limit: number (default 100, max 500)
   */
  router.get('/', (req: Request, res: Response) => {
    try {
      const agentString = queryString(req, 'agents');
      const agents = agentString ? agentString.split(',').map(a => a.trim()) : undefined;
      const limit = Math.min(queryInt(req, 'limit') ?? 100, 500);

      const logs = getFleetCaptainsLogs(agents, limit);
      res.json({ logs, count: logs.length });
    } catch (err) {
      log.error('Failed to get fleet captain logs', { error: String(err) });
      res.status(500).json({ error: 'Failed to retrieve logs' });
    }
  });

  return router;
}
