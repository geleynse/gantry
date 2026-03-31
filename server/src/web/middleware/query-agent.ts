/**
 * Shared utility for extracting and validating the `?agent=` query parameter.
 *
 * Three variants cover different use cases:
 *
 * 1. extractQueryAgent(req) — type-safe coercion, no config validation:
 *      const agent = extractQueryAgent(req);
 *    Use this for SQL filter routes where any agent name string is valid.
 *    Replaces raw `req.query.agent as string | undefined` casts.
 *
 * 2. getQueryAgent(req) — validates against the fleet config registry:
 *      const agent = getQueryAgent(req);
 *    Returns undefined for unknown agents. Use when you need a known fleet agent.
 *
 * 3. requireQueryAgent(req, res) — required, missing or unknown both 400:
 *      const agent = requireQueryAgent(req, res);
 *      if (agent === null) return;
 */

import type { Request, Response } from 'express';
import { validateAgentName } from '../config.js';

/**
 * Type-safe extraction of `?agent=` from query params.
 *
 * Returns the value as a string if it is a non-empty string, `undefined` otherwise.
 * Does NOT validate against the fleet config — any string value is returned as-is.
 * This is the safe replacement for `req.query.agent as string | undefined`.
 */
export function extractQueryAgent(req: Request): string | undefined {
  const raw = req.query.agent;
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  return raw;
}

/**
 * Extract and validate the `?agent=` query param against the fleet config.
 *
 * Returns the agent name if present and valid (known fleet agent), or `undefined`
 * if absent or not in the config. Does NOT write any response.
 * Use for routes that should only operate on known fleet agents.
 */
export function getQueryAgent(req: Request): string | undefined {
  const raw = req.query.agent;
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  if (!validateAgentName(raw)) return undefined;
  return raw;
}

/**
 * Extract and validate a required `?agent=` query param against the fleet config.
 *
 * Writes HTTP 400 and returns `null` when the param is missing or not a known
 * fleet agent. Returns the validated agent name string on success.
 *
 * Pattern:
 *   const agent = requireQueryAgent(req, res);
 *   if (agent === null) return;
 */
export function requireQueryAgent(req: Request, res: Response): string | null {
  const raw = req.query.agent;
  if (typeof raw !== 'string' || raw.length === 0) {
    res.status(400).json({ error: 'agent query parameter is required' });
    return null;
  }
  if (!validateAgentName(raw)) {
    res.status(400).json({ error: `Unknown agent: ${raw}` });
    return null;
  }
  return raw;
}
