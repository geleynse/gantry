import { describe, it, expect, afterEach } from "bun:test";
import type { AgentShutdownState } from "../shared/types.js";
import { createDatabase, getDb, closeDb } from "./database.js";
import {
  getShutdownState,
  setShutdownState,
  clearShutdownState,
  getAgentsInShutdown,
  getShutdownRecord,
  getAgentsWaitingForBattle,
} from "./agent-shutdown-db.js";

describe("agent-shutdown-db", () => {
  afterEach(() => {
    closeDb();
  });

  it("returns 'none' for agents without shutdown state", () => {
    createDatabase(":memory:");

    const state = getShutdownState("unknown-agent");
    expect(state).toBe("none");
  });

  it("sets and retrieves shutdown state", () => {
    createDatabase(":memory:");

    setShutdownState("agent-1", "shutdown_waiting", "Waiting for battle");
    const state = getShutdownState("agent-1");

    expect(state).toBe("shutdown_waiting");
  });

  it("updates existing shutdown state", () => {
    createDatabase(":memory:");

    setShutdownState("agent-2", "shutdown_waiting", "Initial state");
    setShutdownState("agent-2", "draining", "Updated state");

    const state = getShutdownState("agent-2");
    expect(state).toBe("draining");
  });

  it("sets shutdown state without reason", () => {
    createDatabase(":memory:");

    setShutdownState("agent-3", "stopped");
    const state = getShutdownState("agent-3");

    expect(state).toBe("stopped");
  });

  it("clears shutdown state", () => {
    createDatabase(":memory:");

    setShutdownState("agent-4", "shutdown_waiting");
    clearShutdownState("agent-4");

    const state = getShutdownState("agent-4");
    expect(state).toBe("none");
  });

  it("gets all agents in shutdown", () => {
    createDatabase(":memory:");

    setShutdownState("agent-a", "shutdown_waiting", "Waiting");
    setShutdownState("agent-b", "draining", "Draining");
    setShutdownState("agent-c", "stopped", "Stopped");

    const agents = getAgentsInShutdown();

    expect(agents.length).toBe(3);
    expect(agents.some((a) => a.agent_name === "agent-a")).toBe(true);
    expect(agents.some((a) => a.agent_name === "agent-b")).toBe(true);
    expect(agents.some((a) => a.agent_name === "agent-c")).toBe(true);
  });

  it("excludes 'none' state from agents in shutdown", () => {
    createDatabase(":memory:");

    setShutdownState("agent-x", "shutdown_waiting", "Active");
    setShutdownState("agent-y", "none", "No state");

    const agents = getAgentsInShutdown();

    expect(agents.length).toBe(1);
    expect(agents[0].agent_name).toBe("agent-x");
  });

  it("retrieves full shutdown record by agent name", () => {
    createDatabase(":memory:");

    setShutdownState("agent-5", "draining", "In progress");
    const record = getShutdownRecord("agent-5");

    expect(record).not.toBeNull();
    expect(record?.agent_name).toBe("agent-5");
    expect(record?.state).toBe("draining");
    expect(record?.reason).toBe("In progress");
    expect(record?.created_at).toBeDefined();
    expect(record?.updated_at).toBeDefined();
  });

  it("returns null for agent without shutdown state", () => {
    createDatabase(":memory:");

    const record = getShutdownRecord("nonexistent");
    expect(record).toBeNull();
  });

  it("returns null for agent with 'none' state", () => {
    createDatabase(":memory:");

    // Insert a record with 'none' state directly
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO agent_shutdown_state (agent_name, state, created_at, updated_at) VALUES (?, ?, ?, ?)`
    ).run("agent-none", "none", now, now);

    const record = getShutdownRecord("agent-none");
    expect(record).toBeNull();
  });

  it("gets agents waiting for battle", () => {
    createDatabase(":memory:");

    setShutdownState("agent-wait-1", "shutdown_waiting");
    setShutdownState("agent-wait-2", "shutdown_waiting");
    setShutdownState("agent-drain-1", "draining");

    const waitingAgents = getAgentsWaitingForBattle();

    expect(waitingAgents.length).toBe(2);
    expect(waitingAgents).toContain("agent-wait-1");
    expect(waitingAgents).toContain("agent-wait-2");
    expect(waitingAgents).not.toContain("agent-drain-1");
  });

  it("returns empty array when no agents waiting for battle", () => {
    createDatabase(":memory:");

    setShutdownState("agent-1", "draining");
    setShutdownState("agent-2", "stopped");

    const waitingAgents = getAgentsWaitingForBattle();

    expect(waitingAgents.length).toBe(0);
  });

  it("enforces valid shutdown state values", () => {
    createDatabase(":memory:");

    // Test each valid state
    const validStates = ["none", "shutdown_waiting", "draining", "stopped"];

    for (const state of validStates) {
      const agentName = `agent-${state}`;
      setShutdownState(agentName, state as AgentShutdownState);
      const retrieved = getShutdownState(agentName);
      expect(retrieved).toBe(state as AgentShutdownState);
    }
  });

  it("preserves created_at timestamp on updates", async () => {
    createDatabase(":memory:");

    setShutdownState("agent-ts", "shutdown_waiting", "First");
    const firstRecord = getShutdownRecord("agent-ts");
    const originalCreatedAt = firstRecord?.created_at;

    // Small delay to ensure timestamp would be different
    await new Promise((resolve) => setTimeout(resolve, 10));

    setShutdownState("agent-ts", "draining", "Updated");
    const secondRecord = getShutdownRecord("agent-ts");
    const updatedCreatedAt = secondRecord?.created_at;

    expect(originalCreatedAt).toBe(updatedCreatedAt);
  });

  it("updates updated_at timestamp on changes", async () => {
    createDatabase(":memory:");

    setShutdownState("agent-update", "shutdown_waiting");
    const firstRecord = getShutdownRecord("agent-update");
    const firstUpdatedAt = firstRecord?.updated_at;

    // Small delay to ensure timestamp is different
    await new Promise((resolve) => setTimeout(resolve, 50));

    setShutdownState("agent-update", "draining");
    const secondRecord = getShutdownRecord("agent-update");
    const secondUpdatedAt = secondRecord?.updated_at;

    expect(secondUpdatedAt).not.toBe(firstUpdatedAt);
    expect((secondUpdatedAt ?? '') > (firstUpdatedAt ?? '')).toBe(true);
  });

  it("handles multiple agents independently", () => {
    createDatabase(":memory:");

    const agents = [
      { name: "sable-thorn", state: "shutdown_waiting" as const },
      { name: "drifter-gale", state: "draining" as const },
      { name: "cinder-wake", state: "stopped" as const },
      { name: "cascade", state: "shutdown_waiting" as const },
    ];

    for (const { name, state } of agents) {
      setShutdownState(name, state);
    }

    // Verify each agent's state independently
    for (const { name, state } of agents) {
      const retrieved = getShutdownState(name);
      expect(retrieved).toBe(state);
    }

    // Verify all in shutdown
    const allInShutdown = getAgentsInShutdown();
    expect(allInShutdown.length).toBe(4);

    // Verify waiting agents
    const waiting = getAgentsWaitingForBattle();
    expect(waiting.length).toBe(2);
    expect(waiting).toContain("sable-thorn");
    expect(waiting).toContain("cascade");
  });

  it("clears only the specified agent", () => {
    createDatabase(":memory:");

    setShutdownState("agent-1", "shutdown_waiting");
    setShutdownState("agent-2", "draining");
    clearShutdownState("agent-1");

    const state1 = getShutdownState("agent-1");
    const state2 = getShutdownState("agent-2");

    expect(state1).toBe("none");
    expect(state2).toBe("draining");
  });

  it("handles clearing non-existent agent gracefully", () => {
    createDatabase(":memory:");

    expect(() => {
      clearShutdownState("nonexistent-agent");
    }).not.toThrow();
  });

  it("allows null reason", () => {
    createDatabase(":memory:");

    setShutdownState("agent-null-reason", "stopped", undefined);
    const record = getShutdownRecord("agent-null-reason");

    expect(record?.reason).toBeNull();
  });

  it("allows empty string reason", () => {
    createDatabase(":memory:");

    setShutdownState("agent-empty-reason", "stopped", "");
    const record = getShutdownRecord("agent-empty-reason");

    expect(record?.reason).toBe("");
  });

  it("returns agents in shutdown ordered by updated_at desc", async () => {
    createDatabase(":memory:");

    setShutdownState("agent-first", "shutdown_waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
    setShutdownState("agent-second", "draining");
    await new Promise((resolve) => setTimeout(resolve, 10));
    setShutdownState("agent-third", "stopped");

    const agents = getAgentsInShutdown();

    expect(agents[0].agent_name).toBe("agent-third");
    expect(agents[1].agent_name).toBe("agent-second");
    expect(agents[2].agent_name).toBe("agent-first");
  });
});
