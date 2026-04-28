import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { createDatabase, closeDb } from "../../services/database.js";
import {
  SessionShutdownManager,
  getSessionShutdownManager,
  resetSessionShutdownManager,
} from "../session-shutdown.js";

describe("SessionShutdownManager - Integration Tests", () => {
  let manager: SessionShutdownManager;

  beforeEach(() => {
    createDatabase(":memory:");
    resetSessionShutdownManager();
    manager = new SessionShutdownManager();
  });

  afterEach(() => {
    closeDb();
  });

  describe("Test 1: Full shutdown flow without battle", () => {
    it("should transition through draining state without battle", () => {
      const agentName = "agent-no-battle";

      // Request shutdown on non-battle agent → should go to 'draining'
      const initialState = manager.requestShutdown(
        agentName,
        false,
        "Graceful shutdown"
      );
      expect(initialState).toBe("draining");
      expect(manager.getShutdownState(agentName)).toBe("draining");

      // Verify agent is marked as shutting down
      expect(manager.isShuttingDown(agentName)).toBe(true);

      // Complete shutdown
      manager.completeShutdown(agentName);
      expect(manager.getShutdownState(agentName)).toBe("none");
      expect(manager.isShuttingDown(agentName)).toBe(false);
    });

    it("should only allow cleanup tools during draining", () => {
      const agentName = "agent-cleanup-check";
      manager.requestShutdown(agentName, false);

      // Allowed tools during draining
      const allowedTools = [
        "write_diary",
        "read_diary",
        "write_doc",
        "read_doc",
        "captains_log_add",
        "captains_log_list",
        "write_report",
        "read_report",
        "search_memory",
        "logout",
      ];

      for (const tool of allowedTools) {
        expect(manager.isAllowedToolDuringShutdown(tool)).toBe(true);
      }
    });

    it("should block action tools during draining", () => {
      const agentName = "agent-block-actions";
      manager.requestShutdown(agentName, false);

      // Action tools that should be blocked
      const blockedTools = [
        "scan_and_attack",
        "multi_sell",
        "jump_route",
        "batch_mine",
        "trade",
        "mine",
        "jettison",
        "dock",
        "undock",
      ];

      for (const tool of blockedTools) {
        expect(manager.isAllowedToolDuringShutdown(tool)).toBe(false);
      }
    });

    it("logout should complete the shutdown flow", () => {
      const agentName = "agent-logout-flow";
      manager.requestShutdown(agentName, false);
      expect(manager.getShutdownState(agentName)).toBe("draining");

      // Simulate agent calling logout (allowed tool)
      expect(manager.isAllowedToolDuringShutdown("logout")).toBe(true);

      // After logout, shutdown is marked complete
      manager.completeShutdown(agentName);
      expect(manager.getShutdownState(agentName)).toBe("none");
    });
  });

  describe("Test 2: Shutdown flow with battle", () => {
    it("should transition to shutdown_waiting when in battle", () => {
      const agentName = "agent-in-battle";

      // Request shutdown on agent in battle → should go to 'shutdown_waiting'
      const initialState = manager.requestShutdown(
        agentName,
        true,
        "Battle detected"
      );
      expect(initialState).toBe("shutdown_waiting");
      expect(manager.getShutdownState(agentName)).toBe("shutdown_waiting");

      // Verify agent is marked as shutting down
      expect(manager.isShuttingDown(agentName)).toBe(true);

      // Verify agent is in the waiting list
      const waitingAgents = manager.getAgentsWaitingForBattle();
      expect(waitingAgents).toContain(agentName);
    });

    it("should allow all tools during shutdown_waiting", () => {
      const agentName = "agent-battle-all-tools";
      manager.requestShutdown(agentName, true);

      // During shutdown_waiting, combat tools should still be usable
      // (checked in pipeline, not in shutdown manager itself)
      // The manager doesn't block tools during shutdown_waiting
      expect(manager.getShutdownState(agentName)).toBe("shutdown_waiting");
    });

    it("should transition to draining when battle ends", () => {
      const agentName = "agent-battle-end";

      // Start in shutdown_waiting
      manager.requestShutdown(agentName, true, "Battle started");
      expect(manager.getShutdownState(agentName)).toBe("shutdown_waiting");

      // Battle ends - transition to draining
      const transitionSuccess = manager.transitionToDraining(agentName);
      expect(transitionSuccess).toBe(true);
      expect(manager.getShutdownState(agentName)).toBe("draining");

      // Now tool restrictions are enforced
      expect(manager.isAllowedToolDuringShutdown("scan_and_attack")).toBe(false);
      expect(manager.isAllowedToolDuringShutdown("logout")).toBe(true);
    });

    it("should enforce tool restrictions after transitioning to draining", () => {
      const agentName = "agent-tool-restrictions";

      // In battle - all tools available (at pipeline level)
      manager.requestShutdown(agentName, true);
      expect(manager.getShutdownState(agentName)).toBe("shutdown_waiting");

      // Battle ends
      manager.transitionToDraining(agentName);
      expect(manager.getShutdownState(agentName)).toBe("draining");

      // Now cleanup-only tools
      expect(manager.isAllowedToolDuringShutdown("write_diary")).toBe(true);
      expect(manager.isAllowedToolDuringShutdown("batch_mine")).toBe(false);
    });

    it("full battle shutdown flow: waiting → draining → stopped", () => {
      const agentName = "agent-full-battle-flow";

      // Start: none
      expect(manager.getShutdownState(agentName)).toBe("none");
      expect(manager.isShuttingDown(agentName)).toBe(false);

      // Battle detected - transition to shutdown_waiting
      manager.requestShutdown(agentName, true, "Pirate detected");
      expect(manager.getShutdownState(agentName)).toBe("shutdown_waiting");
      expect(manager.isShuttingDown(agentName)).toBe(true);
      expect(manager.getAgentsWaitingForBattle()).toContain(agentName);

      // Battle ends - transition to draining
      const success = manager.transitionToDraining(agentName);
      expect(success).toBe(true);
      expect(manager.getShutdownState(agentName)).toBe("draining");
      expect(manager.getAgentsWaitingForBattle()).not.toContain(agentName);

      // Complete cleanup
      manager.completeShutdown(agentName);
      expect(manager.getShutdownState(agentName)).toBe("none");

      // Clear for restart
      manager.clearShutdownState(agentName);
      expect(manager.getShutdownState(agentName)).toBe("none");
    });
  });

  describe("Test 3: Tool restrictions during draining", () => {
    it("write_diary allowed during draining", () => {
      const agentName = "agent-diary-ok";
      manager.requestShutdown(agentName, false);

      expect(manager.getShutdownState(agentName)).toBe("draining");
      expect(manager.isAllowedToolDuringShutdown("write_diary")).toBe(true);
    });

    it("read_doc allowed during draining", () => {
      const agentName = "agent-read-doc-ok";
      manager.requestShutdown(agentName, false);

      expect(manager.getShutdownState(agentName)).toBe("draining");
      expect(manager.isAllowedToolDuringShutdown("read_doc")).toBe(true);
    });

    it("multi_sell blocked during draining", () => {
      const agentName = "agent-multi-sell-blocked";
      manager.requestShutdown(agentName, false);

      expect(manager.getShutdownState(agentName)).toBe("draining");
      expect(manager.isAllowedToolDuringShutdown("multi_sell")).toBe(false);
    });

    it("batch_mine blocked during draining", () => {
      const agentName = "agent-batch-mine-blocked";
      manager.requestShutdown(agentName, false);

      expect(manager.getShutdownState(agentName)).toBe("draining");
      expect(manager.isAllowedToolDuringShutdown("batch_mine")).toBe(false);
    });

    it("logout allowed during draining", () => {
      const agentName = "agent-logout-ok";
      manager.requestShutdown(agentName, false);

      expect(manager.getShutdownState(agentName)).toBe("draining");
      expect(manager.isAllowedToolDuringShutdown("logout")).toBe(true);
    });

    it("all 11 allowed tools are correctly identified", () => {
      const expectedAllowedTools = [
        "write_diary",
        "read_diary",
        "write_doc",
        "read_doc",
        "captains_log_add",
        "captains_log_list",
        "write_report",
        "read_report",
        "search_memory",
        "search_captain_logs",
        "logout",
      ];

      const allowedTools = manager.getAllowedToolsDuringShutdown();
      expect(allowedTools.length).toBe(11);

      for (const tool of expectedAllowedTools) {
        expect(allowedTools).toContain(tool);
      }
    });

    it("case-sensitive tool matching", () => {
      expect(manager.isAllowedToolDuringShutdown("write_diary")).toBe(true);
      expect(manager.isAllowedToolDuringShutdown("Write_Diary")).toBe(false);
      expect(manager.isAllowedToolDuringShutdown("WRITE_DIARY")).toBe(false);
    });
  });

  describe("Test 4: Cannot transition if not waiting", () => {
    it("cannot transition from none state", () => {
      const agentName = "agent-transition-none";

      const success = manager.transitionToDraining(agentName);
      expect(success).toBe(false);
      expect(manager.getShutdownState(agentName)).toBe("none");
    });

    it("cannot transition from draining state", () => {
      const agentName = "agent-transition-draining";

      manager.requestShutdown(agentName, false);
      expect(manager.getShutdownState(agentName)).toBe("draining");

      const success = manager.transitionToDraining(agentName);
      expect(success).toBe(false);
      expect(manager.getShutdownState(agentName)).toBe("draining");
    });

    it("cannot transition from stopped state", () => {
      const agentName = "agent-transition-stopped";

      manager.requestShutdown(agentName, false);
      manager.completeShutdown(agentName);
      expect(manager.getShutdownState(agentName)).toBe("none");

      const success = manager.transitionToDraining(agentName);
      expect(success).toBe(false);
      expect(manager.getShutdownState(agentName)).toBe("none");
    });

    it("can only transition once from shutdown_waiting", () => {
      const agentName = "agent-transition-once";

      manager.requestShutdown(agentName, true);
      expect(manager.getShutdownState(agentName)).toBe("shutdown_waiting");

      // First transition succeeds
      const success1 = manager.transitionToDraining(agentName);
      expect(success1).toBe(true);
      expect(manager.getShutdownState(agentName)).toBe("draining");

      // Second transition fails
      const success2 = manager.transitionToDraining(agentName);
      expect(success2).toBe(false);
      expect(manager.getShutdownState(agentName)).toBe("draining");
    });

    it("state does not change on failed transition", () => {
      const agentName = "agent-state-unchanged";

      manager.requestShutdown(agentName, false);
      const stateBeforeAttempt = manager.getShutdownState(agentName);

      manager.transitionToDraining(agentName);

      expect(manager.getShutdownState(agentName)).toBe(stateBeforeAttempt);
    });
  });

  describe("Test 5: Multiple agents independent", () => {
    it("Agent1 shutting down does not affect Agent2", () => {
      const agent1 = "agent-shutdown-1";
      const agent2 = "agent-active-2";

      // Agent1 starts shutdown
      manager.requestShutdown(agent1, false, "Shutdown requested");
      expect(manager.getShutdownState(agent1)).toBe("draining");

      // Agent2 should be unaffected
      expect(manager.getShutdownState(agent2)).toBe("none");
      expect(manager.isShuttingDown(agent2)).toBe(false);
    });

    it("Agent1 in draining does not restrict Agent2 tools", () => {
      const agent1 = "agent-drain-1";
      const agent2 = "agent-unrestricted-2";

      // Agent1 in draining
      manager.requestShutdown(agent1, false);
      expect(manager.getShutdownState(agent1)).toBe("draining");

      // Agent2 should still have full access (tool restrictions are per-agent)
      // The manager itself doesn't maintain per-agent tool restrictions,
      // but we verify the state is independent
      expect(manager.getShutdownState(agent2)).toBe("none");
      expect(manager.isShuttingDown(agent2)).toBe(false);
    });

    it("clearing Agent1 shutdown does not affect Agent2", () => {
      const agent1 = "agent-clear-1";
      const agent2 = "agent-waiting-2";

      // Both agents in shutdown with different states
      manager.requestShutdown(agent1, false);
      manager.requestShutdown(agent2, true);

      expect(manager.getShutdownState(agent1)).toBe("draining");
      expect(manager.getShutdownState(agent2)).toBe("shutdown_waiting");

      // Clear Agent1
      manager.clearShutdownState(agent1);

      // Agent1 cleared, Agent2 unaffected
      expect(manager.getShutdownState(agent1)).toBe("none");
      expect(manager.getShutdownState(agent2)).toBe("shutdown_waiting");
    });

    it("five agents with independent states", () => {
      const agents = [
        "agent-1",
        "agent-2",
        "agent-3",
        "agent-4",
        "agent-5",
      ];

      // Set different states for each
      manager.requestShutdown(agents[0], true); // shutdown_waiting
      manager.requestShutdown(agents[1], false); // draining
      manager.requestShutdown(agents[2], false);
      manager.completeShutdown(agents[2]); // stopped
      manager.requestShutdown(agents[3], true);
      manager.transitionToDraining(agents[3]); // draining (was waiting)
      // agents[4] stays in 'none'

      // Verify each maintains its own state
      expect(manager.getShutdownState(agents[0])).toBe("shutdown_waiting");
      expect(manager.getShutdownState(agents[1])).toBe("draining");
      expect(manager.getShutdownState(agents[2])).toBe("none");
      expect(manager.getShutdownState(agents[3])).toBe("draining");
      expect(manager.getShutdownState(agents[4])).toBe("none");

      // Clear one, others unaffected
      manager.clearShutdownState(agents[0]);
      expect(manager.getShutdownState(agents[0])).toBe("none");
      expect(manager.getShutdownState(agents[1])).toBe("draining");
      expect(manager.getShutdownState(agents[2])).toBe("none");
      expect(manager.getShutdownState(agents[3])).toBe("draining");
    });

    it("getAgentsInShutdown returns correct subset", () => {
      const inShutdown = ["agent-in-1", "agent-in-2"];
      const notShutdown = ["agent-out-1", "agent-out-2"];
      const completed = "agent-completed";

      // Add to shutdown
      manager.requestShutdown(inShutdown[0], true);
      manager.requestShutdown(inShutdown[1], false);
      manager.requestShutdown(completed, false);
      manager.completeShutdown(completed); // clears to 'none', no longer in shutdown

      // notShutdown agents stay in 'none'

      const agents = manager.getAgentsInShutdown();

      expect(agents.length).toBe(2);
      for (const agent of inShutdown) {
        expect(agents).toContain(agent);
      }
      for (const agent of notShutdown) {
        expect(agents).not.toContain(agent);
      }
      expect(agents).not.toContain(completed);
    });

    it("getAgentsWaitingForBattle returns only shutdown_waiting", () => {
      const waiting = ["agent-wait-1", "agent-wait-2"];
      const notWaiting = ["agent-drain-1", "agent-stopped-1"];

      manager.requestShutdown(waiting[0], true);
      manager.requestShutdown(waiting[1], true);
      manager.requestShutdown(notWaiting[0], false); // draining
      manager.requestShutdown(notWaiting[1], false);
      manager.completeShutdown(notWaiting[1]); // stopped

      const waitingAgents = manager.getAgentsWaitingForBattle();

      expect(waitingAgents.length).toBe(2);
      expect(waitingAgents).toContain(waiting[0]);
      expect(waitingAgents).toContain(waiting[1]);
      expect(waitingAgents).not.toContain(notWaiting[0]);
      expect(waitingAgents).not.toContain(notWaiting[1]);
    });
  });

  describe("Additional Integration Scenarios", () => {
    it("agent can be re-shutdown after clearing", () => {
      const agentName = "agent-restart";

      // First shutdown cycle
      manager.requestShutdown(agentName, false);
      manager.completeShutdown(agentName);
      manager.clearShutdownState(agentName);

      expect(manager.getShutdownState(agentName)).toBe("none");

      // Second shutdown cycle
      manager.requestShutdown(agentName, false);
      expect(manager.getShutdownState(agentName)).toBe("draining");
    });

    it("shutdown message includes all allowed tools", () => {
      const message = manager.getShutdownMessage();

      const allowedTools = manager.getAllowedToolsDuringShutdown();
      for (const tool of allowedTools) {
        expect(message).toContain(tool);
      }

      expect(message).toContain("Shutdown requested");
      expect(message).toContain("cleanup tools");
      expect(message).toContain("logout");
      expect(message).toContain("Do not make any game actions");
    });

    it("switching from battle to non-battle shutdown", () => {
      const agentName = "agent-switch-battle";

      // Initially request as non-battle
      let state = manager.requestShutdown(agentName, false);
      expect(state).toBe("draining");

      // Override with battle shutdown
      state = manager.requestShutdown(agentName, true);
      expect(state).toBe("shutdown_waiting");
      expect(manager.getShutdownState(agentName)).toBe("shutdown_waiting");
    });

    it("reason parameter is optional", () => {
      const agentName = "agent-no-reason";

      // Should work without reason
      expect(() => {
        manager.requestShutdown(agentName, false);
      }).not.toThrow();

      expect(manager.getShutdownState(agentName)).toBe("draining");
    });

    it("singleton pattern maintains state across calls", () => {
      const manager1 = getSessionShutdownManager();
      const manager2 = getSessionShutdownManager();

      expect(manager1).toBe(manager2);

      manager1.requestShutdown("shared-agent", false);
      expect(manager2.getShutdownState("shared-agent")).toBe("draining");
    });

    it("shutdown message is consistent", () => {
      const msg1 = manager.getShutdownMessage();
      const msg2 = manager.getShutdownMessage();

      expect(msg1).toBe(msg2);
    });

    it("isShuttingDown covers all non-none states", () => {
      const agentName = "agent-is-shutting-down";

      // none → false
      expect(manager.isShuttingDown(agentName)).toBe(false);

      // draining → true
      manager.requestShutdown(agentName, false);
      expect(manager.isShuttingDown(agentName)).toBe(true);

      // complete → clears to none → false (shutdown complete, no longer in shutdown state)
      manager.completeShutdown(agentName);
      expect(manager.isShuttingDown(agentName)).toBe(false);
    });

    it("getAllowedToolsDuringShutdown returns new array each time", () => {
      const tools1 = manager.getAllowedToolsDuringShutdown();
      const tools2 = manager.getAllowedToolsDuringShutdown();

      expect(tools1).not.toBe(tools2);
      expect(tools1).toEqual(tools2);

      // Mutation of one shouldn't affect the other
      tools1.push("fake_tool");
      expect(tools2).not.toContain("fake_tool");
    });
  });
});
