import { getDb, queryOne, queryRun } from "./database.js";

interface HandoffInput {
  agent: string;
  location_system?: string;
  location_poi?: string;
  credits?: number;
  fuel?: number;
  cargo_summary?: string;
  last_actions?: string;
  active_goals?: string;
}

interface Handoff extends HandoffInput {
  id: number;
  created_at: string;
  consumed_at: string | null;
}

export function createHandoff(input: HandoffInput): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO session_handoffs (agent, location_system, location_poi, credits, fuel, cargo_summary, last_actions, active_goals)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.agent,
    input.location_system ?? null,
    input.location_poi ?? null,
    input.credits ?? null,
    input.fuel ?? null,
    input.cargo_summary ?? null,
    input.last_actions ?? null,
    input.active_goals ?? null,
  );
  return Number(result.lastInsertRowid);
}

export function getUnconsumedHandoff(agent: string): Handoff | null {
  return queryOne<Handoff>(`
    SELECT * FROM session_handoffs
    WHERE agent = ? AND consumed_at IS NULL
    ORDER BY id DESC
    LIMIT 1
  `, agent);
}

export function consumeHandoff(id: number): boolean {
  return queryRun(`UPDATE session_handoffs SET consumed_at = datetime('now') WHERE id = ?`, id) > 0;
}
