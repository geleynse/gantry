/**
 * Tests for LeaderboardTable component.
 * Fleet agent highlighting, rank badges, skeleton state.
 */
import { describe, it, expect, mock } from "bun:test";
import { render, screen } from "@testing-library/react";
import { LeaderboardTable, LeaderboardSkeleton } from "../leaderboard-table";
import type { LeaderboardEntry } from "@/hooks/use-leaderboard";
import { FleetStatusProvider } from "@/hooks/use-fleet-status";
import { MockEventSource } from "@/test/setup";
import { createMockFleetStatus } from "@/test/mocks/agents";
import { act } from "@testing-library/react";
import React from "react";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
//
// Provide the agent-color palette without touching `useAgentNames` — the
// component now reads the live fleet roster via the FleetStatusProvider that
// wraps each render below. We avoid `mock.module` for hooks because
// bun:test mocks leak across the whole test process and break unrelated
// component tests (e.g. outbound-review-ui).

mock.module("@/lib/utils", () => ({
  AGENT_COLORS: {
    "drifter-gale": "#88c0d0",
    "sable-thorn": "#bf616a",
    "rust-vane": "#d08770",
    "cinder-wake": "#ebcb8b",
    "lumen-shoal": "#a3be8c",
  },
}));

// ---------------------------------------------------------------------------
// Render helper — wraps the LeaderboardTable in a FleetStatusProvider and
// pushes a mock fleet snapshot through SSE so `useAgentNames()` returns the
// expected fleet roster.
// ---------------------------------------------------------------------------

const FLEET_AGENTS = [
  "drifter-gale",
  "sable-thorn",
  "rust-vane",
  "cinder-wake",
  "lumen-shoal",
];

function renderWithFleet(ui: React.ReactElement) {
  // Reset MockEventSource so we can grab the new instance unambiguously
  MockEventSource.instances = [];
  const result = render(<FleetStatusProvider>{ui}</FleetStatusProvider>);
  // Push a fleet snapshot so useAgentNames() returns FLEET_AGENTS
  act(() => {
    const es = MockEventSource.instances[0];
    if (es) {
      es.simulateOpen();
      es.simulateMessage(
        "status",
        createMockFleetStatus(FLEET_AGENTS.map((name) => ({ name }))),
      );
    }
  });
  return result;
}

// ---------------------------------------------------------------------------
// Fixtures — matches upstream API shape: { rank, username, empire, value }
// ---------------------------------------------------------------------------

// Real leaderboard responses key the value column by stat name (e.g.
// "total_wealth"). Tests mirror that — the column is the same key that
// the live API returns.
function makeEntries(): LeaderboardEntry[] {
  return [
    { rank: 1, username: "Drifter Gale", total_wealth: 999999 },
    { rank: 2, username: "Sable Thorn", total_wealth: 750000 },
    { rank: 3, username: "some_random_player", total_wealth: 500000 },
    { rank: 4, username: "Cinder Wake", total_wealth: 300000 },
    { rank: 5, username: "another_player", total_wealth: 100000 },
  ];
}

// ---------------------------------------------------------------------------
// Tests: LeaderboardTable
// ---------------------------------------------------------------------------

describe("LeaderboardTable", () => {
  it("renders all entry names", () => {
    render(
      <LeaderboardTable entries={makeEntries()} statKey="total_wealth" statLabel="Total Wealth" />
    );
    expect(screen.getByText("Drifter Gale")).toBeInTheDocument();
    expect(screen.getByText("Sable Thorn")).toBeInTheDocument();
    expect(screen.getByText("some_random_player")).toBeInTheDocument();
  });

  it("shows fleet pill badge for fleet agents", () => {
    renderWithFleet(
      <LeaderboardTable entries={makeEntries()} statKey="total_wealth" statLabel="Total Wealth" />
    );
    const fleetBadges = screen.getAllByText("fleet");
    expect(fleetBadges.length).toBe(3);
  });

  it("does not show fleet badge for non-fleet players", () => {
    const entries: LeaderboardEntry[] = [
      { rank: 1, username: "some_random_player", value: 100 },
    ];
    render(
      <LeaderboardTable entries={entries} statKey="total_wealth" statLabel="Total Wealth" />
    );
    expect(screen.queryByText("fleet")).not.toBeInTheDocument();
  });

  it("shows rank badge for each entry", () => {
    render(
      <LeaderboardTable entries={makeEntries()} statKey="total_wealth" statLabel="Total Wealth" />
    );
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  it("shows stat column header label", () => {
    render(
      <LeaderboardTable entries={makeEntries()} statKey="total_wealth" statLabel="Total Wealth" />
    );
    expect(screen.getByText("Total Wealth")).toBeInTheDocument();
  });

  it("formats currency stats with thousands separators and cr suffix", () => {
    const entries: LeaderboardEntry[] = [
      { rank: 1, username: "Alice", total_wealth: 1000000 },
    ];
    render(
      <LeaderboardTable entries={entries} statKey="total_wealth" statLabel="Total Wealth" />
    );
    // Currency-keyed stats (total_wealth, ship_value, …) get a "cr" suffix appended.
    expect(screen.getByText("1,000,000 cr")).toBeInTheDocument();
  });

  it("formats non-currency stats without cr suffix", () => {
    const entries: LeaderboardEntry[] = [
      { rank: 1, username: "Alice", ships_destroyed: 1234 },
    ];
    render(
      <LeaderboardTable entries={entries} statKey="ships_destroyed" statLabel="Ships Destroyed" />
    );
    expect(screen.getByText("1,234")).toBeInTheDocument();
  });

  it("does not match partial currency keys (e.g. max_value_per_ton)", () => {
    // Regression test for the CURRENCY_LABEL_RE regex bug — `max_value_per_ton`
    // is NOT currency, even though "value" is in the name. The new allowlist
    // is exact-match.
    const entries: LeaderboardEntry[] = [
      { rank: 1, username: "Alice", max_value_per_ton: 5000 },
    ];
    render(
      <LeaderboardTable
        entries={entries}
        statKey="max_value_per_ton"
        statLabel="Max Value / Ton"
      />
    );
    expect(screen.getByText("5,000")).toBeInTheDocument();
    expect(screen.queryByText("5,000 cr")).not.toBeInTheDocument();
  });

  it("renders 'No data available' when entries is empty", () => {
    render(
      <LeaderboardTable entries={[]} statKey="total_wealth" statLabel="Total Wealth" />
    );
    expect(screen.getByText("No data available")).toBeInTheDocument();
  });

  it("renders skeleton (not table) when loading=true and entries is empty", () => {
    render(
      <LeaderboardTable entries={[]} statKey="total_wealth" statLabel="Total Wealth" loading />
    );
    expect(screen.queryByText("No data available")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });

  it("supports custom nameKey for factions/exchanges", () => {
    const entries: LeaderboardEntry[] = [
      { rank: 1, name: "The Syndicate", value: 5000 },
    ];
    render(
      <LeaderboardTable
        entries={entries}
        statKey="total_wealth"
        statLabel="Score"
        nameKey="name"
      />
    );
    expect(screen.getByText("The Syndicate")).toBeInTheDocument();
  });

  it("detects fleet agents case-insensitively", () => {
    const entries: LeaderboardEntry[] = [
      { rank: 1, username: "Drifter Gale", value: 1 },
    ];
    renderWithFleet(
      <LeaderboardTable entries={entries} statKey="total_wealth" statLabel="Wealth" />
    );
    expect(screen.getByText("fleet")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests: LeaderboardSkeleton
// ---------------------------------------------------------------------------

describe("LeaderboardSkeleton", () => {
  it("renders a table structure", () => {
    render(<LeaderboardSkeleton />);
    expect(document.querySelector("table")).not.toBeNull();
  });

  it("renders the specified number of skeleton rows", () => {
    render(<LeaderboardSkeleton rows={5} />);
    const rows = document.querySelectorAll("tbody tr");
    expect(rows.length).toBe(5);
  });

  it("defaults to 10 rows", () => {
    render(<LeaderboardSkeleton />);
    const rows = document.querySelectorAll("tbody tr");
    expect(rows.length).toBe(10);
  });
});
