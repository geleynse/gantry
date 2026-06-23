import { describe, expect, it } from "bun:test";
import { getCargoUtilization, parseCargoItems, extractDemandItems, parseTextTable, itemNameToId } from "./routine-utils.js";

// Live formats captured from game v0.426.5 (v0.417.3 formatted-output change).
const GET_CARGO_TEXT =
  "Cargo: 0/0 used, 0 available.\nitem\tqty\tsize\nPower Cell\t35\t2\nShield Emitter\t6\t2\nTrade Authenticator\t18\t1\n\nCredits: 257,951cr";

const ANALYZE_MARKET_TEXT =
  "Trading insights at Market Prime Exchange (trading skill 19):\n" +
  "priority\tcategory\titem\titem_id\tinsight\n" +
  "26988187\tdemand\tLiquid Hydrogen\tliquid_hydrogen\tStation pays 120cr\n" +
  "15000000\tsell_here\tShield Emitter\tshield_emitter\tGood sell price\n" +
  "12000000\tsupply_imbalance\tPower Cell\tpower_cell\tStation oversupplied\n" +
  "9000000\topportunity\tTitanium Alloy\ttitanium_alloy\tArbitrage route";

describe("routine-utils: parseTextTable", () => {
  it("skips preamble, reads header, stops at the trailing non-tab line", () => {
    const { headers, rows } = parseTextTable(GET_CARGO_TEXT);
    expect(headers).toEqual(["item", "qty", "size"]);
    expect(rows.length).toBe(3); // Credits line excluded
    expect(rows[0]).toEqual(["Power Cell", "35", "2"]);
  });

  it("returns empty for text with no table", () => {
    expect(parseTextTable("Cargo is empty.").rows).toEqual([]);
  });
});

describe("routine-utils: itemNameToId", () => {
  it("inverts the id→name transform", () => {
    expect(itemNameToId("Power Cell")).toBe("power_cell");
    expect(itemNameToId("Trade Authenticator")).toBe("trade_authenticator");
    expect(itemNameToId("Shield Booster II")).toBe("shield_booster_ii");
  });
});

describe("routine-utils: parseCargoItems (v0.417.3 text)", () => {
  it("parses the formatted text table into id+quantity items", () => {
    const items = parseCargoItems(GET_CARGO_TEXT);
    expect(items).toEqual([
      { item_id: "power_cell", quantity: 35 },
      { item_id: "shield_emitter", quantity: 6 },
      { item_id: "trade_authenticator", quantity: 18 },
    ]);
  });

  it("still parses legacy JSON shapes", () => {
    expect(parseCargoItems({ cargo: [{ item_id: "iron_ore", quantity: 5 }] }))
      .toEqual([{ item_id: "iron_ore", quantity: 5 }]);
    expect(parseCargoItems({ items: [{ id: "gold_ore", qty: 3 }] }))
      .toEqual([{ item_id: "gold_ore", quantity: 3 }]);
  });

  it("returns empty for empty cargo text", () => {
    expect(parseCargoItems("Cargo: 0/0 used, 0 available.\n\nCredits: 6cr")).toEqual([]);
  });

  it("ids parsed from cargo match ids parsed from the market (sell-cycle join)", () => {
    const cargoIds = new Set(parseCargoItems(GET_CARGO_TEXT).map((c) => c.item_id));
    const demand = extractDemandItems(ANALYZE_MARKET_TEXT);
    // shield_emitter is in cargo AND a sell target → the join must hit.
    expect(cargoIds.has("shield_emitter")).toBe(true);
    expect(demand.has("shield_emitter")).toBe(true);
  });
});

describe("routine-utils: extractDemandItems (v0.417.3 text)", () => {
  it("includes demand + sell_here, excludes supply/opportunity", () => {
    const demand = extractDemandItems(ANALYZE_MARKET_TEXT);
    expect(demand.has("liquid_hydrogen")).toBe(true);  // demand
    expect(demand.has("shield_emitter")).toBe(true);   // sell_here
    expect(demand.has("power_cell")).toBe(false);      // supply_imbalance
    expect(demand.has("titanium_alloy")).toBe(false);  // opportunity
  });

  it("still parses legacy JSON demand array", () => {
    const demand = extractDemandItems({ demand: [{ item_id: "iron_ore" }, { id: "gold_ore" }] });
    expect(demand.has("iron_ore")).toBe(true);
    expect(demand.has("gold_ore")).toBe(true);
  });
});

describe("routine-utils: getCargoUtilization", () => {
  it("parses valid get_cargo response", () => {
    const cargo = {
      used: 50,
      capacity: 100,
      cargo: [{ item_id: "ore", quantity: 50, size: 1 }]
    };
    const util = getCargoUtilization(cargo);
    expect(util).toEqual({
      used: 50,
      capacity: 100,
      freeSpace: 50,
      pctFull: 50
    });
  });

  it("handles result wrapper from ctx.client.execute()", () => {
    const resp = {
      result: {
        used: 25,
        capacity: 100
      }
    };
    const util = getCargoUtilization(resp);
    expect(util?.used).toBe(25);
    expect(util?.pctFull).toBe(25);
  });

  it("handles mining tool response shape (cargo_after)", () => {
    const resp = {
      cargo_after: {
        used: 90,
        max: 100
      }
    };
    const util = getCargoUtilization(resp);
    expect(util).toEqual({
      used: 90,
      capacity: 100,
      freeSpace: 10,
      pctFull: 90
    });
  });

  it("returns null for invalid data", () => {
    expect(getCargoUtilization(null)).toBeNull();
    expect(getCargoUtilization(undefined)).toBeNull();
    expect(getCargoUtilization("not an object")).toBeNull();
    expect(getCargoUtilization({})).toBeNull();
  });

  it("returns null if capacity is 0", () => {
    const util = getCargoUtilization({ used: 10, capacity: 0 });
    expect(util).toBeNull();
  });

  it("calculates free space correctly", () => {
    const util = getCargoUtilization({ used: 110, capacity: 100 });
    expect(util?.freeSpace).toBe(0);
    expect(util?.pctFull).toBeCloseTo(110);
  });
});
