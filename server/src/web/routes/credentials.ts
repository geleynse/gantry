/**
 * Credential management routes.
 * Handles agent game credentials and audit logging.
 *
 * Credentials are stored encrypted at rest (AES-256-GCM) via credentials-crypto.ts.
 * The active file is fleet-credentials.enc.json (encrypted) or fleet-credentials.json
 * (legacy plaintext, auto-migrated on first startup).
 */
import { Router } from "express";
import { readFileSync, existsSync } from "node:fs";
import * as env from "../../config/env.js";
import { AGENTS } from "../../config/fleet.js";
import { atomicWriteFileSync } from "../../lib/atomic-write.js";
import { logEnrollmentEvent, getAuditLog } from "../../services/enrollment-audit.js";
import { createLogger } from "../../lib/logger.js";
import {
  getCredentialsFilePath,
  encryptPassword,
  decryptCredentials,
  type RawCredentialsFile,
} from "../../services/credentials-crypto.js";
import { queryString, queryInt } from "../middleware/query-helpers.js";

const log = createLogger("credentials-routes");

/** Basic agent name format check — alphanumeric + hyphens, 1-64 chars */
function isValidAgentNameFormat(name: string): boolean {
  return /^[a-z][a-z0-9-]{0,63}$/.test(name);
}

function getCredentialsPath(): string {
  return getCredentialsFilePath(env.FLEET_DIR);
}

/**
 * Read credentials from disk and decrypt passwords.
 * Returns in-memory plaintext form — never write this back to disk directly.
 */
function readCredentials(): RawCredentialsFile {
  const path = getCredentialsPath();
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, "utf-8")) as RawCredentialsFile;
  return decryptCredentials(raw);
}

/**
 * Serialize credentials for disk — encrypt all passwords before writing.
 */
function writeCredentials(creds: RawCredentialsFile): void {
  const encrypted: RawCredentialsFile = {};
  for (const [agent, entry] of Object.entries(creds)) {
    encrypted[agent] = {
      username: entry.username,
      password: encryptPassword(entry.password),
    };
  }
  atomicWriteFileSync(getCredentialsPath(), JSON.stringify(encrypted, null, 2));
}

const router = Router();

/**
 * GET /api/credentials
 * Returns all agents and their credential status.
 * Passwords are NEVER included.
 */
router.get("/", (req, res) => {
  if (req.auth?.role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  let credentials: Record<string, any> = {};
  try {
    credentials = readCredentials();
  } catch (err) {
    log.error(`Failed to parse credentials: ${err}`);
  }

  // Exclude overseer agent — it connects via /mcp/overseer, not the game server,
  // so it has no game credentials and should not appear as "missing".
  const gameAgentNames = AGENTS
    .filter((a) => a.mcpVersion !== 'overseer')
    .map((a) => a.name);
  const status = gameAgentNames.map(name => ({
    name,
    hasCredentials: !!credentials[name],
    username: credentials[name]?.username || null,
  }));

  res.json(status);
});

/**
 * POST /api/credentials/:agent/update
 * Updates or sets credentials for an agent.
 */
router.post("/:agent/update", (req, res) => {
  const { agent } = req.params;
  if (!isValidAgentNameFormat(agent)) {
    res.status(404).json({ error: `Unknown agent: "${agent}"` });
    return;
  }
  const { username, password } = req.body;

  if (!username || !password) {
    res.status(400).json({ error: "username and password are required" });
    return;
  }

  const credentials = readCredentials();
  credentials[agent] = { username, password };
  writeCredentials(credentials);

  logEnrollmentEvent(agent, "credential_updated", req.auth?.identity || "admin");

  res.json({ success: true });
});

/**
 * DELETE /api/credentials/:agent
 * Removes credentials for an agent.
 */
router.delete("/:agent", (req, res) => {
  const { agent } = req.params;
  if (!isValidAgentNameFormat(agent)) {
    res.status(404).json({ error: `Unknown agent: "${agent}"` });
    return;
  }

  if (!existsSync(getCredentialsPath())) {
    res.status(404).json({ error: "Credentials file not found" });
    return;
  }

  const credentials = readCredentials();
  if (!credentials[agent]) {
    res.status(404).json({ error: `No credentials found for agent "${agent}"` });
    return;
  }

  delete credentials[agent];
  writeCredentials(credentials);

  logEnrollmentEvent(agent, "credential_removed", req.auth?.identity || "admin");

  res.json({ success: true });
});

/**
 * GET /api/credentials/audit
 * Returns recent enrollment and credential audit events.
 */
router.get("/audit", (req, res) => {
  if (req.auth?.role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  const agentName = queryString(req, 'agent');
  const limit = queryInt(req, 'limit') ?? 50;
  
  const events = getAuditLog(agentName, limit);
  res.json(events);
});

export default router;

export function createCredentialsRouter() {
  return router;
}
