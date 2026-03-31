import { describe, it, expect, afterEach } from "bun:test";
import { createDatabase, closeDb } from "./database.js";
import {
  createAlert,
  getPendingAlerts,
  getAlertCount,
  acknowledgeAlert,
  acknowledgeAll,
} from "./alerts-db.js";

describe("alerts-db", () => {
  afterEach(() => {
    closeDb();
  });

  it("creates an alert and returns an id", () => {
    createDatabase(":memory:");
    const id = createAlert("drifter-gale", "warning", "navigation", "Stuck in transit");
    expect(typeof id).toBe("number");
    expect(id).toBeGreaterThan(0);
  });

  it("getPendingAlerts returns unacknowledged alerts", () => {
    createDatabase(":memory:");
    createAlert("drifter-gale", "info", null, "Low on fuel");
    createAlert("rust-vane", "error", "trade", "Sell failed");
    const all = getPendingAlerts();
    expect(all.length).toBe(2);
    expect(all.every(a => a.acknowledged === 0)).toBe(true);
  });

  it("getPendingAlerts filters by agent", () => {
    createDatabase(":memory:");
    createAlert("drifter-gale", "info", null, "Alert A");
    createAlert("rust-vane", "warning", null, "Alert B");
    const forGale = getPendingAlerts("drifter-gale");
    expect(forGale.length).toBe(1);
    expect(forGale[0].agent).toBe("drifter-gale");
  });

  it("getAlertCount returns unacknowledged count", () => {
    createDatabase(":memory:");
    expect(getAlertCount()).toBe(0);
    createAlert("drifter-gale", "critical", null, "Ship destroyed");
    createAlert("drifter-gale", "info", null, "All good");
    expect(getAlertCount()).toBe(2);
  });

  it("acknowledgeAlert marks single alert acknowledged", () => {
    createDatabase(":memory:");
    const id = createAlert("sable-thorn", "error", "combat", "Ambushed");
    const ok = acknowledgeAlert(id, "operator");
    expect(ok).toBe(true);
    expect(getPendingAlerts().length).toBe(0);
    expect(getAlertCount()).toBe(0);
  });

  it("acknowledgeAlert returns false for unknown id", () => {
    createDatabase(":memory:");
    const ok = acknowledgeAlert(9999, "operator");
    expect(ok).toBe(false);
  });

  it("acknowledgeAlert returns false if already acknowledged", () => {
    createDatabase(":memory:");
    const id = createAlert("sable-thorn", "warning", null, "Low hull");
    acknowledgeAlert(id, "operator");
    const second = acknowledgeAlert(id, "operator");
    expect(second).toBe(false);
  });

  it("acknowledgeAll bulk-acknowledges all alerts", () => {
    createDatabase(":memory:");
    createAlert("agent-a", "info", null, "Msg 1");
    createAlert("agent-b", "warning", null, "Msg 2");
    createAlert("agent-a", "error", null, "Msg 3");
    const count = acknowledgeAll();
    expect(count).toBe(3);
    expect(getAlertCount()).toBe(0);
  });

  it("acknowledgeAll filters by agent", () => {
    createDatabase(":memory:");
    createAlert("agent-a", "info", null, "Msg 1");
    createAlert("agent-b", "warning", null, "Msg 2");
    const count = acknowledgeAll("agent-a");
    expect(count).toBe(1);
    expect(getAlertCount()).toBe(1);
    expect(getPendingAlerts("agent-b").length).toBe(1);
  });

  it("alert has correct fields", () => {
    createDatabase(":memory:");
    const id = createAlert("lumen-shoal", "critical", "navigation", "Stranded");
    const alerts = getPendingAlerts();
    expect(alerts.length).toBe(1);
    const alert = alerts[0];
    expect(alert.id).toBe(id);
    expect(alert.agent).toBe("lumen-shoal");
    expect(alert.severity).toBe("critical");
    expect(alert.category).toBe("navigation");
    expect(alert.message).toBe("Stranded");
    expect(alert.acknowledged).toBe(0);
    expect(alert.acknowledged_by).toBeNull();
    expect(alert.acknowledged_at).toBeNull();
    expect(typeof alert.created_at).toBe("string");
  });

  it("null category is stored and returned as null", () => {
    createDatabase(":memory:");
    createAlert("cinder-wake", "info", null, "No category");
    const alerts = getPendingAlerts();
    expect(alerts[0].category).toBeNull();
  });
});
