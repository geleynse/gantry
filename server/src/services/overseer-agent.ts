/**
 * overseer-agent.ts — Slim OverseerAgent: decision logger and status tracker.
 *
 * The overseer is now a 6th Claude Code agent connecting via MCP.
 * This module only handles decision persistence and status queries.
 * No tick loop, no LLM client, no prompt building.
 */

import { createLogger } from "../lib/logger.js";
import { queryInsert, queryAll, queryOne, getDb } from "./database.js";
import type { OverseerDecision } from "../shared/types/overseer.js";

const log = createLogger("overseer-agent");

// ---------------------------------------------------------------------------
// OverseerAgent
// ---------------------------------------------------------------------------

export class OverseerAgent {
  constructor(private agentName: string = "overseer") {}

  /**
   * Log a decision to the overseer_decisions table.
   * Called by MCP tool handlers after each overseer turn.
   */
  logDecision(data: {
    triggered_by: string;
    snapshot_json: string;
    actions_json: string;
    results_json: string;
    model: string;
  }): OverseerDecision {
    const { triggered_by, snapshot_json, actions_json, results_json, model } = data;

    // Get next tick number
    const lastTick = queryOne<{ max_tick: number | null }>(
      `SELECT MAX(tick_number) as max_tick FROM overseer_decisions`,
    );
    const tickNumber = (lastTick?.max_tick ?? 0) + 1;

    const id = queryInsert(
      `INSERT INTO overseer_decisions
        (tick_number, triggered_by, snapshot_json, prompt_text, response_json, actions_json,
         results_json, model, input_tokens, output_tokens, cost_estimate, status, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      tickNumber,
      triggered_by,
      snapshot_json,
      null, // prompt_text — not used in MCP mode
      results_json,
      actions_json,
      results_json,
      model,
      null, // input_tokens — tracked by Claude Code, not us
      null, // output_tokens
      null, // cost_estimate
      "success",
      null, // duration_ms
    );

    log.info("Decision logged", { id, tickNumber, triggered_by });

    const decision = queryOne<OverseerDecision>(
      `SELECT * FROM overseer_decisions WHERE id = ?`,
      id,
    );

    // Fallback if query somehow fails
    if (!decision) {
      return {
        id,
        tick_number: tickNumber,
        triggered_by,
        snapshot_json,
        prompt_text: null,
        response_json: results_json,
        actions_json,
        results_json,
        model,
        input_tokens: null,
        output_tokens: null,
        cost_estimate: null,
        status: "success",
        duration_ms: null,
        created_at: new Date().toISOString(),
      };
    }

    return decision;
  }

  /**
   * Get recent decisions, newest first.
   */
  getDecisionHistory(limit = 20): OverseerDecision[] {
    return queryAll<OverseerDecision>(
      `SELECT * FROM overseer_decisions ORDER BY tick_number DESC LIMIT ?`,
      limit,
    );
  }

  /**
   * Get a single decision by ID.
   */
  getDecisionById(id: number): OverseerDecision | null {
    return queryOne<OverseerDecision>(
      `SELECT * FROM overseer_decisions WHERE id = ?`,
      id,
    );
  }

  /**
   * Backfill cost data on the most recent decision row.
   * Called after each overseer turn completes and the JSONL file is ingested,
   * since the agent cannot know its own cost at call time.
   */
  updateLatestDecisionCost(data: {
    costUsd: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
  }): void {
    const { costUsd, inputTokens, outputTokens } = data;
    const db = getDb();
    const result = db.prepare(
      `UPDATE overseer_decisions
          SET cost_estimate = ?, input_tokens = ?, output_tokens = ?
        WHERE id = (SELECT MAX(id) FROM overseer_decisions)`,
    ).run(costUsd, inputTokens, outputTokens);
    if (result.changes > 0) {
      log.info("Backfilled cost on latest overseer decision", { costUsd, inputTokens, outputTokens });
    }
  }

  /**
   * Sum of cost_estimate for today's decisions.
   */
  getCostToday(): number {
    const row = queryOne<{ total: number }>(
      `SELECT COALESCE(SUM(cost_estimate), 0) as total FROM overseer_decisions WHERE date(created_at) = date('now')`,
    );
    return row?.total ?? 0;
  }

  /**
   * Count of decisions made today.
   */
  getDecisionsToday(): number {
    const row = queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM overseer_decisions WHERE date(created_at) = date('now')`,
    );
    return row?.count ?? 0;
  }
}
