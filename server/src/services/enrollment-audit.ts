/**
 * Enrollment audit service.
 * Records all agent enrollment and credential lifecycle events.
 */
import { queryInsert, queryAll } from "./database.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("enrollment-audit");

export type EnrollmentAction = 
  | "enrolled" 
  | "credential_updated" 
  | "credential_removed" 
  | "prompt_deployed";

export interface EnrollmentAuditEvent {
  id: number;
  timestamp: string;
  agent_name: string;
  action: EnrollmentAction;
  actor: string | null;
  details: string | null;
}

/**
 * Log an enrollment event to the database.
 */
export function logEnrollmentEvent(
  agentName: string,
  action: EnrollmentAction,
  actor: string | null = null,
  details: Record<string, any> | null = null
): void {
  try {
    const detailsJson = details ? JSON.stringify(details) : null;
    queryInsert(
      "INSERT INTO enrollment_audit (agent_name, action, actor, details) VALUES (?, ?, ?, ?)",
      agentName,
      action,
      actor,
      detailsJson
    );
    log.info(`[audit] ${agentName}: ${action} (actor: ${actor ?? "unknown"})`);
  } catch (err) {
    log.error(`Failed to log enrollment event: ${err}`);
  }
}

/**
 * Get audit log for a specific agent or all agents.
 */
export function getAuditLog(agentName?: string, limit: number = 50): EnrollmentAuditEvent[] {
  try {
    const sql = agentName
      ? "SELECT * FROM enrollment_audit WHERE agent_name = ? ORDER BY timestamp DESC LIMIT ?"
      : "SELECT * FROM enrollment_audit ORDER BY timestamp DESC LIMIT ?";
    const params = agentName ? [agentName, limit] : [limit];
    return queryAll<EnrollmentAuditEvent>(sql, ...params);
  } catch (err) {
    log.error(`Failed to retrieve audit log: ${err}`);
    return [];
  }
}
