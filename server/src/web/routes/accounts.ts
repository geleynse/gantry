/**
 * Account pool management API.
 *
 * Routes:
 *   GET  /api/accounts          — list all accounts with status (admin)
 *   POST /api/accounts/:id/assign  — explicitly assign an account to an agent (admin)
 *   POST /api/accounts/:id/release — release an account back to available (admin)
 *
 * All routes require admin auth. Passwords are never returned.
 */

import { Router } from "express";
import type { SessionManager } from "../../proxy/session-manager.js";
import type { AccountPoolStatus } from "../../shared/types.js";

export function createAccountsRouter(sessions: SessionManager, poolFile: string | null): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    if (_req.auth?.role !== "admin") {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    const pool = sessions.getPoolInstance();
    if (!pool || !poolFile) {
      res.json({
        enabled: false,
        poolFile: null,
        accounts: [],
        config: null,
      } as unknown as AccountPoolStatus);
      return;
    }

    const status: AccountPoolStatus = {
      enabled: true,
      poolFile,
      accounts: pool.listAccounts(),
      config: pool.getPoolConfig(),
    };
    res.json(status);
  });

  router.post("/:username/assign", (req, res) => {
    const pool = sessions.getPoolInstance();
    if (!pool) {
      res.status(503).json({ error: "Account pool not configured" });
      return;
    }

    const { username } = req.params;
    const { agentName } = req.body as { agentName?: string };
    if (!agentName || typeof agentName !== "string") {
      res.status(400).json({ error: "agentName is required" });
      return;
    }

    const ok = pool.assignAccountTo(agentName, username);
    if (!ok) {
      res.status(409).json({ error: `Could not assign "${username}" to agent "${agentName}". Account may be disabled or not found.` });
      return;
    }

    res.json({ ok: true, username, agentName });
  });

  router.post("/:username/release", (req, res) => {
    const pool = sessions.getPoolInstance();
    if (!pool) {
      res.status(503).json({ error: "Account pool not configured" });
      return;
    }

    const { username } = req.params;

    // Find which agent has this account assigned
    const accounts = pool.listAccounts();
    const account = accounts.find((a) => a.username === username);
    if (!account) {
      res.status(404).json({ error: `Account "${username}" not found` });
      return;
    }

    if (account.assignedTo) {
      pool.releaseAccount(account.assignedTo);
    }

    res.json({ ok: true, username, previousAgent: account.assignedTo });
  });

  return router;
}

export default createAccountsRouter;
