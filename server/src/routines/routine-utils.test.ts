import { describe, expect, it } from "bun:test";
import { getCargoUtilization, getStatusState, getStatPct, parseCargoItems, extractDemandItems, extractItemIdAliases, resolveSellable, parseTextTable, itemNameToId, checkCombat } from "./routine-utils.js";

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

describe("routine-utils: checkCombat", () => {
  it("detects battle_started in the { result } envelope from execute()", () => {
    expect(checkCombat({ result: { battle_started: true } })).toBe(true);
    expect(checkCombat({ result: { event: { type: "battle_started" } } })).toBe(true);
  });

  it("detects battle_started on an already-unwrapped result (withRetry closures unwrap resp.result)", () => {
    // Regression: navigate_home/explore_and_mine pass the unwrapped jump result;
    // checkCombat used to only look one level down and always returned false.
    expect(checkCombat({ battle_started: true })).toBe(true);
    expect(checkCombat({ event: { type: "battle_started" } })).toBe(true);
  });

  it("detects combat_detected error code and returns false otherwise", () => {
    expect(checkCombat({ error: { code: "combat_detected" } })).toBe(true);
    expect(checkCombat({ result: { status: "arrived" } })).toBe(false);
    expect(checkCombat({ status: "arrived" })).toBe(false);
    expect(checkCombat(undefined)).toBe(false);
    expect(checkCombat("jumped")).toBe(false);
  });
});

describe("routine-utils: extractItemIdAliases", () => {
  it("maps every row's id and name-slug to the canonical id, ignoring category", () => {
    const aliases = extractItemIdAliases(ANALYZE_MARKET_TEXT);
    // opportunity rows are excluded from extractDemandItems but included here
    expect(aliases.get("titanium_alloy")).toBe("titanium_alloy");
    expect(aliases.get("shield_emitter")).toBe("shield_emitter");
  });

  it("resolves a name-slug alias to the canonical id when they differ", () => {
    const text =
      "Trading insights at X:\n" +
      "priority\tcategory\titem\titem_id\tinsight\n" +
      "100\topportunity\tMining Laser I\tmining_laser_1\tArbitrage route";
    const aliases = extractItemIdAliases(text);
    expect(aliases.get("mining_laser_i")).toBe("mining_laser_1");
    expect(aliases.get("mining_laser_1")).toBe("mining_laser_1");
  });

  it("returns empty for non-text market data", () => {
    expect(extractItemIdAliases({ market: [] }).size).toBe(0);
    expect(extractItemIdAliases(undefined).size).toBe(0);
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

const GET_STATUS_TEXT =
  "Rust Vane [solarian] | 54,877,005cr | Sirius\n" +
  "Ship: Compendium (compendium) | Hull: 480/480 | Shield: 225/225 | Armor: 22 | Speed: 1\n" +
  "Fuel: 253/350 | Cargo: 629/655 | CPU: 27/32 | Power: 49/80\n" +
  "Docked at: sirius_observatory_station";

describe("routine-utils: getCargoUtilization (v0.417.3 text)", () => {
  it("reads Cargo: U/C from a get_status dashboard string", () => {
    const util = getCargoUtilization(GET_STATUS_TEXT);
    expect(util).not.toBeNull();
    expect(util?.used).toBe(629);
    expect(util?.capacity).toBe(655);
    expect(util?.freeSpace).toBe(26);
    expect(util?.pctFull).toBeCloseTo(96.03, 1);
  });

  it("reads it through the {result: string} execute() wrapper", () => {
    expect(getCargoUtilization({ result: GET_STATUS_TEXT })?.used).toBe(629);
  });

  it("returns null for get_cargo's unreliable 0/0 header", () => {
    expect(getCargoUtilization(GET_CARGO_TEXT)).toBeNull();
  });

  it("still reads legacy JSON shapes", () => {
    expect(getCargoUtilization({ used: 110, capacity: 100 })?.freeSpace).toBe(0);
    expect(getCargoUtilization({ result: { used: 10, capacity: 40 } })?.pctFull).toBeCloseTo(25);
  });
});

describe("routine-utils: extractDemandItems (v0.417.3 text)", () => {
  it("includes demand + sell_here + supply_imbalance, excludes opportunity", () => {
    const demand = extractDemandItems(ANALYZE_MARKET_TEXT);
    expect(demand.has("liquid_hydrogen")).toBe(true);  // demand
    expect(demand.has("shield_emitter")).toBe(true);   // sell_here
    expect(demand.has("power_cell")).toBe(true);       // supply_imbalance = unfilled buy orders (sell target)
    expect(demand.has("titanium_alloy")).toBe(false);  // opportunity (cross-station hint, not buy-demand)
  });

  it("still parses legacy JSON demand array", () => {
    const demand = extractDemandItems({ demand: [{ item_id: "iron_ore" }, { id: "gold_ore" }] });
    expect(demand.has("iron_ore")).toBe(true);
    expect(demand.has("gold_ore")).toBe(true);
  });

  it("aliases demand by name-slug → canonical id so cargo with a non-canonical id joins AND sells with the real id", () => {
    // Market row: real id "mining_laser_1" but name "Mining Laser I" → slug
    // "mining_laser_i". Cargo (parsed from name) would carry "mining_laser_i".
    const text =
      "Trading insights at X:\n" +
      "priority\tcategory\titem\titem_id\tinsight\n" +
      "100\tdemand\tMining Laser I\tmining_laser_1\twants to buy";
    const demand = extractDemandItems(text);
    expect(demand.has("mining_laser_1")).toBe(true);          // real id
    expect(demand.has("mining_laser_i")).toBe(true);          // name-slug alias → matches cargo slug
    expect(demand.get("mining_laser_i")).toBe("mining_laser_1"); // alias resolves to CANONICAL id

    // resolveSellable rewrites the slugged cargo id to the canonical market id,
    // so the multi_sell/create_sell_order payload uses the real game id.
    const cargo = [{ item_id: "mining_laser_i", quantity: 2 }, { item_id: "not_wanted", quantity: 1 }];
    const sellable = resolveSellable(cargo, demand);
    expect(sellable).toEqual([{ item_id: "mining_laser_1", quantity: 2 }]);
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

describe("routine-utils: getStatusState", () => {
  it("maps a v2 TEXT dashboard string into { player, ship }", () => {
    const { player, ship } = getStatusState(GET_STATUS_TEXT);
    // player: dock line is the only location signal — exposed as both fields.
    expect(player?.current_poi).toBe("sirius_observatory_station");
    expect(player?.docked_at_base).toBe("sirius_observatory_station");
    expect(player?.username).toBe("Rust Vane");
    expect(player?.credits).toBe(54877005);
    // ship: fuel/hull/cargo readable by getStatPct + getCargoUtilization.
    expect(ship?.fuel).toBe(253);
    expect(ship?.max_fuel).toBe(350);
    expect(ship?.fuel_max).toBe(350);
    expect(ship?.hull).toBe(480);
    expect(ship?.cargo_used).toBe(629);
    expect(ship?.cargo_capacity).toBe(655);
    // Downstream helpers accept the mapped ship as-is.
    expect(getStatPct(ship, "fuel")).toBeCloseTo((253 / 350) * 100);
    expect(getStatPct(ship, "hull")).toBeCloseTo(100);
  });

  it("leaves current_poi/docked_at_base undefined when in space (no Docked at: line)", () => {
    const inSpace =
      "Rust Vane [solarian] | 55,541,553cr | Proxima Centauri\n" +
      "Fuel: 328/350 | Cargo: 21/655 | CPU: 27/32 | Power: 49/80\n" +
      "Hull: 480/480 | Shield: 225/225 | Armor: 22 | Speed: 1";
    const { player, ship } = getStatusState(inSpace);
    expect(player?.current_poi).toBeUndefined();
    expect(player?.docked_at_base).toBeUndefined();
    expect(ship?.fuel).toBe(328);
  });

  it("passes an already-object { player, ship } through unchanged (legacy/test JSON)", () => {
    const obj = {
      player: { current_poi: "nexus_core", credits: 1000 },
      ship: { fuel: 50, fuel_max: 100 },
    };
    const state = getStatusState(obj);
    expect(state.player).toBe(obj.player);
    expect(state.ship).toBe(obj.ship);
  });

  it("returns {} for garbage / unparseable input", () => {
    expect(getStatusState(undefined)).toEqual({});
    expect(getStatusState(null)).toEqual({});
    expect(getStatusState(42)).toEqual({});
    // object without player/ship keys → {} (degrade like the old cast).
    expect(getStatusState({ foo: "bar" })).toEqual({});
  });
});
