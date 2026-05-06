import type { Request, Response } from 'express';
import { validateAgentName } from '../config.js';

export function extractQueryAgent(req: Request): string | undefined {
  const raw = req.query.agent;
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  return raw;
}

export function getQueryAgent(req: Request): string | undefined {
  const raw = extractQueryAgent(req);
  if (raw === undefined || !validateAgentName(raw)) return undefined;
  return raw;
}

export function requireQueryAgent(req: Request, res: Response): string | null {
  const raw = extractQueryAgent(req);
  if (raw === undefined) {
    res.status(400).json({ error: 'agent query parameter is required' });
    return null;
  }
  if (!validateAgentName(raw)) {
    res.status(400).json({ error: `Unknown agent: ${raw}` });
    return null;
  }
  return raw;
}
