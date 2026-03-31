/**
 * Tests for forum/chat interception policy behavior.
 *
 * The interception logic lives in gantry-v2.ts (spacemolt_social switch block).
 * These tests verify the policy engine by testing the service-level outcomes
 * that gantry-v2.ts produces for each ReviewPolicy value.
 *
 * Policy: require_approval  → queueMessage() called, agent sees fake success
 * Policy: auto_approve_with_log → queueMessage() with status="auto_approved", falls through
 * Policy: disabled           → no queueMessage(), agent sees error
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createDatabase, closeDb } from "../services/database.js";
import {
  queueMessage,
  getPending,
  getPendingCount,
  getHistory,
  type ReviewPolicy,
} from "../services/outbound-review.js";

beforeEach(() => {
  createDatabase(":memory:");
});

afterEach(() => {
  closeDb();
});

// Helper: simulate what gantry-v2.ts does for forum_create_thread
function simulateForumPost(
  agentName: string,
  content: string,
  policy: ReviewPolicy,
  args: Record<string, unknown> = {},
): { intercepted: boolean; result?: unknown } {
  if (policy === "disabled") {
    return { intercepted: true, result: { error: "Forum posting is disabled for this fleet." } };
  }
  const metadata = { v1_action: "forum_create_thread", v1_params: { content, ...args } };
  if (policy === "require_approval") {
    queueMessage({ agentName, channel: "forum", content, metadata });
    return { intercepted: true, result: { status: "ok", message: "Post submitted successfully." } };
  }
  // auto_approve_with_log: queue and fall through to game server
  queueMessage({ agentName, channel: "forum", content, metadata, status: "auto_approved" });
  return { intercepted: false }; // falls through to passthrough
}

// Helper: simulate what gantry-v2.ts does for chat
function simulateChatPost(
  agentName: string,
  content: string,
  policy: ReviewPolicy,
): { intercepted: boolean; result?: unknown } {
  if (policy === "disabled") {
    return { intercepted: true, result: { error: "Chat is disabled for this fleet." } };
  }
  const metadata = { v1_action: "chat", v1_params: { content } };
  if (policy === "require_approval") {
    queueMessage({ agentName, channel: "chat", content, metadata });
    return { intercepted: true, result: { status: "ok", message: "Chat message submitted." } };
  }
  queueMessage({ agentName, channel: "chat", content, metadata, status: "auto_approved" });
  return { intercepted: false };
}

// ── require_approval ─────────────────────────────────────────────────────────

describe("forum_post — require_approval policy", () => {
  it("intercepts forum post, stores as pending, returns fake success", () => {
    const { intercepted, result } = simulateForumPost(
      "rust-vane",
      "Best trading routes this week!",
      "require_approval",
      { title: "Trade Routes", category: "trading" },
    );

    expect(intercepted).toBe(true);
    expect((result as Record<string, string>).status).toBe("ok");

    const pending = getPending("forum");
    expect(pending).toHaveLength(1);
    expect(pending[0].agentName).toBe("rust-vane");
    expect(pending[0].content).toBe("Best trading routes this week!");
    expect(pending[0].status).toBe("pending");
    expect(pending[0].metadata.v1_params).toMatchObject({ title: "Trade Routes", category: "trading" });
  });

  it("agent receives success response but post is not yet sent", () => {
    const { result } = simulateForumPost("cinder-wake", "Hello world!", "require_approval");
    // Agent sees success (they don't know it's queued for review)
    expect((result as Record<string, string>).status).toBe("ok");
    // But it's in the pending queue, not sent to game
    expect(getPendingCount("forum")).toBe(1);
    expect(getHistory({})).toHaveLength(0); // nothing approved yet
  });
});

// ── auto_approve_with_log ─────────────────────────────────────────────────────

describe("forum_post — auto_approve_with_log policy", () => {
  it("logs as auto_approved and falls through to game server", () => {
    const { intercepted } = simulateForumPost("lumen-shoal", "Exploration report", "auto_approve_with_log");

    // Falls through → passthrough handles game server call
    expect(intercepted).toBe(false);

    // Logged for audit trail
    const history = getHistory({});
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("auto_approved");
    expect(history[0].channel).toBe("forum");

    // Not in pending queue (already auto-approved)
    expect(getPendingCount("forum")).toBe(0);
  });
});

// ── disabled ─────────────────────────────────────────────────────────────────

describe("forum_post — disabled policy", () => {
  it("blocks the action and returns error, nothing stored", () => {
    const { intercepted, result } = simulateForumPost("sable-thorn", "Blocked post", "disabled");

    expect(intercepted).toBe(true);
    expect((result as Record<string, string>).error).toContain("disabled");

    // Nothing stored
    expect(getPendingCount()).toBe(0);
    expect(getHistory({})).toHaveLength(0);
  });
});

// ── chat interception ─────────────────────────────────────────────────────────

describe("chat interception", () => {
  it("require_approval: queues chat message, agent sees success", () => {
    const { intercepted, result } = simulateChatPost("drifter-gale", "Anyone at Nexus?", "require_approval");

    expect(intercepted).toBe(true);
    expect((result as Record<string, string>).status).toBe("ok");

    const pending = getPending("chat");
    expect(pending).toHaveLength(1);
    expect(pending[0].channel).toBe("chat");
    expect(pending[0].content).toBe("Anyone at Nexus?");
  });

  it("disabled policy: blocks chat, no storage", () => {
    const { intercepted, result } = simulateChatPost("cinder-wake", "hi", "disabled");

    expect(intercepted).toBe(true);
    expect((result as Record<string, string>).error).toBeTruthy();
    expect(getPendingCount("chat")).toBe(0);
  });
});
