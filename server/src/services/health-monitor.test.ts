import { describe, it, expect, beforeEach, spyOn, mock } from "bun:test";
import { createHealthMonitor } from "./health-monitor.js";
import * as proc from "./process-manager.js";
import * as signalsDb from "./signals-db.js";
import * as agentManager from "./agent-manager.js";
import * as cooldowns from "./overseer-stop-cooldown.js";
import * as alertsDb from "./alerts-db.js";
import type { AgentConfig } from "../config.js";

const testAgents: AgentConfig[] = [
  { name: "drifter-gale", backend: "claude", model: "haiku" },
  { name: "sable-thorn", backend: "claude", model: "sonnet" },
] as AgentConfig[];

describe("createHealthMonitor", () => {
  let mockHasSession: ReturnType<typeof spyOn>;
  let mockHasSignal: ReturnType<typeof spyOn>;
  let mockGetSignalMessage: ReturnType<typeof spyOn>;
  let mockClearSignal: ReturnType<typeof spyOn>;
  let mockStartAgent: ReturnType<typeof spyOn>;
  let mockIsRestartSuppressed: ReturnType<typeof spyOn>;
  let mockCreateAlert: ReturnType<typeof spyOn>;
  let mockHasRecentAlert: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mock.restore();
    mockHasSession = spyOn(proc, "hasSession").mockResolvedValue(false);
    mockHasSignal = spyOn(signalsDb, "hasSignal").mockReturnValue(false);
    mockGetSignalMessage = spyOn(signalsDb, "getSignalMessage").mockReturnValue(null);
    mockClearSignal = spyOn(signalsDb, "clearSignal").mockImplementation(() => {});
    mockStartAgent = spyOn(agentManager, "startAgent").mockResolvedValue({ ok: true, message: "started" });
    mockIsRestartSuppressed = spyOn(cooldowns, "isRestartSuppressed").mockReturnValue({ suppressed: false });
    mockCreateAlert = spyOn(alertsDb, "createAlert").mockReturnValue(1);
    mockHasRecentAlert = spyOn(alertsDb, "hasRecentAlert").mockReturnValue(false);
  });

  describe("tick — agent is alive", () => {
    it("does not restart an already-running agent", async () => {
      mockHasSession.mockResolvedValue(true);
      const monitor = createHealthMonitor(testAgents);
      await monitor.tick();
      expect(mockStartAgent).not.toHaveBeenCalled();
    });

    it("sets desired state to running when agent is observed alive", async () => {
      mockHasSession.mockResolvedValue(true);
      const monitor = createHealthMonitor(testAgents);
      await monitor.tick();
      expect(monitor.getState("drifter-gale")?.desiredState).toBe("running");
    });

    it("resets consecutive restarts when agent is observed alive", async () => {
      mockHasSession.mockResolvedValue(false);
      mockHasSignal.mockReturnValue(false);
      const monitor = createHealthMonitor(testAgents);
      monitor.markRunning("drifter-gale");

      // First tick — crashes, restarts
      await monitor.tick();
      expect(monitor.getState("drifter-gale")?.consecutiveRestarts).toBe(1);

      // Agent comes back alive (untracked → uptime unknown → treated as stable)
      mockHasSession.mockResolvedValue(true);
      await monitor.tick();
      expect(monitor.getState("drifter-gale")?.consecutiveRestarts).toBe(0);
    });

    it("does not reset the backoff until the agent shows sustained uptime", async () => {
      mockHasSession.mockResolvedValue(false);
      mockHasSignal.mockReturnValue(false);
      const monitor = createHealthMonitor([testAgents[0]]);
      monitor.markRunning("drifter-gale");

      // Crash → restart attempt #1
      await monitor.tick();
      expect(monitor.getState("drifter-gale")?.consecutiveRestarts).toBe(1);

      try {
        // Alive but only for 1 minute — a >30s crash loop must NOT reset backoff
        proc._setProcessStartedAtForTest("drifter-gale", Date.now() - 60_000);
        mockHasSession.mockResolvedValue(true);
        await monitor.tick();
        expect(monitor.getState("drifter-gale")?.consecutiveRestarts).toBe(1);

        // Alive for 11 minutes — sustained uptime forgives the backoff
        proc._setProcessStartedAtForTest("drifter-gale", Date.now() - 11 * 60_000);
        await monitor.tick();
        expect(monitor.getState("drifter-gale")?.consecutiveRestarts).toBe(0);
      } finally {
        proc._setProcessStartedAtForTest("drifter-gale", null);
      }
    });
  });

  describe("tick — agent is dead, desired state = stopped", () => {
    it("does not restart agent with desired state stopped", async () => {
      mockHasSession.mockResolvedValue(false);
      const monitor = createHealthMonitor(testAgents);
      // Default desired state is "stopped"
      await monitor.tick();
      expect(mockStartAgent).not.toHaveBeenCalled();
    });

    it("does not restart after markStopped", async () => {
      mockHasSession.mockResolvedValue(false);
      const monitor = createHealthMonitor(testAgents);
      monitor.markRunning("drifter-gale");
      monitor.markStopped("drifter-gale");
      await monitor.tick();
      expect(mockStartAgent).not.toHaveBeenCalled();
    });
  });

  describe("tick — retired agent (enabled: false)", () => {
    it("never restarts a retired agent, even when desired state is running and no stop signal", async () => {
      // This is the durable-retirement guarantee: a stopped_gracefully signal can
      // be cleared (consumed / server restart), flipping a manually-stopped agent
      // back to restartable. enabled:false must keep it down unconditionally.
      const agents: AgentConfig[] = [
        { name: "drifter-gale", backend: "claude", model: "haiku" },
        { name: "cinder-wake", backend: "claude", model: "haiku", enabled: false },
      ] as AgentConfig[];
      mockHasSession.mockResolvedValue(false); // both not running
      mockHasSignal.mockReturnValue(false);    // no stop signals present
      const monitor = createHealthMonitor(agents);
      monitor.markRunning("drifter-gale");
      monitor.markRunning("cinder-wake");      // pretend both were running → desiredState "running"
      await monitor.tick();
      // Control: a normal crashed agent IS restarted.
      expect(mockStartAgent).toHaveBeenCalledWith("drifter-gale");
      // Retired agent must NOT be restarted.
      expect(mockStartAgent).not.toHaveBeenCalledWith("cinder-wake");
    });
  });

  describe("tick — agent is dead, stopped_gracefully signal present", () => {
    it("does not restart when stopped_gracefully signal is set", async () => {
      mockHasSession.mockResolvedValue(false);
      mockHasSignal.mockImplementation((name: string, type: string) => type === "stopped_gracefully");
      const monitor = createHealthMonitor(testAgents);
      monitor.markRunning("drifter-gale");
      await monitor.tick();
      expect(mockStartAgent).not.toHaveBeenCalled();
    });

    it("sets desired state to stopped when stopped_gracefully is present", async () => {
      mockHasSession.mockResolvedValue(false);
      mockHasSignal.mockImplementation((name: string, type: string) => type === "stopped_gracefully");
      const monitor = createHealthMonitor(testAgents);
      monitor.markRunning("drifter-gale");
      await monitor.tick();
      expect(monitor.getState("drifter-gale")?.desiredState).toBe("stopped");
    });

    it("does not restart when shutdown signal is pending", async () => {
      mockHasSession.mockResolvedValue(false);
      mockHasSignal.mockImplementation((name: string, type: string) => type === "shutdown");
      const monitor = createHealthMonitor(testAgents);
      monitor.markRunning("drifter-gale");
      await monitor.tick();
      expect(mockStartAgent).not.toHaveBeenCalled();
    });
  });

  describe("tick — quota_exhausted alert on rate_limit stop", () => {
    it("files a quota_exhausted alert when stopped_gracefully message is rate_limit", async () => {
      mockHasSession.mockResolvedValue(false);
      mockHasSignal.mockImplementation((name: string, type: string) => type === "stopped_gracefully");
      mockGetSignalMessage.mockReturnValue("rate_limit");
      mockHasRecentAlert.mockReturnValue(false);
      const monitor = createHealthMonitor(testAgents);
      monitor.markRunning("drifter-gale");
      await monitor.tick();
      expect(mockCreateAlert).toHaveBeenCalledWith(
        "drifter-gale",
        "warning",
        "quota_exhausted",
        expect.stringContaining("rate limit"),
      );
    });

    it("includes the agent backend in the alert message", async () => {
      mockHasSession.mockResolvedValue(false);
      mockHasSignal.mockImplementation((name: string, type: string) => type === "stopped_gracefully");
      mockGetSignalMessage.mockReturnValue("rate_limit");
      mockHasRecentAlert.mockReturnValue(false);
      const monitor = createHealthMonitor(testAgents);
      monitor.markRunning("drifter-gale");
      await monitor.tick();
      const [, , , message] = mockCreateAlert.mock.calls[0] as [string, string, string, string];
      expect(message).toContain("claude");
    });

    it("does NOT file an alert when stopped_gracefully message is consecutive_failures", async () => {
      mockHasSession.mockResolvedValue(false);
      mockHasSignal.mockImplementation((name: string, type: string) => type === "stopped_gracefully");
      mockGetSignalMessage.mockReturnValue("consecutive_failures");
      const monitor = createHealthMonitor(testAgents);
      monitor.markRunning("drifter-gale");
      await monitor.tick();
      expect(mockCreateAlert).not.toHaveBeenCalled();
    });

    it("does NOT file an alert when stopped_gracefully message is null", async () => {
      mockHasSession.mockResolvedValue(false);
      mockHasSignal.mockImplementation((name: string, type: string) => type === "stopped_gracefully");
      mockGetSignalMessage.mockReturnValue(null);
      const monitor = createHealthMonitor(testAgents);
      monitor.markRunning("drifter-gale");
      await monitor.tick();
      expect(mockCreateAlert).not.toHaveBeenCalled();
    });

    it("does NOT file a second alert when one already exists within 24h (idempotence)", async () => {
      mockHasSession.mockResolvedValue(false);
      mockHasSignal.mockImplementation((name: string, type: string) => type === "stopped_gracefully");
      mockGetSignalMessage.mockReturnValue("rate_limit");
      mockHasRecentAlert.mockReturnValue(true); // already filed
      const monitor = createHealthMonitor(testAgents);
      monitor.markRunning("drifter-gale");
      await monitor.tick();
      expect(mockCreateAlert).not.toHaveBeenCalled();
    });

    it("running monitor twice only inserts one alert (idempotence via hasRecentAlert)", async () => {
      mockHasSession.mockResolvedValue(false);
      mockHasSignal.mockImplementation((name: string, type: string) => type === "stopped_gracefully");
      mockGetSignalMessage.mockReturnValue("rate_limit");
      // First pass: no recent alert → insert; second pass: alert now exists → skip
      mockHasRecentAlert.mockReturnValueOnce(false).mockReturnValue(true);
      const monitor = createHealthMonitor(testAgents);
      monitor.markRunning("drifter-gale");
      await monitor.tick();
      await monitor.tick();
      expect(mockCreateAlert).toHaveBeenCalledTimes(1);
    });

    it("still sets desiredState=stopped and skips restart when rate_limit signal is present", async () => {
      mockHasSession.mockResolvedValue(false);
      mockHasSignal.mockImplementation((name: string, type: string) => type === "stopped_gracefully");
      mockGetSignalMessage.mockReturnValue("rate_limit");
      mockHasRecentAlert.mockReturnValue(false);
      const monitor = createHealthMonitor(testAgents);
      monitor.markRunning("drifter-gale");
      await monitor.tick();
      expect(mockStartAgent).not.toHaveBeenCalled();
      expect(monitor.getState("drifter-gale")?.desiredState).toBe("stopped");
    });
  });

  describe("tick — crashed agent auto-restart", () => {
    it("restarts agent when desired=running, no signals, process dead", async () => {
      mockHasSession.mockResolvedValue(false);
      mockHasSignal.mockReturnValue(false);
      const monitor = createHealthMonitor(testAgents);
      monitor.markRunning("drifter-gale");
      await monitor.tick();
      expect(mockStartAgent).toHaveBeenCalledWith("drifter-gale");
    });

    it("increments consecutiveRestarts after each restart attempt", async () => {
      mockHasSession.mockResolvedValue(false);
      mockHasSignal.mockReturnValue(false);
      const monitor = createHealthMonitor(testAgents);
      monitor.markRunning("drifter-gale");

      await monitor.tick();
      expect(monitor.getState("drifter-gale")?.consecutiveRestarts).toBe(1);
    });

    it("sets nextRestartAfterMs to enforce backoff after restart", async () => {
      mockHasSession.mockResolvedValue(false);
      mockHasSignal.mockReturnValue(false);
      const monitor = createHealthMonitor(testAgents);
      monitor.markRunning("drifter-gale");

      const before = Date.now();
      await monitor.tick();
      const after = Date.now();

      const state = monitor.getState("drifter-gale")!;
      // First backoff is 30s
      expect(state.nextRestartAfterMs).toBeGreaterThanOrEqual(before + 30_000);
      expect(state.nextRestartAfterMs).toBeLessThanOrEqual(after + 30_000 + 100);
    });

    it("skips restart when backoff is active", async () => {
      mockHasSession.mockResolvedValue(false);
      mockHasSignal.mockReturnValue(false);
      const monitor = createHealthMonitor(testAgents);
      monitor.markRunning("drifter-gale");

      // First tick — triggers restart for drifter-gale (sable-thorn desired=stopped)
      await monitor.tick();
      expect(mockStartAgent).toHaveBeenCalledTimes(1);
      expect(mockStartAgent).toHaveBeenCalledWith("drifter-gale");

      // Second tick — backoff prevents another restart for drifter-gale
      mockStartAgent.mockClear();
      await monitor.tick();
      expect(mockStartAgent).not.toHaveBeenCalledWith("drifter-gale");
    });

    it("only restarts agents with desired state = running", async () => {
      mockHasSession.mockResolvedValue(false);
      mockHasSignal.mockReturnValue(false);
      const monitor = createHealthMonitor(testAgents);
      // Only mark drifter-gale as should-be-running
      monitor.markRunning("drifter-gale");

      await monitor.tick();
      // Only drifter-gale should be restarted
      expect(mockStartAgent).toHaveBeenCalledWith("drifter-gale");
      expect(mockStartAgent).not.toHaveBeenCalledWith("sable-thorn");
    });

    it("preserves desiredState=running during a normal overseer cooldown so auto-restart can resume after expiry", async () => {
      mockHasSession.mockResolvedValue(false);
      mockHasSignal.mockReturnValue(false);
      mockIsRestartSuppressed
        .mockReturnValueOnce({
          suppressed: true,
          stoppedUntil: new Date(Date.now() + 60_000),
          reason: "overseer stop",
          holdOffline: false,
        })
        .mockReturnValueOnce({ suppressed: false });

      const monitor = createHealthMonitor([testAgents[0]]);
      monitor.markRunning("drifter-gale");

      await monitor.tick();
      expect(mockStartAgent).not.toHaveBeenCalled();
      expect(monitor.getState("drifter-gale")?.desiredState).toBe("running");

      await monitor.tick();
      expect(mockStartAgent).toHaveBeenCalledWith("drifter-gale");
    });

    it("auto-resumes after a normal overseer cooldown even though the soft stop set markStopped and left a stopped_gracefully signal", async () => {
      // Real overseer stop flow: softStopAgent leaves a stopped_gracefully
      // signal AND the onStopped hook calls markStopped. Neither may keep the
      // agent down once the 1h cooldown expires.
      mockHasSession.mockResolvedValue(false);
      let signalCleared = false;
      mockHasSignal.mockImplementation(
        (_name: string, type: string) => !signalCleared && type === "stopped_gracefully",
      );
      mockClearSignal.mockImplementation(() => { signalCleared = true; });
      mockIsRestartSuppressed
        .mockReturnValueOnce({
          suppressed: true,
          stoppedUntil: new Date(Date.now() + 60_000),
          reason: "overseer stop",
          holdOffline: false,
        })
        .mockReturnValue({ suppressed: false });

      const monitor = createHealthMonitor([testAgents[0]]);
      monitor.markRunning("drifter-gale");
      monitor.markStopped("drifter-gale"); // onStopped hook fires on every stop kind

      // Cooldown active: no restart, but auto-resume stays armed
      await monitor.tick();
      expect(mockStartAgent).not.toHaveBeenCalled();
      expect(monitor.getState("drifter-gale")?.desiredState).toBe("running");

      // Cooldown expired: leftover overseer stop signals are cleared and the agent restarts
      await monitor.tick();
      expect(mockClearSignal).toHaveBeenCalledWith("drifter-gale", "stopped_gracefully");
      expect(mockStartAgent).toHaveBeenCalledWith("drifter-gale");
    });

    it("switches to desiredState=stopped when hold_offline is set", async () => {
      mockHasSession.mockResolvedValue(false);
      mockHasSignal.mockReturnValue(false);
      mockIsRestartSuppressed.mockReturnValue({
        suppressed: true,
        stoppedUntil: new Date(Date.now() + 60_000),
        reason: "overseer escalation",
        holdOffline: true,
      });

      const monitor = createHealthMonitor([testAgents[0]]);
      monitor.markRunning("drifter-gale");

      await monitor.tick();
      expect(mockStartAgent).not.toHaveBeenCalled();
      expect(monitor.getState("drifter-gale")?.desiredState).toBe("stopped");
    });
  });

  describe("exponential backoff", () => {
    it("applies increasing backoff delays for consecutive crashes", async () => {
      mockHasSession.mockResolvedValue(false);
      mockHasSignal.mockReturnValue(false);
      const monitor = createHealthMonitor([testAgents[0]]);
      monitor.markRunning("drifter-gale");

      const delays: number[] = [];

      for (let i = 0; i < 5; i++) {
        // Force nextRestartAfterMs to 0 to bypass backoff, simulating time passing
        const state = monitor.getState("drifter-gale");
        if (state) state.nextRestartAfterMs = 0;

        const before = Date.now();
        await monitor.tick();
        const after = Date.now();

        const s = monitor.getState("drifter-gale")!;
        delays.push(s.nextRestartAfterMs - after);
      }

      // Delays should be non-decreasing and cap out
      expect(delays[0]).toBeLessThan(delays[2]); // backoff grows
      expect(delays[4]).toBeLessThanOrEqual(600_000 + 200); // capped at 10 min
    });
  });

  describe("markRunning / markStopped", () => {
    it("markRunning sets desired state to running without resetting the backoff", async () => {
      // startAgent fires the onStarted hook (→ markRunning) on every restart
      // attempt, including the monitor's own — resetting the counters here
      // would zero the backoff that was just applied.
      mockHasSession.mockResolvedValue(false);
      mockHasSignal.mockReturnValue(false);
      const monitor = createHealthMonitor(testAgents);
      monitor.markRunning("drifter-gale");
      await monitor.tick(); // crash → restart attempt #1

      monitor.markRunning("drifter-gale"); // simulates the onStarted hook
      const state = monitor.getState("drifter-gale");
      expect(state?.desiredState).toBe("running");
      expect(state?.consecutiveRestarts).toBe(1);
      expect(state?.nextRestartAfterMs).toBeGreaterThan(0);
    });

    it("markStopped sets desired state to stopped", () => {
      const monitor = createHealthMonitor(testAgents);
      monitor.markRunning("drifter-gale");
      monitor.markStopped("drifter-gale");
      expect(monitor.getState("drifter-gale")?.desiredState).toBe("stopped");
    });
  });
});
