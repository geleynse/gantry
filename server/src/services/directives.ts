/**
 * directives.ts
 * CRUD service for persistent per-agent directives.
 * Directives are standing orders injected into every agent turn (with frequency limiting).
 */

import { queryAll, queryInsert, queryRun } from './database.js';

export type DirectivePriority = 'low' | 'normal' | 'high' | 'critical';

export interface DirectiveRow {
  id: number;
  agent_name: string;
  directive: string;
  priority: DirectivePriority;
  active: number;
  created_at: string;
  expires_at: string | null;
  created_by: string;
}

/**
 * Get all active, non-expired directives for an agent.
 * Ordered by priority (critical first) then creation time.
 */
export function getActiveDirectives(agentName: string): DirectiveRow[] {
  return queryAll<DirectiveRow>(
    `SELECT * FROM agent_directives
     WHERE agent_name = ? AND active = 1
       AND (expires_at IS NULL OR expires_at > datetime('now'))
     ORDER BY
       CASE priority
         WHEN 'critical' THEN 0
         WHEN 'high' THEN 1
         WHEN 'normal' THEN 2
         WHEN 'low' THEN 3
         ELSE 2
       END,
       created_at ASC`,
    agentName,
  );
}

/**
 * Add a new directive for an agent.
 * Returns the new directive ID.
 */
export function addDirective(
  agentName: string,
  text: string,
  priority: DirectivePriority = 'normal',
  expiresAt?: string | null,
): number {
  return queryInsert(
    `INSERT INTO agent_directives (agent_name, directive, priority, expires_at)
     VALUES (?, ?, ?, ?)`,
    agentName, text, priority, expiresAt ?? null,
  );
}

/**
 * Deactivate a directive by ID.
 * Returns true if the directive was found and deactivated.
 */
export function removeDirective(id: number): boolean {
  return queryRun(`UPDATE agent_directives SET active = 0 WHERE id = ? AND active = 1`, id) > 0;
}

/**
 * List directives for an agent (all, including inactive) for UI display.
 * If agentName is omitted, returns all directives across all agents.
 */
export function listDirectives(agentName?: string): DirectiveRow[] {
  if (agentName) {
    return queryAll<DirectiveRow>(
      `SELECT * FROM agent_directives WHERE agent_name = ? ORDER BY created_at DESC`,
      agentName,
    );
  }
  return queryAll<DirectiveRow>(
    `SELECT * FROM agent_directives ORDER BY agent_name, created_at DESC`,
  );
}
