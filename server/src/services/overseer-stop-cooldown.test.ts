/**
 * Tests for overseer-stop-cooldown.ts
 *
 * Uses :memory: SQLite database so each test group is isolated.
 * Fake-clock support uses the injectable `nowMs` parameter — no Date spy needed.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createDatabase, closeDb } from "./database.js";
import {
  OVERSEER_STOP_COOLDOWN_MS,
  ESCALATION_THRESHOLD,
  isRestartSuppressed,
  recordOverseerStop,
  clearCooldownForOperatorStart,
  getAllCooldowns,
  getStopHistory,
} from "./overseer-stop-cooldown.js";
import { getPendingAlerts } from "./alerts-db.js";

function setupDb() {
  createDatabase(":memory:");
}

// Helpers to generate unique timestamps (avoids same-second ties in SQLite)
let _testBase = 0;
function baseMs(): number {
  if (_testBase === 0) _testBase = Date.now();
  return _testBase;
}
function tsMs(offsetSec = 0): number {
  return baseMs() + offsetSec * 1_000;
}

describe("overseer-stop-cooldown", () => {
  beforeEach(() => {
    setupDb();
    _testBase = Date.now();
  });
  afterEach(closeDb);

  // ---------------------------------------------------------------------------
  // isRestartSuppressed — no record
  // ---------------------------------------------------------------------------

  describe("isRestartSuppressed — no record", () => {
    it("returns suppressed=false when no cooldown exists", () => {
      const result = isRestartSuppressed("rust-vane");
      expect(result.suppressed).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // recordOverseerStop — basic cooldown write
  // ---------------------------------------------------------------------------

  describe("recordOverseerStop — cooldown", () => {
    it("sets a cooldown after recording a stop", () => {
      const t0 = tsMs(0);
      recordOverseerStop("rust-vane", "behavior loop detected", t0);
      const result = isRestartSuppressed("rust-vane", t0 + 60_000); // check 1 min later
      expect(result.suppressed).toBe(true);
      expect(result.stoppedUntil).toBeInstanceOf(Date);
      expect(result.reason).toBe("behavior loop detected");
    });

    it("stopped_until is approximately now + 1h", () => {
      const t0 = tsMs(0);
      recordOverseerStop("rust-vane", "test", t0);
      const result = isRestartSuppressed("rust-vane", t0 + 1_000);
      expect(result.suppressed).toBe(true);
      const until = result.stoppedUntil!.getTime();
      expect(until).toBeCloseTo(t0 + OVERSEER_STOP_COOLDOWN_MS, -2); // within 100ms
    });

    it("cooldown is independent per agent", () => {
      const t0 = tsMs(0);
      recordOverseerStop("rust-vane", "loop", t0);
      const rvResult = isRestartSuppressed("rust-vane", t0 + 1_000);
      const lsResult = isRestartSuppressed("lumen-shoal", t0 + 1_000);
      expect(rvResult.suppressed).toBe(true);
      expect(lsResult.suppressed).toBe(false);
    });

    it("multiple stops update the cooldown row (upsert)", () => {
      const t0 = tsMs(0);
      const t1 = tsMs(1);
      recordOverseerStop("rust-vane", "first stop", t0);
      recordOverseerStop("rust-vane", "second stop", t1);
      const result = isRestartSuppressed("rust-vane", t1 + 1_000);
      expect(result.suppressed).toBe(true);
      // Reason reflects the most recent stop
      expect(result.reason).toBe("second stop");
      // Only one cooldown row per agent
      const cooldowns = getAllCooldowns().filter(c => c.agent === "rust-vane");
      expect(cooldowns.length).toBe(1);
    });

    it("appends to stop history on each stop (most recent first)", () => {
      const t0 = tsMs(0);
      const t1 = tsMs(1);
      recordOverseerStop("lumen-shoal", "stop 1", t0);
      recordOverseerStop("lumen-shoal", "stop 2", t1);
      const history = getStopHistory("lumen-shoal");
      expect(history.length).toBe(2);
      // Most recent first
      expect(history[0].reason).toBe("stop 2");
      expect(history[1].reason).toBe("stop 1");
    });
  });

  // ---------------------------------------------------------------------------
  // Fake-clock: suppression expires after cooldown period
  // ---------------------------------------------------------------------------

  describe("cooldown expiry (injectable clock)", () => {
    it("returns suppressed=false after OVERSEER_STOP_COOLDOWN_MS has elapsed", () => {
      const t0 = tsMs(0);
      recordOverseerStop("rust-vane", "loop", t0);
      // Check just after the cooldown expires
      const afterExpiry = t0 + OVERSEER_STOP_COOLDOWN_MS + 1_000;
      const result = isRestartSuppressed("rust-vane", afterExpiry);
      expect(result.suppressed).toBe(false);
    });

    it("returns suppressed=true when only half the cooldown has elapsed", () => {
      const t0 = tsMs(0);
      recordOverseerStop("rust-vane", "loop", t0);
      const halfWay = t0 + OVERSEER_STOP_COOLDOWN_MS / 2;
      const result = isRestartSuppressed("rust-vane", halfWay);
      expect(result.suppressed).toBe(true);
    });

    it("returns suppressed=true one second before expiry", () => {
      const t0 = tsMs(0);
      recordOverseerStop("rust-vane", "loop", t0);
      const justBefore = t0 + OVERSEER_STOP_COOLDOWN_MS - 1_000;
      expect(isRestartSuppressed("rust-vane", justBefore).suppressed).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // clearCooldownForOperatorStart
  // ---------------------------------------------------------------------------

  describe("clearCooldownForOperatorStart", () => {
    it("clears the cooldown when an active one exists", () => {
      const t0 = tsMs(0);
      recordOverseerStop("rust-vane", "loop", t0);
      expect(isRestartSuppressed("rust-vane", t0 + 1_000).suppressed).toBe(true);

      clearCooldownForOperatorStart("rust-vane", t0 + 60_000);
      expect(isRestartSuppressed("rust-vane", t0 + 60_001).suppressed).toBe(false);
    });

    it("does nothing when no cooldown exists", () => {
      // Should not throw
      expect(() => clearCooldownForOperatorStart("cinder-wake")).not.toThrow();
    });

    it("does not affect other agents", () => {
      const t0 = tsMs(0);
      recordOverseerStop("rust-vane", "loop", t0);
      recordOverseerStop("lumen-shoal", "loop", t0);

      clearCooldownForOperatorStart("rust-vane", t0 + 60_000);

      expect(isRestartSuppressed("rust-vane", t0 + 60_001).suppressed).toBe(false);
      expect(isRestartSuppressed("lumen-shoal", t0 + 60_001).suppressed).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Escalation alert — fires at threshold crossing
  // ---------------------------------------------------------------------------

  describe("escalation alert", () => {
    it("fires a critical alert after ESCALATION_THRESHOLD stops", () => {
      const agent = "lumen-shoal";
      for (let i = 0; i < ESCALATION_THRESHOLD; i++) {
        recordOverseerStop(agent, `stop reason ${i + 1}`, tsMs(i));
      }

      const alerts = getPendingAlerts(agent);
      expect(alerts.length).toBe(1);
      expect(alerts[0].severity).toBe("critical");
      expect(alerts[0].category).toBe("overseer-loop");
      expect(alerts[0].message).toContain(agent);
      expect(alerts[0].message).toContain(`${ESCALATION_THRESHOLD}x`);
    });

    it("does NOT fire before reaching the threshold", () => {
      const agent = "sable-thorn";
      for (let i = 0; i < ESCALATION_THRESHOLD - 1; i++) {
        recordOverseerStop(agent, `stop ${i + 1}`, tsMs(i));
      }
      expect(getPendingAlerts(agent).length).toBe(0);
    });

    it("fires only once per threshold crossing (debounce)", () => {
      const agent = "rust-vane";
      // Record well above threshold
      for (let i = 0; i < ESCALATION_THRESHOLD + 2; i++) {
        recordOverseerStop(agent, `stop ${i + 1}`, tsMs(i));
      }
      // Alert should have fired exactly once
      const alerts = getPendingAlerts(agent);
      expect(alerts.length).toBe(1);
    });

    it("refires alert after old stops age out of the 24h window and threshold is crossed again", () => {
      const agent = "cinder-wake";
      const WINDOW_MS = 24 * 60 * 60 * 1000;

      // Phase 1: record 3 stops at t=0..2s → alert fires
      for (let i = 0; i < ESCALATION_THRESHOLD; i++) {
        recordOverseerStop(agent, `old stop ${i + 1}`, tsMs(i));
      }
      expect(getPendingAlerts(agent).length).toBe(1);

      // Phase 2: record 1 stop at t=25h (outside the 24h window from t=25h perspective)
      // From t=25h, windowStart = 25h - 24h = 1h. The old stops are at t≈0, which
      // is BEFORE 1h → they're outside the window. Count = 1 < threshold → alert_fired_at cleared.
      const t25h = tsMs(0) + WINDOW_MS + 60 * 60 * 1000; // 25h after base
      recordOverseerStop(agent, "gap stop at T+25h", t25h);

      // Phase 3: record THRESHOLD-1 more stops at t=25h+1s, t=25h+2s, etc.
      // From the perspective of each new stop at ~T+25h, the window covers
      // T+1h to T+25h. The old stops at T≈0 are outside. The gap stop + new
      // stops are inside. After THRESHOLD total in-window stops, alert refires.
      for (let i = 0; i < ESCALATION_THRESHOLD - 1; i++) {
        recordOverseerStop(agent, `post-gap stop ${i + 1}`, t25h + (i + 1) * 1_000);
      }

      // Should have 2 total alerts
      const alerts = getPendingAlerts(agent);
      expect(alerts.length).toBe(2);
    });

    it("alert message includes agent name and recent stop reasons", () => {
      const agent = "drifter-gale";
      const reasons = ["stuck in transit", "sell loop", "idle at station"];
      for (let i = 0; i < reasons.length; i++) {
        recordOverseerStop(agent, reasons[i], tsMs(i));
      }
      const alerts = getPendingAlerts(agent);
      expect(alerts.length).toBe(1);
      for (const r of reasons) {
        expect(alerts[0].message).toContain(r);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // hold_offline — set when escalation threshold is crossed; only operator can clear
  // ---------------------------------------------------------------------------

  describe("hold_offline flag", () => {
    it("is NOT set after a single stop (below threshold)", () => {
      const t0 = tsMs(0);
      recordOverseerStop("rust-vane", "first stop", t0);
      const cooldowns = getAllCooldowns().filter(c => c.agent === "rust-vane");
      expect(cooldowns[0].hold_offline).toBe(0);
      const result = isRestartSuppressed("rust-vane", t0 + 1_000);
      expect(result.suppressed).toBe(true);
      expect(result.holdOffline).toBeFalsy();
    });

    it("is set when escalation threshold is crossed", () => {
      const agent = "lumen-shoal";
      for (let i = 0; i < ESCALATION_THRESHOLD; i++) {
        recordOverseerStop(agent, `stop ${i + 1}`, tsMs(i));
      }
      const cooldowns = getAllCooldowns().filter(c => c.agent === agent);
      expect(cooldowns[0].hold_offline).toBe(1);
    });

    it("suppresses restart indefinitely — past the normal cooldown expiry", () => {
      const agent = "cinder-wake";
      const t0 = tsMs(0);
      for (let i = 0; i < ESCALATION_THRESHOLD; i++) {
        recordOverseerStop(agent, `stop ${i + 1}`, t0 + i * 1_000);
      }
      // Far past the normal 1h cooldown window.
      const wayAfter = t0 + OVERSEER_STOP_COOLDOWN_MS + 10 * 60 * 60 * 1000;
      const result = isRestartSuppressed(agent, wayAfter);
      expect(result.suppressed).toBe(true);
      expect(result.holdOffline).toBe(true);
      expect(result.reason).toContain("stop");
    });

    it("is cleared by clearCooldownForOperatorStart", () => {
      const agent = "sable-thorn";
      const t0 = tsMs(0);
      for (let i = 0; i < ESCALATION_THRESHOLD; i++) {
        recordOverseerStop(agent, `stop ${i + 1}`, t0 + i * 1_000);
      }
      expect(isRestartSuppressed(agent, t0 + 5_000).holdOffline).toBe(true);

      clearCooldownForOperatorStart(agent, t0 + 5_000);
      const result = isRestartSuppressed(agent, t0 + 6_000);
      expect(result.suppressed).toBe(false);
      expect(result.holdOffline).toBeFalsy();

      const cooldowns = getAllCooldowns().filter(c => c.agent === agent);
      expect(cooldowns[0].hold_offline).toBe(0);
    });

    it("clearCooldownForOperatorStart handles hold_offline even when timestamp cooldown has already expired", () => {
      const agent = "brass-meridian";
      const t0 = tsMs(0);
      for (let i = 0; i < ESCALATION_THRESHOLD; i++) {
        recordOverseerStop(agent, `stop ${i + 1}`, t0 + i * 1_000);
      }
      // Jump past the timestamp cooldown — only hold_offline remains active.
      const wayAfter = t0 + OVERSEER_STOP_COOLDOWN_MS + 60 * 60 * 1000;
      expect(isRestartSuppressed(agent, wayAfter).holdOffline).toBe(true);

      clearCooldownForOperatorStart(agent, wayAfter);
      expect(isRestartSuppressed(agent, wayAfter + 1_000).suppressed).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // getAllCooldowns / getStopHistory
  // ---------------------------------------------------------------------------

  describe("observability helpers", () => {
    it("getAllCooldowns returns rows for all stopped agents", () => {
      const t0 = tsMs(0);
      recordOverseerStop("rust-vane", "loop", t0);
      recordOverseerStop("lumen-shoal", "loop", t0);
      const cooldowns = getAllCooldowns();
      const agents = cooldowns.map(c => c.agent);
      expect(agents).toContain("rust-vane");
      expect(agents).toContain("lumen-shoal");
    });

    it("getStopHistory returns limited results", () => {
      for (let i = 0; i < 5; i++) {
        recordOverseerStop("rust-vane", `stop ${i}`, tsMs(i));
      }
      const history = getStopHistory("rust-vane", 3);
      expect(history.length).toBe(3);
    });

    it("getStopHistory returns empty array when no history exists", () => {
      const history = getStopHistory("nonexistent-agent");
      expect(history).toEqual([]);
    });
  });
});
