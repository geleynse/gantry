/**
 * JSON error-handling middleware.
 *
 * Must be registered LAST in the Express middleware chain so that errors thrown
 * (or passed via next(err)) by any route handler reach it.
 *
 * What the client sees:
 *   - In production (NODE_ENV=production): generic "Internal server error" — no
 *     internal details leak.
 *   - In development: err.message is included for easier debugging, but err.stack
 *     and file paths are never sent to the client.
 *
 * The full error (including stack) is always logged server-side.
 */

import type { ErrorRequestHandler } from 'express';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('error-handler');

export const jsonErrorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const status = typeof err.status === 'number' ? err.status
    : typeof err.statusCode === 'number' ? err.statusCode
    : 500;

  log.error('Unhandled request error', {
    method: req.method,
    path: req.path,
    status: String(status),
    message: err?.message ?? String(err),
    stack: err?.stack,
  });

  const safe = process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : (err?.message ?? 'Internal server error');

  res.status(status).json({ error: safe });
};
