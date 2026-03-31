/**
 * Outbound content review service.
 *
 * Channel-agnostic review queue for agent-generated content (forum posts, chat, discord).
 * Agents are never told their posts are queued — they receive a fake success response.
 * Admins approve/reject via the /api/outbound/* REST endpoints.
 */
import { queryInsert, queryOne, queryAll, queryRun } from './database.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('outbound-review');

export type OutboundChannel = "forum" | "discord" | "chat";
export type ReviewPolicy = "require_approval" | "auto_approve_with_log" | "disabled";
export type ReviewStatus = "pending" | "approved" | "rejected" | "auto_approved";

export interface OutboundMessage {
  id: number;
  timestamp: string;
  agentName: string;
  channel: OutboundChannel;
  content: string;
  metadata: Record<string, unknown>;
  status: ReviewStatus;
  reviewedBy?: string;
  reviewedAt?: string;
}

interface OutboundRow {
  id: number;
  timestamp: string;
  agent_name: string;
  channel: string;
  content: string;
  metadata: string | null;
  status: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
}

function rowToMessage(row: OutboundRow): OutboundMessage {
  return {
    id: row.id,
    timestamp: row.timestamp,
    agentName: row.agent_name,
    channel: row.channel as OutboundChannel,
    content: row.content,
    metadata: row.metadata ? (() => { try { return JSON.parse(row.metadata); } catch { return {}; } })() : {},
    status: row.status as ReviewStatus,
    reviewedBy: row.reviewed_by ?? undefined,
    reviewedAt: row.reviewed_at ?? undefined,
  };
}

/**
 * Queue a new outbound message for review.
 * Returns the newly created message ID.
 */
export function queueMessage(msg: {
  agentName: string;
  channel: OutboundChannel;
  content: string;
  metadata: Record<string, unknown>;
  status?: "pending" | "auto_approved";
}): number {
  const status = msg.status ?? "pending";
  const metadataStr = JSON.stringify(msg.metadata);
  try {
    return queryInsert(
      `INSERT INTO outbound_review (agent_name, channel, content, metadata, status)
       VALUES (?, ?, ?, ?, ?)`,
      msg.agentName, msg.channel, msg.content, metadataStr, status,
    );
  } catch (err) {
    log.error('Failed to queue outbound message', { error: err, agentName: msg.agentName, channel: msg.channel });
    return -1;
  }
}

/**
 * Approve a pending message. Returns the updated message or null if not found.
 */
export function approveMessage(id: number, reviewer: string): OutboundMessage | null {
  const changes = queryRun(
    `UPDATE outbound_review
     SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now')
     WHERE id = ? AND status = 'pending'`,
    reviewer, id,
  );
  if (changes === 0) return null;
  const row = queryOne<OutboundRow>(`SELECT * FROM outbound_review WHERE id = ?`, id);
  return row ? rowToMessage(row) : null;
}

/**
 * Reject a pending message.
 */
export function rejectMessage(id: number, reviewer: string, reason?: string): boolean {
  const reviewedBy = reason ? `${reviewer}: ${reason}` : reviewer;
  const changes = queryRun(
    `UPDATE outbound_review
     SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now')
     WHERE id = ? AND status = 'pending'`,
    reviewedBy, id,
  );
  return changes > 0;
}

/**
 * Get pending messages, optionally filtered by channel.
 */
export function getPending(channel?: OutboundChannel): OutboundMessage[] {
  const [extra, params] = channel ? [` AND channel = ?`, [channel]] : [``, []];
  const rows = queryAll<OutboundRow>(`SELECT * FROM outbound_review WHERE status = 'pending'${extra} ORDER BY timestamp ASC`, ...params);
  return rows.map(rowToMessage);
}

/**
 * Get pending count, optionally filtered by channel.
 */
export function getPendingCount(channel?: OutboundChannel): number {
  const [extra, params] = channel ? [` AND channel = ?`, [channel]] : [``, []];
  const row = queryOne<{ count: number }>(`SELECT COUNT(*) as count FROM outbound_review WHERE status = 'pending'${extra}`, ...params);
  return row?.count ?? 0;
}

/**
 * Get reviewed message history.
 */
export function getHistory(opts: { agent?: string; channel?: OutboundChannel; limit?: number }): OutboundMessage[] {
  const { agent, channel, limit = 50 } = opts;
  const conditions: string[] = ["status != 'pending'"];
  const params: (string | number)[] = [];

  if (agent) {
    conditions.push('agent_name = ?');
    params.push(agent);
  }
  if (channel) {
    conditions.push('channel = ?');
    params.push(channel);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const cappedLimit = Math.min(limit, 200);
  params.push(cappedLimit);

  const rows = queryAll<OutboundRow>(
    `SELECT * FROM outbound_review ${where} ORDER BY timestamp DESC LIMIT ?`,
    ...params,
  );
  return rows.map(rowToMessage);
}
