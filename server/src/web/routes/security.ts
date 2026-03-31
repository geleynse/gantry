/**
 * Security management API.
 *
 * Routes:
 *   POST /api/security/rotate-secret — rotate the encryption secret (admin)
 */

import { Router } from "express";
import type { SessionManager } from "../../proxy/session-manager.js";
import { rotateSecret } from "../../services/secret-rotation.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("security");

export function createSecurityRouter(sessions: SessionManager): Router {
  const router = Router();

  router.post("/rotate-secret", (_req, res) => {
    try {
      const result = rotateSecret(sessions);
      res.json({
        ok: true,
        sessionsRotated: result.sessionsRotated,
        accountsRotated: result.accountsRotated,
        durationMs: result.durationMs,
      });
    } catch (err) {
      log.error(`Secret rotation failed: ${err}`);
      res.status(500).json({
        ok: false,
        error: "rotation_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
