import { getDb, queryOne, queryRun } from "./database.js";

export function createSignal(agent: string, type: string, message = ""): void {
  queryRun(
    `INSERT INTO agent_signals (agent, signal_type, message, created_at, consumed_at)
     VALUES (?, ?, ?, datetime('now'), NULL)
     ON CONFLICT(agent, signal_type) DO UPDATE SET
       message = excluded.message,
       created_at = excluded.created_at,
       consumed_at = NULL`,
    agent, type, message
  );
}

export function consumeSignal(agent: string, type: string): string | null {
  const db = getDb();
  return db.transaction(() => {
    const row = queryOne<{ id: number; message: string }>(
      `SELECT id, message FROM agent_signals WHERE agent = ? AND signal_type = ? AND consumed_at IS NULL`,
      agent, type
    );

    if (!row) return null;

    queryRun(
      `UPDATE agent_signals SET consumed_at = datetime('now') WHERE id = ?`,
      row.id
    );

    return row.message;
  })();
}

export function hasSignal(agent: string, type: string): boolean {
  const row = queryOne<number>(
    `SELECT 1 FROM agent_signals WHERE agent = ? AND signal_type = ? AND consumed_at IS NULL LIMIT 1`,
    agent, type
  );
  return !!row;
}

export function clearSignal(agent: string, type: string): void {
  queryRun(
    `DELETE FROM agent_signals WHERE agent = ? AND signal_type = ?`,
    agent, type
  );
}
