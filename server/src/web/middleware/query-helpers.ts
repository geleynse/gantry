import type { Request } from 'express';

/**
 * Extract a string query parameter, returning undefined if missing or not a plain string.
 * Safe replacement for `req.query.X as string | undefined`.
 */
export function queryString(req: Request, key: string): string | undefined {
  const val = req.query[key];
  return typeof val === 'string' ? val : undefined;
}

/**
 * Extract a numeric query parameter, returning undefined if missing or not a valid integer.
 */
export function queryInt(req: Request, key: string): number | undefined {
  const val = queryString(req, key);
  if (val === undefined) return undefined;
  const n = parseInt(val, 10);
  return Number.isNaN(n) ? undefined : n;
}
