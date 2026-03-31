import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { createDatabase, closeDb } from "../../services/database.js";
import {
  SessionShutdownManager,
  getSessionShutdownManager,
  resetSessionShutdownManager,
} from "../session-shutdown.js";

describe("SessionShutdownManager", () => {
  let manager: SessionShutdownManager;

  beforeEach(() => {
    createDatabase(":memory:");
    resetSessionShutdownManager();
    manager = new SessionShutdownManager();
  });

  afterEach(() => {
    closeDb();
  });

  describe("getAllowedToolsDuringShutdown", () => {
    it("returns array of allowed shutdown tools", () => {
      const tools = manager.getAllowedToolsDuringShutdown();

      expect(tools).toBeInstanceOf(Array);
      expect(tools.length).toBeGreaterThan(0);
      expect(tools).toContain("write_diary");
      expect(tools).toContain("read_diary");
      expect(tools).toContain("write_doc");
      expect(tools).toContain("read_doc");
      expect(tools).toContain("captains_log_add");
      expect(tools).toContain("captains_log_list");
      expect(tools).toContain("write_report");
      expect(tools).toContain("read_report");
      expect(tools).toContain("search_memory");
      expect(tools).toContain("logout");
    });

    it("returns 10 allowed tools", () => {
      const tools = manager.getAllowedToolsDuringShutdown();
      expect(tools.length).toBe(10);
    });

    it("returns a new array each call (not shared reference)", () => {
      const tools1 = manager.getAllowedToolsDuringShutdown();
      const tools2 = manager.getAllowedToolsDuringShutdown();

      expect(tools1).not.toBe(tools2);
      expect(tools1).toEqual(tools2);
    });
  });

  describe("isAllowedToolDuringShutdown", () => {
    it("returns true for allowed tools", () => {
      const allowedTools = ["write_diary", "read_diary", "logout", "search_memory"];

      for (const tool of allowedTools) {
        expect(manager.isAllowedToolDuringShutdown(tool)).toBe(true);
      }
    });

    it("returns false for disallowed tools", () => {
      const disallowedTools = [
        "scan_and_attack",
        "multi_sell",
        "jump_route",
        "mine",
        "trade",
      ];

      for (const tool of disallowedTools) {
        expect(manager.isAllowedToolDuringShutdown(tool)).toBe(false);
      }
    });

    it("is case-sensitive", () => {
      expect(manager.isAllowedToolDuringShutdown("write_diary")).toBe(true);
      expect(manager.isAllowedToolDuringShutdown("Write_Diary")).toBe(false);
      expect(manager.isAllowedToolDuringShutdown("WRITE_DIARY")).toBe(false);
    });
  });

  describe("getShutdownMessage", () => {
    it("returns instruction message for agent", () => {
      const message = manager.getShutdownMessage();

      expect(typeof message).toBe("string");
      expect(message.length).toBeGreaterThan(0);
      expect(message).toContain("Shutdown requested");
      expect(message).toContain("cleanup tools");
      expect(message).toContain("logout");
    });

    it("includes all allowed tools in message", () => {
      const message = manager.getShutdownMessage();
      const tools = manager.getAllowedToolsDuringShutdown();

      for (const tool of tools) {
        expect(message).toContain(tool);
      }
    });

    it("warns against game actions", () => {
      const message = manager.getShutdownMessage();

      expect(message).toContain("Do not make any game actions");
    });
  });

  describe("getShutdownState", () => {
    it("returns 'none' for agents without shutdown state", () => {
      const state = manager.getShutdownState("unknown-agent");
      expect(state).toBe("none");
    });

    it("returns shutdown state after setting it", () => {
      manager.requestShutdown("agent-1", false);
      const state = manager.getShutdownState("agent-1");

      expect(state).toBe("draining");
    });

    it("returns updated state after transitions", () => {
      manager.requestShutdown("agent-2", true);
      expect(manager.getShutdownState("agent-2")).toBe("shutdown_waiting");

      manager.transitionToDraining("agent-2");
      expect(manager.getShutdownState("agent-2")).toBe("draining");

      manager.completeShutdown("agent-2");
      expect(manager.getShutdownState("agent-2")).toBe("none");
    });
  });

  describe("isShuttingDown", () => {
    it("returns false for agents without shutdown state", () => {
      expect(manager.isShuttingDown("unknown-agent")).toBe(false);
    });

    it("returns true when agent is in shutdown_waiting", () => {
      manager.requestShutdown("agent-1", true);
      expect(manager.isShuttingDown("agent-1")).toBe(true);
    });

    it("returns true when agent is in draining", () => {
      manager.requestShutdown("agent-2", false);
      expect(manager.isShuttingDown("agent-2")).toBe(true);
    });

    it("returns false when agent completes shutdown", () => {
      manager.requestShutdown("agent-3", false);
      manager.completeShutdown("agent-3");
      expect(manager.isShuttingDown("agent-3")).toBe(false);
    });

    it("returns false after clearing shutdown state", () => {
      manager.requestShutdown("agent-4", false);
      expect(manager.isShuttingDown("agent-4")).toBe(true);

      manager.clearShutdownState("agent-4");
      expect(manager.isShuttingDown("agent-4")).toBe(false);
    });
  });

  describe("requestShutdown", () => {
    it("sets state to 'shutdown_waiting' when in battle", () => {
      const state = manager.requestShutdown("agent-1", true, "Battle in progress");
      expect(state).toBe("shutdown_waiting");
      expect(manager.getShutdownState("agent-1")).toBe("shutdown_waiting");
    });

    it("sets state to 'draining' when not in battle", () => {
      const state = manager.requestShutdown("agent-2", false, "Not in battle");
      expect(state).toBe("draining");
      expect(manager.getShutdownState("agent-2")).toBe("draining");
    });

    it("returns the target state that was set", () => {
      const state1 = manager.requestShutdown("agent-a", true);
      expect(state1).toBe("shutdown_waiting");

      const state2 = manager.requestShutdown("agent-b", false);
      expect(state2).toBe("draining");
    });

    it("accepts optional reason parameter", () => {
      const state = manager.requestShutdown("agent-3", false, "User requested");
      expect(state).toBe("draining");
    });

    it("works without reason parameter", () => {
      const state = manager.requestShutdown("agent-4", true);
      expect(state).toBe("shutdown_waiting");
    });

    it("overwrites previous shutdown state", () => {
      manager.requestShutdown("agent-5", true);
      expect(manager.getShutdownState("agent-5")).toBe("shutdown_waiting");

      manager.requestShutdown("agent-5", false);
      expect(manager.getShutdownState("agent-5")).toBe("draining");
    });
  });

  describe("transitionToDraining", () => {
    it("transitions from shutdown_waiting to draining", () => {
      manager.requestShutdown("agent-1", true);
      expect(manager.getShutdownState("agent-1")).toBe("shutdown_waiting");

      const success = manager.transitionToDraining("agent-1");

      expect(success).toBe(true);
      expect(manager.getShutdownState("agent-1")).toBe("draining");
    });

    it("returns true on successful transition", () => {
      manager.requestShutdown("agent-2", true);
      const result = manager.transitionToDraining("agent-2");
      expect(result).toBe(true);
    });

    it("returns false when agent not in waiting state", () => {
      manager.requestShutdown("agent-3", false);
      const result = manager.transitionToDraining("agent-3");
      expect(result).toBe(false);
    });

    it("returns false when agent not in shutdown at all", () => {
      const result = manager.transitionToDraining("unknown-agent");
      expect(result).toBe(false);
    });

    it("does not change state when transition fails", () => {
      manager.requestShutdown("agent-4", false);
      manager.transitionToDraining("agent-4");

      expect(manager.getShutdownState("agent-4")).toBe("draining");

      const result = manager.transitionToDraining("agent-4");
      expect(result).toBe(false);
      expect(manager.getShutdownState("agent-4")).toBe("draining");
    });

    it("can be called multiple times only on first waiting state", () => {
      manager.requestShutdown("agent-5", true);
      expect(manager.transitionToDraining("agent-5")).toBe(true);

      // Second call should fail - no longer in waiting state
      expect(manager.transitionToDraining("agent-5")).toBe(false);
    });
  });

  describe("completeShutdown", () => {
    it("clears state to 'none'", () => {
      manager.requestShutdown("agent-1", false);
      manager.completeShutdown("agent-1");

      expect(manager.getShutdownState("agent-1")).toBe("none");
    });

    it("clears state to none from any previous state", () => {
      // From draining
      manager.requestShutdown("agent-a", false);
      manager.completeShutdown("agent-a");
      expect(manager.getShutdownState("agent-a")).toBe("none");

      // From shutdown_waiting
      manager.requestShutdown("agent-b", true);
      manager.completeShutdown("agent-b");
      expect(manager.getShutdownState("agent-b")).toBe("none");
    });

    it("does not return a value", () => {
      manager.requestShutdown("agent-1", false);
      const result = manager.completeShutdown("agent-1");
      expect(result).toBeUndefined();
    });
  });

  describe("clearShutdownState", () => {
    it("removes shutdown state completely", () => {
      manager.requestShutdown("agent-1", false);
      expect(manager.isShuttingDown("agent-1")).toBe(true);

      manager.clearShutdownState("agent-1");
      expect(manager.isShuttingDown("agent-1")).toBe(false);
      expect(manager.getShutdownState("agent-1")).toBe("none");
    });

    it("works on any shutdown state", () => {
      manager.requestShutdown("agent-a", true);
      manager.clearShutdownState("agent-a");
      expect(manager.getShutdownState("agent-a")).toBe("none");

      manager.requestShutdown("agent-b", false);
      manager.clearShutdownState("agent-b");
      expect(manager.getShutdownState("agent-b")).toBe("none");
    });

    it("is idempotent - can clear non-existent state", () => {
      expect(() => {
        manager.clearShutdownState("nonexistent-agent");
      }).not.toThrow();
    });
  });

  describe("getAgentsInShutdown", () => {
    it("returns empty array when no agents in shutdown", () => {
      const agents = manager.getAgentsInShutdown();
      expect(agents).toEqual([]);
    });

    it("returns array of agent names in shutdown", () => {
      manager.requestShutdown("agent-1", false);
      manager.requestShutdown("agent-2", true);
      manager.requestShutdown("agent-3", false);

      const agents = manager.getAgentsInShutdown();

      expect(agents.length).toBe(3);
      expect(agents).toContain("agent-1");
      expect(agents).toContain("agent-2");
      expect(agents).toContain("agent-3");
    });

    it("returns all non-'none' states", () => {
      manager.requestShutdown("agent-wait", true);
      manager.requestShutdown("agent-drain", false);
      manager.requestShutdown("agent-completed", false);
      manager.completeShutdown("agent-completed");

      const agents = manager.getAgentsInShutdown();

      expect(agents.length).toBe(2);
      expect(agents).toContain("agent-wait");
      expect(agents).toContain("agent-drain");
      expect(agents).not.toContain("agent-completed");
    });

    it("excludes agents after clearing state", () => {
      manager.requestShutdown("agent-1", false);
      manager.requestShutdown("agent-2", false);

      expect(manager.getAgentsInShutdown().length).toBe(2);

      manager.clearShutdownState("agent-1");

      const agents = manager.getAgentsInShutdown();
      expect(agents.length).toBe(1);
      expect(agents).toContain("agent-2");
      expect(agents).not.toContain("agent-1");
    });

    it("returns agent names, not full records", () => {
      manager.requestShutdown("sable-thorn", false);

      const agents = manager.getAgentsInShutdown();

      expect(agents[0]).toBe("sable-thorn");
      expect(typeof agents[0]).toBe("string");
    });
  });

  describe("getAgentsWaitingForBattle", () => {
    it("returns empty array when no agents waiting", () => {
      const agents = manager.getAgentsWaitingForBattle();
      expect(agents).toEqual([]);
    });

    it("returns agents in shutdown_waiting state only", () => {
      manager.requestShutdown("agent-wait-1", true);
      manager.requestShutdown("agent-wait-2", true);
      manager.requestShutdown("agent-drain", false);

      const agents = manager.getAgentsWaitingForBattle();

      expect(agents.length).toBe(2);
      expect(agents).toContain("agent-wait-1");
      expect(agents).toContain("agent-wait-2");
      expect(agents).not.toContain("agent-drain");
    });

    it("excludes agents that transition to draining", () => {
      manager.requestShutdown("agent-wait", true);
      expect(manager.getAgentsWaitingForBattle()).toContain("agent-wait");

      manager.transitionToDraining("agent-wait");
      expect(manager.getAgentsWaitingForBattle()).not.toContain("agent-wait");
    });

    it("excludes stopped agents", () => {
      manager.requestShutdown("agent-stop", true);
      manager.completeShutdown("agent-stop");

      expect(manager.getAgentsWaitingForBattle()).not.toContain("agent-stop");
    });
  });

  describe("State transitions - full lifecycle", () => {
    it("supports full lifecycle: none → shutdown_waiting → draining → none", () => {
      const agent = "lifecycle-agent";

      // Start: none
      expect(manager.getShutdownState(agent)).toBe("none");

      // Request shutdown during battle
      manager.requestShutdown(agent, true, "Battle started");
      expect(manager.getShutdownState(agent)).toBe("shutdown_waiting");
      expect(manager.isShuttingDown(agent)).toBe(true);

      // Transition when battle ends
      manager.transitionToDraining(agent);
      expect(manager.getShutdownState(agent)).toBe("draining");

      // Complete shutdown
      manager.completeShutdown(agent);
      expect(manager.getShutdownState(agent)).toBe("none");
      expect(manager.isShuttingDown(agent)).toBe(false);
    });

    it("supports shortcut: none → draining → none (no battle)", () => {
      const agent = "no-battle-agent";

      manager.requestShutdown(agent, false, "Graceful shutdown");
      expect(manager.getShutdownState(agent)).toBe("draining");

      manager.completeShutdown(agent);
      expect(manager.getShutdownState(agent)).toBe("none");
      expect(manager.isShuttingDown(agent)).toBe(false);
    });
  });

  describe("Singleton pattern", () => {
    it("getSessionShutdownManager returns same instance", () => {
      const instance1 = getSessionShutdownManager();
      const instance2 = getSessionShutdownManager();

      expect(instance1).toBe(instance2);
    });

    it("singleton instance works with real database", () => {
      const manager = getSessionShutdownManager();

      manager.requestShutdown("singleton-agent", false);
      expect(manager.getShutdownState("singleton-agent")).toBe("draining");

      manager.clearShutdownState("singleton-agent");
      expect(manager.getShutdownState("singleton-agent")).toBe("none");
    });
  });

  describe("Multiple agents - isolation", () => {
    it("manages multiple agents independently", () => {
      const agents = ["agent-1", "agent-2", "agent-3", "agent-4", "agent-5"];

      // Set different states for each
      manager.requestShutdown(agents[0], true); // shutdown_waiting
      manager.requestShutdown(agents[1], false); // draining
      manager.requestShutdown(agents[2], false);
      manager.completeShutdown(agents[2]); // none (cleared)
      manager.requestShutdown(agents[3], true);
      manager.transitionToDraining(agents[3]); // draining (was waiting)
      manager.requestShutdown(agents[4], false);

      // Verify each maintains its own state
      expect(manager.getShutdownState(agents[0])).toBe("shutdown_waiting");
      expect(manager.getShutdownState(agents[1])).toBe("draining");
      expect(manager.getShutdownState(agents[2])).toBe("none");
      expect(manager.getShutdownState(agents[3])).toBe("draining");
      expect(manager.getShutdownState(agents[4])).toBe("draining");

      // Clear one, others unaffected
      manager.clearShutdownState(agents[0]);
      expect(manager.getShutdownState(agents[0])).toBe("none");
      expect(manager.getShutdownState(agents[1])).toBe("draining");
    });
  });
});
