import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createDatabase, closeDb } from "./database.js";
import {
  createOrder,
  listOrders,
  getPendingOrders,
  markDelivered,
  createReport,
  getCommsLog,
} from "./comms-db.js";

describe("comms-db", () => {
  beforeEach(() => {
    createDatabase(":memory:");
  });

  afterEach(() => {
    closeDb();
  });

  it("creates and lists orders", () => {
    createOrder({ message: "Mine iron in SOL-001" });
    const orders = listOrders();
    expect(orders).toHaveLength(1);
    expect(orders[0].message).toBe("Mine iron in SOL-001");
    expect(orders[0].priority).toBe("normal");
    expect(orders[0].target_agent).toBeNull();
  });

  it("creates targeted order", () => {
    createOrder({ message: "Go to SOL-002", target_agent: "drifter-gale" });
    const orders = listOrders();
    expect(orders[0].target_agent).toBe("drifter-gale");
  });

  it("gets pending orders for agent (fleet-wide)", () => {
    createOrder({ message: "Fleet order" });
    const pending = getPendingOrders("drifter-gale");
    expect(pending).toHaveLength(1);
    expect(pending[0].message).toBe("Fleet order");
  });

  it("gets pending orders for agent (targeted)", () => {
    createOrder({ message: "For gale only", target_agent: "drifter-gale" });
    createOrder({ message: "For sable only", target_agent: "sable-thorn" });
    const pending = getPendingOrders("drifter-gale");
    expect(pending).toHaveLength(1);
    expect(pending[0].message).toBe("For gale only");
  });

  it("marks order delivered and removes from pending", () => {
    const id = createOrder({ message: "Test order" });
    markDelivered(id, "drifter-gale");
    const pending = getPendingOrders("drifter-gale");
    expect(pending).toHaveLength(0);
  });

  it("same order still pending for other agents", () => {
    const id = createOrder({ message: "Fleet order" });
    markDelivered(id, "drifter-gale");
    const pending = getPendingOrders("sable-thorn");
    expect(pending).toHaveLength(1);
  });

  it("skips expired orders", () => {
    createOrder({ message: "Expired", expires_at: "2020-01-01T00:00:00Z" });
    const pending = getPendingOrders("drifter-gale");
    expect(pending).toHaveLength(0);
  });

  it("creates report and shows in comms log", () => {
    createReport("drifter-gale", "Mined 500 iron in SOL-001");
    const log = getCommsLog();
    expect(log).toHaveLength(1);
    expect(log[0].type).toBe("report");
    expect(log[0].agent).toBe("drifter-gale");
  });

  it("order creation also logged in comms log", () => {
    createOrder({ message: "Fleet order" });
    const log = getCommsLog();
    expect(log.some((e: any) => e.type === "order")).toBe(true);
  });

  it("delivery also logged in comms log", () => {
    const id = createOrder({ message: "Test" });
    markDelivered(id, "drifter-gale");
    const log = getCommsLog();
    expect(log.some((e: any) => e.type === "delivery")).toBe(true);
  });
});
