import { queryAll, queryOne, queryInsert, queryRun } from "./database.js";

export interface AgentAlert {
  id: number;
  agent: string;
  severity: string;
  category: string | null;
  message: string;
  acknowledged: number;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  created_at: string;
}

export function createAlert(agent: string, severity: string, category: string | null, message: string): number {
  return queryInsert(
    `INSERT INTO agent_alerts (agent, severity, category, message) VALUES (?, ?, ?, ?)`,
    agent, severity, category ?? null, message
  );
}

export function getPendingAlerts(agent?: string): AgentAlert[] {
  return queryAll<AgentAlert>(
    `SELECT * FROM agent_alerts WHERE acknowledged = 0 AND (? IS NULL OR agent = ?) ORDER BY created_at DESC`,
    agent ?? null, agent ?? null
  );
}

export function getAlertCount(): number {
  const row = queryOne<{ count: number }>(
    `SELECT COUNT(*) as count FROM agent_alerts WHERE acknowledged = 0`
  );
  return row?.count ?? 0;
}

export function acknowledgeAlert(id: number, by?: string): boolean {
  const changes = queryRun(
    `UPDATE agent_alerts SET acknowledged = 1, acknowledged_by = ?, acknowledged_at = datetime('now') WHERE id = ? AND acknowledged = 0`,
    by ?? null, id
  );
  return changes > 0;
}

export function acknowledgeAll(agent?: string): number {
  return queryRun(
    `UPDATE agent_alerts SET acknowledged = 1, acknowledged_at = datetime('now') WHERE acknowledged = 0 AND (? IS NULL OR agent = ?)`,
    agent ?? null, agent ?? null
  );
}
