/**
 * Tests for TaxMonitor.
 * Mocks alerts-db to avoid touching the real database.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";

const mockCreateAlert = mock(() => 1);
const mockHasRecentAlert = mock(() => false);

mock.module("../services/alerts-db.js", () => ({
  createAlert: mockCreateAlert,
  hasRecentAlert: mockHasRecentAlert,
}));

// Import AFTER mocking
const { TaxMonitor } = await import("./tax-monitor.js");
import type { EmpireInfo } from "./empire-info-cache.js";

function makeEmpire(overrides: Partial<EmpireInfo> = {}): EmpireInfo {
  return {
    id: "solarian",
    name: "Solarian Empire",
    tax_rate_income: 0.1,
    tax_rate_sales: 0.05,
    tax_collection_active: false,
    citizenship_open: false,
    citizenship_requirements: "500 rep",
    fuel_surcharge: 0.02,
    repair_cost_modifier: 1.0,
    customs_fine_rate: 0.1,
    bounty_multiplier: 1.0,
    starting_credits: 1000,
    contraband: [],
    ...overrides,
  };
}

describe("TaxMonitor", () => {
  beforeEach(() => {
    mockCreateAlert.mockClear();
    mockHasRecentAlert.mockClear();
    mockHasRecentAlert.mockImplementation(() => false);
  });

  it("first check populates state without creating alerts", () => {
    const monitor = new TaxMonitor();
    monitor.check([makeEmpire({ tax_collection_active: false })]);
    expect(mockCreateAlert).not.toHaveBeenCalled();
  });

  it("no alert when tax stays false → false", () => {
    const monitor = new TaxMonitor();
    const empire = makeEmpire({ tax_collection_active: false });
    monitor.check([empire]);
    monitor.check([empire]);
    expect(mockCreateAlert).not.toHaveBeenCalled();
  });

  it("no alert when first check shows tax already active (cold start with active tax)", () => {
    const monitor = new TaxMonitor();
    // First call with tax_collection_active=true — prev is undefined, not false
    monitor.check([makeEmpire({ tax_collection_active: true })]);
    expect(mockCreateAlert).not.toHaveBeenCalled();
  });

  it("fires HIGH alert on false → true tax transition", () => {
    const monitor = new TaxMonitor();
    monitor.check([makeEmpire({ tax_collection_active: false })]);
    monitor.check([makeEmpire({ tax_collection_active: true })]);

    expect(mockCreateAlert).toHaveBeenCalledTimes(1);
    const [agent, severity, category, message] = mockCreateAlert.mock.calls[0];
    expect(agent).toBe("fleet");
    expect(severity).toBe("high");
    expect(category).toBe("tax_active:solarian");
    expect(message).toContain("TAX ACTIVATED");
    expect(message).toContain("Solarian Empire");
  });

  it("fires no duplicate alert within 24h window (hasRecentAlert returns true)", () => {
    mockHasRecentAlert.mockImplementation(() => true);

    const monitor = new TaxMonitor();
    monitor.check([makeEmpire({ tax_collection_active: false })]);
    monitor.check([makeEmpire({ tax_collection_active: true })]);

    expect(mockCreateAlert).not.toHaveBeenCalled();
  });

  it("fires MEDIUM alert on citizenship false → true transition", () => {
    const monitor = new TaxMonitor();
    monitor.check([makeEmpire({ citizenship_open: false })]);
    monitor.check([makeEmpire({ citizenship_open: true, citizenship_requirements: "500 rep" })]);

    expect(mockCreateAlert).toHaveBeenCalledTimes(1);
    const [agent, severity, category, message] = mockCreateAlert.mock.calls[0];
    expect(agent).toBe("fleet");
    expect(severity).toBe("medium");
    expect(category).toBe("citizenship_open:solarian");
    expect(message).toContain("CITIZENSHIP OPEN");
    expect(message).toContain("Solarian Empire");
    expect(message).toContain("500 rep");
  });

  it("no citizenship alert when first check already shows open", () => {
    const monitor = new TaxMonitor();
    // First call with citizenship_open=true — prev is undefined, not false
    monitor.check([makeEmpire({ citizenship_open: true })]);
    expect(mockCreateAlert).not.toHaveBeenCalled();
  });

  it("no duplicate citizenship alert within 24h", () => {
    mockHasRecentAlert.mockImplementation(() => true);

    const monitor = new TaxMonitor();
    monitor.check([makeEmpire({ citizenship_open: false })]);
    monitor.check([makeEmpire({ citizenship_open: true })]);

    expect(mockCreateAlert).not.toHaveBeenCalled();
  });

  it("fires both tax and citizenship alerts when both transition simultaneously", () => {
    const monitor = new TaxMonitor();
    monitor.check([makeEmpire({ tax_collection_active: false, citizenship_open: false })]);
    monitor.check([makeEmpire({ tax_collection_active: true, citizenship_open: true })]);

    expect(mockCreateAlert).toHaveBeenCalledTimes(2);
    const severities = mockCreateAlert.mock.calls.map((c) => c[1]);
    expect(severities).toContain("high");
    expect(severities).toContain("medium");
  });

  it("handles multiple empires independently", () => {
    const monitor = new TaxMonitor();
    const sol = makeEmpire({ id: "solarian", name: "Solarian", tax_collection_active: false });
    const void_ = makeEmpire({ id: "voidborn", name: "Voidborn", tax_collection_active: false });

    monitor.check([sol, void_]);

    // Only solarian transitions
    monitor.check([
      { ...sol, tax_collection_active: true },
      { ...void_, tax_collection_active: false },
    ]);

    expect(mockCreateAlert).toHaveBeenCalledTimes(1);
    const [, , category] = mockCreateAlert.mock.calls[0];
    expect(category).toBe("tax_active:solarian");
  });

  it("reset() clears state so next check is treated as cold start", () => {
    const monitor = new TaxMonitor();
    monitor.check([makeEmpire({ tax_collection_active: false })]);
    monitor.reset();

    // After reset, first call is again cold start — no alert
    monitor.check([makeEmpire({ tax_collection_active: true })]);
    expect(mockCreateAlert).not.toHaveBeenCalled();
  });
});
