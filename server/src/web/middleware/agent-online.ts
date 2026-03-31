/**
 * Middleware that blocks proxy requests for offline agents.
 *
 * Checks the proxy_sessions table for an active session. If the agent has no
 * active session, returns 503 with a structured JSON error before the request
 * reaches the game client layer.
 *
 * Apply to agent-specific routes that forward requests to a game session
 * (e.g. /:name/order, /:name/routine). Do NOT apply to status/health/config
 * endpoints, or fleet-wide control routes (start-all, stop-all).
 */
import type { Request, Response, NextFunction } from 'express';
import { hasActiveProxySession } from '../../services/agent-queries.js';
import { hasSession } from '../../services/process-manager.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('agent-online');

/**
 * Express middleware that rejects requests for offline agents with HTTP 503.
 *
 * Expects the agent name in `req.params.name`. Falls through to `next()`
 * for requests without a `:name` param (non-agent routes mounted on the same
 * router will not be affected).
 *
 * Checks:
 *   1. `hasActiveProxySession()` — DB record of active game session
 *   2. `hasSession()` — in-memory / PID-file process tracking
 *
 * Either check passing is sufficient — the agent is considered online if its
 * process is up even if the session record is momentarily stale (e.g. during
 * a reconnect), or if the session record is present even though the process
 * manager hasn't tracked it (external launch).
 */
export async function requireAgentOnline(req: Request, res: Response, next: NextFunction): Promise<void> {
  const rawName = req.params.name;

  // No `:name` param — not an agent-specific route, let it through
  if (!rawName) {
    next();
    return;
  }

  const name = String(rawName);

  // Check proxy session DB first (synchronous, cheapest)
  const hasProxy = hasActiveProxySession(name);

  if (hasProxy) {
    next();
    return;
  }

  // Fallback: check process manager (async, handles external-launch agents)
  try {
    const hasProc = await hasSession(name);
    if (hasProc) {
      next();
      return;
    }
  } catch (err) {
    // Process-manager errors shouldn't block the offline check — log and fall through
    log.warn(`hasSession check failed for ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }

  log.warn(`Blocked request for offline agent`, { agent: name, method: req.method, path: req.path });

  res.status(503).json({
    error: 'agent_offline',
    message: `Agent '${name}' is not running. Start the agent first.`,
    agent: name,
  });
}
