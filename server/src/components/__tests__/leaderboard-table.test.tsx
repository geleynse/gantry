/**
 * Tests for LeaderboardTable component.
 * Fleet agent highlighting, rank badges, skeleton state.
 */
import { describe, it, expect, mock } from "bun:test";
import { render, screen } from "@testing-library/react";
import { LeaderboardTable, LeaderboardSkeleton } from "../leaderboard-table";
import type { LeaderboardEntry } from "@/hooks/use-leaderboard";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("@/lib/utils", () => ({
  AGENT_NAMES: ["drifter-gale", "sable-thorn", "rust-vane", "cinder-wake", "lumen-shoal"],
  AGENT_COLORS: {
    "drifter-gale": "#88c0d0",
    "sable-thorn": "#bf616a",
    "rust-vane": "#d08770",
    "cinder-wake": "#ebcb8b",
    "lumen-shoal": "#a3be8c",
  },
}));

// ---------------------------------------------------------------------------
// Fixtures — matches upstream API shape: { rank, username, empire, value }
// ---------------------------------------------------------------------------

function makeEntries(): LeaderboardEntry[] {
  return [
    { rank: 1, username: "Drifter Gale", value: 999999 },
    { rank: 2, username: "Sable Thorn", value: 750000 },
    { rank: 3, username: "some_random_player", value: 500000 },
    { rank: 4, username: "Cinder Wake", value: 300000 },
    { rank: 5, username: "another_player", value: 100000 },
  ];
}

// ---------------------------------------------------------------------------
// Tests: LeaderboardTable
// ---------------------------------------------------------------------------

describe("LeaderboardTable", () => {
  it("renders all entry names", () => {
    render(
      <LeaderboardTable entries={makeEntries()} statKey="value" statLabel="Total Wealth" />
    );
    expect(screen.getByText("Drifter Gale")).toBeInTheDocument();
    expect(screen.getByText("Sable Thorn")).toBeInTheDocument();
    expect(screen.getByText("some_random_player")).toBeInTheDocument();
  });

  it("shows fleet pill badge for fleet agents", () => {
    render(
      <LeaderboardTable entries={makeEntries()} statKey="value" statLabel="Total Wealth" />
    );
    const fleetBadges = screen.getAllByText("fleet");
    expect(fleetBadges.length).toBe(3);
  });

  it("does not show fleet badge for non-fleet players", () => {
    const entries: LeaderboardEntry[] = [
      { rank: 1, username: "some_random_player", value: 100 },
    ];
    render(
      <LeaderboardTable entries={entries} statKey="value" statLabel="Total Wealth" />
    );
    expect(screen.queryByText("fleet")).not.toBeInTheDocument();
  });

  it("shows rank badge for each entry", () => {
    render(
      <LeaderboardTable entries={makeEntries()} statKey="value" statLabel="Total Wealth" />
    );
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  it("shows stat column header label", () => {
    render(
      <LeaderboardTable entries={makeEntries()} statKey="value" statLabel="Total Wealth" />
    );
    expect(screen.getByText("Total Wealth")).toBeInTheDocument();
  });

  it("formats numbers with toLocaleString", () => {
    const entries: LeaderboardEntry[] = [
      { rank: 1, username: "Alice", value: 1000000 },
    ];
    render(
      <LeaderboardTable entries={entries} statKey="value" statLabel="Wealth" />
    );
    expect(screen.getByText("1,000,000")).toBeInTheDocument();
  });

  it("renders 'No data available' when entries is empty", () => {
    render(
      <LeaderboardTable entries={[]} statKey="value" statLabel="Total Wealth" />
    );
    expect(screen.getByText("No data available")).toBeInTheDocument();
  });

  it("renders skeleton (not table) when loading=true and entries is empty", () => {
    render(
      <LeaderboardTable entries={[]} statKey="value" statLabel="Total Wealth" loading />
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
        statKey="value"
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
    render(
      <LeaderboardTable entries={entries} statKey="value" statLabel="Wealth" />
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
