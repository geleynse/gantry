import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createDatabase, closeDb } from "./database.js";
import {
  queueMessage,
  approveMessage,
  rejectMessage,
  getPending,
  getPendingCount,
  getHistory,
} from "./outbound-review.js";

beforeEach(() => {
  createDatabase(":memory:");
});

afterEach(() => {
  closeDb();
});

// ── queueMessage ────────────────────────────────────────────────────────────

describe("queueMessage", () => {
  it("stores a pending message and returns its ID", () => {
    const id = queueMessage({
      agentName: "rust-vane",
      channel: "forum",
      content: "Hello galaxy! Great trading routes today.",
      metadata: { v1_action: "forum_create_thread", v1_params: { title: "Routes", category: "trading" } },
    });
    expect(id).toBeGreaterThan(0);

    const pending = getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(id);
    expect(pending[0].agentName).toBe("rust-vane");
    expect(pending[0].channel).toBe("forum");
    expect(pending[0].content).toBe("Hello galaxy! Great trading routes today.");
    expect(pending[0].status).toBe("pending");
    expect(pending[0].metadata.v1_action).toBe("forum_create_thread");
  });

  it("stores auto_approved messages with correct status", () => {
    queueMessage({
      agentName: "cinder-wake",
      channel: "chat",
      content: "Anyone at Nexus?",
      metadata: { v1_action: "chat" },
      status: "auto_approved",
    });

    const pending = getPending();
    expect(pending).toHaveLength(0); // auto_approved is not "pending"

    const history = getHistory({});
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("auto_approved");
  });
});

// ── approveMessage ──────────────────────────────────────────────────────────

describe("approveMessage", () => {
  it("approves a pending message and returns updated record", () => {
    const id = queueMessage({
      agentName: "drifter-gale",
      channel: "forum",
      content: "Discovered a wormhole!",
      metadata: {},
    });

    const msg = approveMessage(id, "alan");
    expect(msg).not.toBeNull();
    expect(msg!.status).toBe("approved");
    expect(msg!.reviewedBy).toBe("alan");
    expect(msg!.reviewedAt).toBeTruthy();
  });

  it("returns null when approving already-reviewed message", () => {
    const id = queueMessage({
      agentName: "rust-vane",
      channel: "forum",
      content: "Trade update",
      metadata: {},
    });
    approveMessage(id, "alan");
    const second = approveMessage(id, "alan");
    expect(second).toBeNull();
  });
});

// ── rejectMessage ───────────────────────────────────────────────────────────

describe("rejectMessage", () => {
  it("rejects a pending message and updates status", () => {
    const id = queueMessage({
      agentName: "sable-thorn",
      channel: "forum",
      content: "This post is off-topic spam",
      metadata: {},
    });

    const ok = rejectMessage(id, "alan", "off-topic");
    expect(ok).toBe(true);

    const pending = getPending();
    expect(pending).toHaveLength(0);

    const history = getHistory({});
    expect(history[0].status).toBe("rejected");
    expect(history[0].reviewedBy).toContain("alan");
    expect(history[0].reviewedBy).toContain("off-topic");
  });

  it("returns false when rejecting non-existent message", () => {
    const ok = rejectMessage(999, "alan");
    expect(ok).toBe(false);
  });
});

// ── approve-all batch via service ────────────────────────────────────────────

describe("batch approve via service", () => {
  it("approves multiple pending messages", () => {
    queueMessage({ agentName: "a1", channel: "forum", content: "Post 1", metadata: {} });
    queueMessage({ agentName: "a2", channel: "forum", content: "Post 2", metadata: {} });
    queueMessage({ agentName: "a3", channel: "chat", content: "Chat 1", metadata: {} });

    const forumPending = getPending("forum");
    expect(forumPending).toHaveLength(2);

    for (const msg of forumPending) {
      approveMessage(msg.id, "admin");
    }

    expect(getPending("forum")).toHaveLength(0);
    expect(getPending("chat")).toHaveLength(1); // chat not touched
    expect(getPendingCount("forum")).toBe(0);
  });
});

// ── getHistory ───────────────────────────────────────────────────────────────

describe("getHistory", () => {
  it("returns reviewed messages filtered by agent and channel", () => {
    const id1 = queueMessage({ agentName: "rust-vane", channel: "forum", content: "Forum", metadata: {} });
    const id2 = queueMessage({ agentName: "rust-vane", channel: "chat", content: "Chat", metadata: {} });
    const id3 = queueMessage({ agentName: "drifter-gale", channel: "forum", content: "Other", metadata: {} });
    approveMessage(id1, "admin");
    approveMessage(id2, "admin");
    approveMessage(id3, "admin");

    const rustForum = getHistory({ agent: "rust-vane", channel: "forum" });
    expect(rustForum).toHaveLength(1);
    expect(rustForum[0].content).toBe("Forum");

    const allRust = getHistory({ agent: "rust-vane" });
    expect(allRust).toHaveLength(2);
  });
});

// ── getPendingCount ──────────────────────────────────────────────────────────

describe("getPendingCount", () => {
  it("returns correct counts by channel", () => {
    queueMessage({ agentName: "a", channel: "forum", content: "f1", metadata: {} });
    queueMessage({ agentName: "b", channel: "forum", content: "f2", metadata: {} });
    queueMessage({ agentName: "c", channel: "chat", content: "c1", metadata: {} });

    expect(getPendingCount()).toBe(3);
    expect(getPendingCount("forum")).toBe(2);
    expect(getPendingCount("chat")).toBe(1);
    expect(getPendingCount("discord")).toBe(0);
  });
});
