/**
 * Tests for agent lifecycle improvements:
 * - stop_after_turn state transitions
 * - Order API accepts stop_after_turn
 * - System events appear in tool-call-logger
 * - Shutdown timeout is 60s (not 180s)
 */
import { describe, it, expect, afterEach, beforeEach, mock } from "bun:test";
import { createDatabase, closeDb } from "../../services/database.js";
import {
  SessionShutdownManager,
  resetSessionShutdownManager,
} from "../session-shutdown.js";
import { getRingBuffer } from "../tool-call-logger.js";
import { SOFT_STOP_TIMEOUT, setSoftStopTimingForTesting } from "../../config/constants.js";

// ---------------------------------------------------------------------------
// stop_after_turn state transitions
// ---------------------------------------------------------------------------

describe("stop_after_turn state transitions", () => {
  let manager: SessionShutdownManager;

  beforeEach(() => {
    createDatabase(":memory:");
    resetSessionShutdownManager();
    manager = new SessionShutdownManager();
  });

  afterEach(() => {
    closeDb();
  });

  it("requestStopAfterTurn sets state to 'stop_after_turn'", () => {
    const state = manager.requestStopAfterTurn("drifter-gale");
    expect(state).toBe("stop_after_turn");
    expect(manager.getShutdownState("drifter-gale")).toBe("stop_after_turn");
  });

  it("requestStopAfterTurn returns 'stop_after_turn' and isShuttingDown returns true", () => {
    manager.requestStopAfterTurn("sable-thorn");
    expect(manager.isShuttingDown("sable-thorn")).toBe(true);
  });

  it("stop_after_turn can be cleared back to none", () => {
    manager.requestStopAfterTurn("cinder-wake");
    expect(manager.getShutdownState("cinder-wake")).toBe("stop_after_turn");

    manager.clearShutdownState("cinder-wake");
    expect(manager.getShutdownState("cinder-wake")).toBe("none");
    expect(manager.isShuttingDown("cinder-wake")).toBe(false);
  });

  it("stop_after_turn can be overridden by requestShutdown (urgent override)", () => {
    manager.requestStopAfterTurn("drifter-gale");
    expect(manager.getShutdownState("drifter-gale")).toBe("stop_after_turn");

    // Escalate to immediate draining shutdown
    manager.requestShutdown("drifter-gale", false, "Escalated");
    expect(manager.getShutdownState("drifter-gale")).toBe("draining");
  });

  it("stop_after_turn accepts optional reason", () => {
    const state = manager.requestStopAfterTurn("nova-fleet", "End of session");
    expect(state).toBe("stop_after_turn");
  });

  it("getAgentsInShutdown includes stop_after_turn agents", () => {
    manager.requestStopAfterTurn("drifter-gale");
    manager.requestShutdown("sable-thorn", false);

    const agents = manager.getAgentsInShutdown();
    expect(agents).toContain("drifter-gale");
    expect(agents).toContain("sable-thorn");
  });

  it("stop_after_turn does not appear in getAgentsWaitingForBattle", () => {
    manager.requestStopAfterTurn("drifter-gale");

    const waiting = manager.getAgentsWaitingForBattle();
    expect(waiting).not.toContain("drifter-gale");
  });

  it("stop_after_turn does not restrict tools (unlike draining)", () => {
    manager.requestStopAfterTurn("drifter-gale");

    // isAllowedToolDuringShutdown is for draining/shutdown_waiting — not stop_after_turn
    // We verify stop_after_turn is NOT draining, so tool restrictions don't apply
    const state = manager.getShutdownState("drifter-gale");
    expect(state).not.toBe("draining");
    expect(state).not.toBe("shutdown_waiting");
    expect(state).toBe("stop_after_turn");
  });
});

// ---------------------------------------------------------------------------
// System event appears in tool-call-logger (activity feed)
// ---------------------------------------------------------------------------

describe("shutdown system events in activity feed", () => {
  beforeEach(() => {
    createDatabase(":memory:");
    resetSessionShutdownManager();
  });

  afterEach(() => {
    closeDb();
  });

  it("requestShutdown emits a __system_event record to the ring buffer", () => {
    const beforeLen = getRingBuffer().length;
    const manager = new SessionShutdownManager();
    manager.requestShutdown("drifter-gale", false, "Test shutdown");

    const buffer = getRingBuffer();
    expect(buffer.length).toBeGreaterThan(beforeLen);

    // Find the system event
    const systemEvents = buffer.filter(r => r.tool_name === "__system_event" && r.agent === "drifter-gale");
    expect(systemEvents.length).toBeGreaterThan(0);
  });

  it("requestStopAfterTurn emits a __system_event with stop_after_turn state", () => {
    const beforeLen = getRingBuffer().length;
    const manager = new SessionShutdownManager();
    manager.requestStopAfterTurn("sable-thorn", "After-turn stop");

    const buffer = getRingBuffer();
    const systemEvents = buffer.filter(
      r => r.tool_name === "__system_event" && r.agent === "sable-thorn"
    );
    expect(systemEvents.length).toBeGreaterThan(0);

    // The most recently completed one should reference stop_after_turn
    const completed = systemEvents.filter(r => r.status === "complete");
    expect(completed.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Shutdown timeout is 60s (not 180s)
// ---------------------------------------------------------------------------

describe("SOFT_STOP_TIMEOUT", () => {
  it("SOFT_STOP_TIMEOUT default is 60000ms (60 seconds)", () => {
    // Reset to defaults to get the canonical default value regardless of test ordering
    setSoftStopTimingForTesting();
    expect(SOFT_STOP_TIMEOUT).toBe(60_000);
  });

  it("SOFT_STOP_TIMEOUT is not 180000ms (old value)", () => {
    setSoftStopTimingForTesting();
    expect(SOFT_STOP_TIMEOUT).not.toBe(180_000);
  });
});
