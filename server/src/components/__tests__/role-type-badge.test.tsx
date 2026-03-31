/**
 * Tests for roleType badge display in FleetStatusSummary and AgentCard (#213a).
 */

import { describe, it, expect } from "bun:test";
import { render, screen } from "@testing-library/react";
import { FleetStatusSummary } from "../fleet-status-summary";
import { createMockAgentStatus } from "@/test/mocks/agents";

describe("FleetStatusSummary — role distribution (#213a)", () => {
  it("shows role distribution when agents have roleType", () => {
    const agents = [
      createMockAgentStatus({ name: "a", roleType: "trader", state: "running", llmRunning: true, proxySessionActive: true }),
      createMockAgentStatus({ name: "b", roleType: "combat", state: "running", llmRunning: true, proxySessionActive: true }),
      createMockAgentStatus({ name: "c", roleType: "trader", state: "running", llmRunning: true, proxySessionActive: true }),
    ];
    render(<FleetStatusSummary agents={agents} />);
    // Role distribution line should show "Roles:" label
    expect(screen.getByText("Roles:")).toBeInTheDocument();
    // Should show "2× trader"
    expect(screen.getByText("2× trader")).toBeInTheDocument();
    // Should show "1× combat"
    expect(screen.getByText("1× combat")).toBeInTheDocument();
  });

  it("does not show role distribution when agents have no roleType", () => {
    const agents = [
      createMockAgentStatus({ name: "a", state: "running", llmRunning: true, proxySessionActive: true }),
    ];
    render(<FleetStatusSummary agents={agents} />);
    expect(screen.queryByText("Roles:")).not.toBeInTheDocument();
  });

  it("handles mixed roleType and no-roleType agents", () => {
    const agents = [
      createMockAgentStatus({ name: "a", roleType: "explorer" }),
      createMockAgentStatus({ name: "b" }), // no roleType
    ];
    render(<FleetStatusSummary agents={agents} />);
    expect(screen.getByText("Roles:")).toBeInTheDocument();
    expect(screen.getByText("1× explorer")).toBeInTheDocument();
  });
});
