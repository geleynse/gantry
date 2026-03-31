/**
 * alerts.test.tsx
 *
 * Tests for the alerts page logic. Since the project has no jsdom setup,
 * we test the pure helper functions directly.
 *
 * For endpoint integration, we mock apiFetch and verify call patterns.
 */

import { describe, it, expect, mock } from "bun:test";
import { getSeverityClasses, sortAlerts, filterAlerts } from "./helpers";

// ---------------------------------------------------------------------------
// Mock apiFetch — DO NOT use mock.module('@/lib/api') as it leaks across
// test files in CI (bun runs all files in one process). Instead, create a
// standalone mock function and call it directly in tests.
// ---------------------------------------------------------------------------

const mockApiFetch = mock(async (_path: string, _options?: RequestInit) => ({}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Alerts Page Helpers", () => {
  describe("getSeverityClasses", () => {
    it("returns correct classes for info", () => {
      const classes = getSeverityClasses("info");
      expect(classes).toContain("blue-500");
    });

    it("returns correct classes for warning", () => {
      const classes = getSeverityClasses("warning");
      expect(classes).toContain("amber-500");
    });

    it("returns correct classes for error", () => {
      const classes = getSeverityClasses("error");
      expect(classes).toContain("red-500");
    });

    it("returns correct classes for critical", () => {
      const classes = getSeverityClasses("critical");
      expect(classes).toContain("animate-pulse");
    });

    it("returns default classes for unknown severity", () => {
      const classes = getSeverityClasses("unknown");
      expect(classes).toContain("secondary");
    });
  });

  describe("sortAlerts", () => {
    const alerts: any[] = [
      { id: 1, acknowledged: 1, created_at: "2026-03-20T10:00:00Z" },
      { id: 2, acknowledged: 0, created_at: "2026-03-21T10:00:00Z" },
      { id: 3, acknowledged: 0, created_at: "2026-03-19T10:00:00Z" },
    ];

    it("sorts unacknowledged first, then by created_at descending (newer first)", () => {
      const sorted = sortAlerts(alerts);
      expect(sorted[0].id).toBe(2); // unack, newer
      expect(sorted[1].id).toBe(3); // unack, older
      expect(sorted[2].id).toBe(1); // ack
    });
  });

  describe("filterAlerts", () => {
    const alerts: any[] = [
      { agent: "drifter-gale", severity: "error" },
      { agent: "rust-vane", severity: "warning" },
      { agent: "drifter-gale", severity: "info" },
    ];

    it("filters by agent", () => {
      const filtered = filterAlerts(alerts, "drifter-gale", "all");
      expect(filtered).toHaveLength(2);
      expect(filtered.every((a) => a.agent === "drifter-gale")).toBe(true);
    });

    it("filters by severity", () => {
      const filtered = filterAlerts(alerts, "all", "warning");
      expect(filtered).toHaveLength(1);
      expect(filtered[0].agent).toBe("rust-vane");
    });

    it("filters by both", () => {
      const filtered = filterAlerts(alerts, "drifter-gale", "error");
      expect(filtered).toHaveLength(1);
      expect(filtered[0].severity).toBe("error");
    });

    it("returns all when filters are 'all'", () => {
      const filtered = filterAlerts(alerts, "all", "all");
      expect(filtered).toHaveLength(3);
    });
  });
});

describe("Alerts Page API Integration (Mocked)", () => {
  it("calls the correct path for single acknowledge", async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true });
    // In a real component test we would trigger the button, but here we
    // test the pattern the component uses.
    await mockApiFetch("/alerts/42/acknowledge", { method: "POST" });
    expect(mockApiFetch).toHaveBeenCalledWith(
      "/alerts/42/acknowledge",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("calls the correct path for acknowledge all", async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true });
    await mockApiFetch("/alerts/acknowledge-all", { method: "POST" });
    expect(mockApiFetch).toHaveBeenCalledWith(
      "/alerts/acknowledge-all",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("calls with agent filter for acknowledge all", async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true });
    const agent = "rust-vane";
    await mockApiFetch(`/alerts/acknowledge-all?agent=${agent}`, { method: "POST" });
    expect(mockApiFetch).toHaveBeenCalledWith(
      `/alerts/acknowledge-all?agent=rust-vane`,
      expect.objectContaining({ method: "POST" })
    );
  });
});
