import { queryOne, queryAll, queryRun } from "./database.js";
import type { AgentShutdownState, AgentShutdownRecord } from "../shared/types.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("agent_shutdown_db");

export function getShutdownState(agentName: string): AgentShutdownState {
  const row = queryOne<{ state: AgentShutdownState }>(
    "SELECT state FROM agent_shutdown_state WHERE agent_name = ?",
    agentName
  );
  return row?.state ?? "none";
}

export function setShutdownState(
  agentName: string,
  state: AgentShutdownState,
  reason?: string
): void {
  const now = new Date().toISOString();
  queryRun(
    `INSERT INTO agent_shutdown_state (agent_name, state, created_at, updated_at, reason)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(agent_name) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at, reason = excluded.reason`,
    agentName, state, now, now, reason ?? null
  );
  log.info(`Set shutdown state`, { agent: agentName, state, reason: reason ?? "none" });
}

export function clearShutdownState(agentName: string): void {
  const changes = queryRun(
    "DELETE FROM agent_shutdown_state WHERE agent_name = ?",
    agentName
  );
  if (changes > 0) {
    log.info(`Cleared shutdown state`, { agent: agentName });
  }
}

export function getAgentsInShutdown(): AgentShutdownRecord[] {
  return queryAll<AgentShutdownRecord>(
    `SELECT id, agent_name, state, created_at, updated_at, reason
     FROM agent_shutdown_state
     WHERE state != 'none'
     ORDER BY updated_at DESC`
  );
}

export function getShutdownRecord(agentName: string): AgentShutdownRecord | null {
  return queryOne<AgentShutdownRecord>(
    `SELECT id, agent_name, state, created_at, updated_at, reason
     FROM agent_shutdown_state
     WHERE agent_name = ? AND state != 'none'`,
    agentName
  );
}

export function getAgentsWaitingForBattle(): string[] {
  const rows = queryAll<{ agent_name: string }>(
    `SELECT agent_name FROM agent_shutdown_state WHERE state = 'shutdown_waiting'`
  );
  return rows.map((row) => row.agent_name);
}
