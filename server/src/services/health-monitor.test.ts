import { describe, it, expect, beforeEach, spyOn, mock } from "bun:test";
import { createHealthMonitor } from "./health-monitor.js";
import * as proc from "./process-manager.js";
import * as signalsDb from "./signals-db.js";
import * as agentManager from "./agent-manager.js";
import type { AgentConfig } from "../config.js";

const testAgents: AgentConfig[] = [
  { name: "drifter-gale", backend: "claude", model: "haiku" },
  { name: "sable-thorn", backend: "claude", model: "sonnet" },
] as AgentConfig[];

describe("createHealthMonitor", () => {
  let mockHasSession: ReturnType<typeof spyOn>;
  let mockHasSignal: ReturnType<typeof spyOn>;
  let mockStartAgent: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mock.restore();
    mockHasSession = spyOn(proc, "hasSession").mockResolvedValue(false);
    mockHasSignal = spyOn(signalsDb, "hasSignal").mockReturnValue(false);
    mockStartAgent = spyOn(agentManager, "startAgent").mockResolvedValue({ ok: true, message: "started" });
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

      // Agent comes back alive
      mockHasSession.mockResolvedValue(true);
      await monitor.tick();
      expect(monitor.getState("drifter-gale")?.consecutiveRestarts).toBe(0);
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
    it("markRunning sets desired state to running and resets counters", () => {
      const monitor = createHealthMonitor(testAgents);
      monitor.markRunning("drifter-gale");
      const state = monitor.getState("drifter-gale");
      expect(state?.desiredState).toBe("running");
      expect(state?.consecutiveRestarts).toBe(0);
      expect(state?.nextRestartAfterMs).toBe(0);
    });

    it("markStopped sets desired state to stopped", () => {
      const monitor = createHealthMonitor(testAgents);
      monitor.markRunning("drifter-gale");
      monitor.markStopped("drifter-gale");
      expect(monitor.getState("drifter-gale")?.desiredState).toBe("stopped");
    });
  });
});
