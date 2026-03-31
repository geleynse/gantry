import { Router } from 'express';
import * as proc from '../../services/process-manager.js';
import { getActionProxyStatus, bindProxySessions, type ProxySessionHandle } from '../../services/action-proxy-health.js';
import { getDb, queryAll, queryRun } from '../../services/database.js';
import { localhostOnlyMiddleware } from '../auth/middleware.js';
import { validateAgentName } from '../config.js';
import { encrypt, getEncryptionSecret } from '../../services/crypto.js';
import * as z from "zod";
import { createLogger } from '../../lib/logger.js';
import { sessionLimiter } from '../middleware/rate-limit.js';

const log = createLogger('action-proxy');

/**
 * Extended session handle that supports kicking individual agent sessions.
 * Used by POST /kick/:agent to disconnect an agent's game client directly.
 */
export interface KickableSessionHandle extends ProxySessionHandle {
  resolveAgentName(username: string): string;
  getClient(agentName: string): { logout(): Promise<unknown>; getCredentials(): unknown } | undefined;
  removeClient(agentName: string): void;
}

// --- Request validation schemas ---
const SessionEntrySchema = z.object({
  agentName: z.string().min(1).max(64),
  credentials: z.object({
    username: z.string().min(1).max(128),
    password: z.string().min(1).max(256),
  }),
});
const SessionsBodySchema = z.array(SessionEntrySchema).min(1).max(50);

const CallTrackerSchema = z.object({
  counts: z.record(z.string(), z.number().int().min(0)),
  lastCallSig: z.string().nullable().optional(),
  calledTools: z.array(z.string()),
});

function validateBody<T>(body: unknown, schema: z.ZodSchema<T>): { valid: true; data: T } | { valid: false; errors: string[] } {
  const result = schema.safeParse(body);
  if (!result.success) {
    return { valid: false, errors: result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`) };
  }
  return { valid: true, data: result.data };
}

// Cache routes accept any well-formed agent name (not just fleet agents)
const AGENT_NAME_RE = /^[a-z0-9-]+$/;
function validateCacheAgent(agent: string): boolean {
  return AGENT_NAME_RE.test(agent);
}

export function createActionProxyRouter(sessions: KickableSessionHandle, toolCount: number): Router {
  bindProxySessions(sessions, toolCount);
  const router = Router();

  // The MCP proxy is always running in-process — no separate process management needed.

  router.get('/', (_req, res) => {
    res.json(getActionProxyStatus());
  });

  // start/stop/restart are no-ops: the proxy is co-located in this process.
  // The merged server (gantry-server) is managed via its own PID file and log.

  router.post('/start', (_req, res) => {
    res.json({ ok: true, message: 'Proxy runs in-process with the web server; no separate start needed.' });
  });

  router.post('/stop', (_req, res) => {
    res.status(400).json({ ok: false, message: 'Proxy runs in-process; to stop it, stop the gantry-server process.' });
  });

  router.post('/restart', (_req, res) => {
    res.status(400).json({ ok: false, message: 'Proxy runs in-process; to restart it, restart the gantry-server process.' });
  });

  router.post('/kick/:agent', async (req, res) => {
    const agent = req.params.agent;
    if (!validateAgentName(agent)) {
      res.status(400).json({ ok: false, message: 'Invalid agent name' });
      return;
    }

    const resolved = sessions.resolveAgentName(agent);
    const client = sessions.getClient(resolved);

    if (!client) {
      res.status(404).json({ ok: false, message: 'No active session', agent: resolved });
      return;
    }

    try {
      if (client.getCredentials()) {
        await client.logout();
      }
    } catch (err) {
      log.error(`Error during kick logout for ${resolved}: ${err}`);
    }

    sessions.removeClient(resolved);
    res.json({ ok: true, status: 'kicked', agent: resolved });
  });

  // Capture recent output from the merged server's log file.
  router.get('/logs', async (_req, res) => {
    const MERGED_SESSION = process.env.SERVER_PROCESS_NAME || 'gantry-server';
    let lines: string[] = [];
    try {
      const raw = await proc.capturePane(MERGED_SESSION, 100);
      lines = raw.split('\n').filter(Boolean);
    } catch {
      // Not running or log file missing — return empty
    }
    res.json({ lines });
  });

  // ── Proxy session persistence ─────────────────────────────────

  // GET /sessions — returns agent names and usernames (no passwords)
  router.get('/sessions', (_req, res) => {
    const rows = queryAll<{ agent: string; username: string }>('SELECT agent, username FROM proxy_sessions');
    const sessions = rows.map((r) => ({
      agentName: r.agent,
      credentials: { username: r.username },
    }));
    res.json(sessions);
  });

  // GET /sessions/credentials — returns full credentials (passwords encrypted) for agent restoration
  // Localhost-only (security boundary)
  router.get('/sessions/credentials', sessionLimiter, localhostOnlyMiddleware, (_req, res) => {
    const rows = queryAll<{ agent: string; username: string; password: string }>(
      'SELECT agent, username, password FROM proxy_sessions'
    );
    const sessions = rows.map((r) => ({
      agentName: r.agent,
      credentials: { username: r.username, password: r.password }, // Already encrypted in DB
    }));
    res.json(sessions);
  });

  router.post('/sessions', sessionLimiter, async (req, res) => {
    const validation = validateBody(req.body, SessionsBodySchema);
    if (!validation.valid) {
      res.status(400).json({ error: 'validation_error', details: validation.errors });
      return;
    }

    const body = validation.data;
    const db = getDb();
    const secret = getEncryptionSecret();
    const upsert = db.prepare(
      'INSERT OR REPLACE INTO proxy_sessions (agent, username, password, updated_at) VALUES (?, ?, ?, datetime(\'now\'))'
    );

    // Atomic clear-and-rewrite in a transaction, encrypting passwords
    const saveAll = db.transaction((entries: typeof body) => {
      db.prepare('DELETE FROM proxy_sessions').run();
      for (const entry of entries) {
        const encryptedPassword = encrypt(entry.credentials.password, secret);
        upsert.run(entry.agentName, entry.credentials.username, encryptedPassword);
      }
    });

    try {
      saveAll(body);
      res.json({ ok: true, count: body.length });
    } catch (err) {
      log.error(`Error saving sessions: ${err}`);
      res.status(500).json({ error: 'storage_error', message: 'Failed to save sessions' });
    }
  });

  // ── Proxy cache persistence ──────────────────────────────────

  // --- Game State ---
  router.get('/game-state', (_req, res) => {
    const rows = queryAll<{ agent: string; state_json: string }>('SELECT agent, state_json FROM proxy_game_state');
    const result: Record<string, unknown> = {};
    for (const row of rows) {
      try { result[row.agent] = JSON.parse(row.state_json); } catch { /* skip */ }
    }
    res.json(result);
  });

  router.put('/game-state/:agent', (req, res) => {
    const agent = req.params.agent;
    if (!validateCacheAgent(agent)) {
      res.status(400).json({ error: 'Invalid agent name' });
      return;
    }
    queryRun(
      "INSERT OR REPLACE INTO proxy_game_state (agent, state_json, updated_at) VALUES (?, ?, datetime('now'))",
      agent, JSON.stringify(req.body)
    );
    res.json({ ok: true });
  });

  // --- Battle State ---
  router.get('/battle-state', (_req, res) => {
    const rows = queryAll<{ agent: string; battle_json: string | null }>('SELECT agent, battle_json FROM proxy_battle_state');
    const result: Record<string, unknown> = {};
    for (const row of rows) {
      try { result[row.agent] = row.battle_json ? JSON.parse(row.battle_json) : null; } catch { result[row.agent] = null; }
    }
    res.json(result);
  });

  router.put('/battle-state/:agent', (req, res) => {
    const agent = req.params.agent;
    if (!validateCacheAgent(agent)) {
      res.status(400).json({ error: 'Invalid agent name' });
      return;
    }
    queryRun(
      "INSERT OR REPLACE INTO proxy_battle_state (agent, battle_json, updated_at) VALUES (?, ?, datetime('now'))",
      agent, req.body === null ? null : JSON.stringify(req.body)
    );
    res.json({ ok: true });
  });

  // --- Call Trackers ---
  router.get('/call-trackers', (_req, res) => {
    const rows = queryAll<{
      agent: string; counts_json: string; last_call_sig: string | null; called_tools_json: string;
    }>('SELECT agent, counts_json, last_call_sig, called_tools_json FROM proxy_call_trackers');
    const result: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        result[row.agent] = {
          counts: JSON.parse(row.counts_json),
          lastCallSig: row.last_call_sig,
          calledTools: JSON.parse(row.called_tools_json),
        };
      } catch { /* skip */ }
    }
    res.json(result);
  });

  router.put('/call-trackers/:agent', async (req, res) => {
    const agent = req.params.agent;
    if (!validateCacheAgent(agent)) {
      res.status(400).json({ error: 'Invalid agent name' });
      return;
    }

    const validation = validateBody(req.body, CallTrackerSchema);
    if (!validation.valid) {
      res.status(400).json({ error: 'validation_error', details: validation.errors });
      return;
    }

    const body = validation.data;

    try {
      queryRun(
        "INSERT OR REPLACE INTO proxy_call_trackers (agent, counts_json, last_call_sig, called_tools_json, updated_at) VALUES (?, ?, ?, ?, datetime('now'))",
        agent, JSON.stringify(body.counts), body.lastCallSig ?? null, JSON.stringify(body.calledTools)
      );
      res.json({ ok: true });
    } catch (err) {
      log.error(`Error updating call-tracker for ${agent}: ${err}`);
      res.status(500).json({ error: 'storage_error', message: 'Failed to update call tracker' });
    }
  });

  // --- Bulk delete for agent ---
  router.delete('/caches/:agent', (req, res) => {
    const agent = req.params.agent;
    if (!validateCacheAgent(agent)) {
      res.status(400).json({ error: 'Invalid agent name' });
      return;
    }
    const db = getDb();
    db.transaction(() => {
      db.prepare('DELETE FROM proxy_game_state WHERE agent = ?').run(agent);
      db.prepare('DELETE FROM proxy_battle_state WHERE agent = ?').run(agent);
      db.prepare('DELETE FROM proxy_call_trackers WHERE agent = ?').run(agent);
    })();
    res.json({ ok: true });
  });

  return router;
}

export default createActionProxyRouter;
