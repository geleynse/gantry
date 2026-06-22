import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createDatabase, closeDb, getDb } from "./database.js";
import { recordStationObservation, getStationsForItem, recordPrice } from "./market-history.js";

describe("recordStationObservation + getStationsForItem", () => {
  beforeEach(() => {
    createDatabase(":memory:");
  });
  afterEach(() => {
    closeDb();
  });

  it("records a station observation that getStationsForItem returns", () => {
    recordStationObservation({ item_id: "shield_emitter", station: "Confederacy Central Command", price: 3650, type: "sell" });
    const rows = getStationsForItem("shield_emitter");
    expect(rows.length).toBe(1);
    expect(rows[0].poi_id).toBe("Confederacy Central Command"); // unresolved name kept as-is
    expect(rows[0].price).toBe(3650);
    expect(rows[0].type).toBe("sell");
  });

  it("resolves a station NAME to its poi_id via galaxy_pois", () => {
    getDb()
      .prepare("INSERT INTO galaxy_pois (id, name, system) VALUES (?, ?, ?)")
      .run("ccc_station", "Confederacy Central Command", "sol");
    recordStationObservation({ item_id: "shield_emitter", station: "Confederacy Central Command", price: 3650, type: "sell" });
    const rows = getStationsForItem("shield_emitter");
    expect(rows[0].poi_id).toBe("ccc_station");
  });

  it("excludes faction-global (global:%) rows from getStationsForItem", () => {
    recordPrice({ item_id: "shield_emitter", poi_id: "global:solarian", price: 9999, type: "sell" });
    recordStationObservation({ item_id: "shield_emitter", station: "Real Station", price: 3000, type: "sell" });
    const rows = getStationsForItem("shield_emitter");
    expect(rows.length).toBe(1);
    expect(rows[0].poi_id).toBe("Real Station");
  });

  it("orders SELL opportunities best (highest) price first", () => {
    recordStationObservation({ item_id: "gold", station: "Low Station", price: 100, type: "sell" });
    recordStationObservation({ item_id: "gold", station: "High Station", price: 500, type: "sell" });
    const rows = getStationsForItem("gold", { type: "sell" });
    expect(rows.map((r) => r.poi_id)).toEqual(["High Station", "Low Station"]);
  });

  it("orders BUY opportunities best (lowest) price first", () => {
    recordStationObservation({ item_id: "ore", station: "Pricey", price: 50, type: "buy" });
    recordStationObservation({ item_id: "ore", station: "Cheap", price: 10, type: "buy" });
    const rows = getStationsForItem("ore", { type: "buy" });
    expect(rows.map((r) => r.poi_id)).toEqual(["Cheap", "Pricey"]);
  });

  it("filters out observations older than the freshness window", () => {
    getDb()
      .prepare("INSERT INTO market_history (item_id, poi_id, price, type, timestamp) VALUES (?, ?, ?, ?, datetime('now', '-100 hours'))")
      .run("stale_item", "Old Station", 42, "sell");
    expect(getStationsForItem("stale_item", { maxAgeHours: 72 }).length).toBe(0);
    expect(getStationsForItem("stale_item", { maxAgeHours: 200 }).length).toBe(1);
  });

  it("returns only the most recent observation per station+type", () => {
    recordStationObservation({ item_id: "x", station: "S", price: 100, type: "sell" });
    recordStationObservation({ item_id: "x", station: "S", price: 200, type: "sell" });
    const rows = getStationsForItem("x");
    expect(rows.length).toBe(1);
    expect(rows[0].price).toBe(200); // latest wins
  });
});
