// game-text-parser.test.ts — unit tests for the single game-response TEXT parser.
//
// The whole point of centralizing every dashboard regex here is that schema drift
// breaks in EXACTLY one place, caught by these tests. Fixtures are the real live
// formats captured from the game (v0.417.3 formatted-output change onward), mirrored
// from routine-utils.test.ts / http-game-client-v2.test.ts.
import { describe, expect, it } from "bun:test";
import {
  parseTextTable,
  itemNameToId,
  parseCargoText,
  parseCargoUtilizationText,
  parseMarketDemandText,
  parseMarketAliasesText,
  parseGetStatusText,
} from "./game-text-parser.js";

// Live formats captured from game v0.426.5.
const GET_CARGO_TEXT =
  "Cargo: 0/0 used, 0 available.\nitem\tqty\tsize\nPower Cell\t35\t2\nShield Emitter\t6\t2\nTrade Authenticator\t18\t1\n\nCredits: 257,951cr";

const ANALYZE_MARKET_TEXT =
  "Trading insights at Market Prime Exchange (trading skill 19):\n" +
  "priority\tcategory\titem\titem_id\tinsight\n" +
  "26988187\tdemand\tLiquid Hydrogen\tliquid_hydrogen\tStation pays 120cr\n" +
  "15000000\tsell_here\tShield Emitter\tshield_emitter\tGood sell price\n" +
  "12000000\tsupply_imbalance\tPower Cell\tpower_cell\tStation oversupplied\n" +
  "9000000\topportunity\tTitanium Alloy\ttitanium_alloy\tArbitrage route";

const GET_STATUS_TEXT =
  "Rust Vane [solarian] | 54,877,005cr | Sirius\n" +
  "Ship: Compendium (compendium) | Hull: 480/480 | Shield: 225/225 | Armor: 22 | Speed: 1\n" +
  "Fuel: 253/350 | Cargo: 629/655 | CPU: 27/32 | Power: 49/80\n" +
  "Docked at: sirius_observatory_station";

const FULL_GET_STATUS = [
  "Drifter Gale [Drifter] | 12,345cr | Sol System",
  "",
  "Ship: Wanderer-class",
  "Hull: 95/100   Shield: 50/50   Armor: 25   Speed: 18",
  "Fuel: 80/120   Cargo: 14/40   CPU: 9/12   Power: 7/10",
  "",
  "Modules:",
  "id\tclass_id\tslot\tsize\twear",
  "mod-1\tlaser_mk2\tweapon_1\tmedium\t0%",
  "mod-2\tshield_booster\tutility_1\tsmall\t5%",
  "",
  "Cargo (2 items):",
  "item\tqty\tsize",
  "Gold Ore\t14\t1",
  "Iron Ore\t3\t1",
  "",
  "Skills (2):",
  "skill\tlevel\txp\tnext_level",
  "mining\t13\t478\t6885",
  "trading\t7\t120\t900",
  "",
  "Empire standings:",
  "empire\trep\tbaseline\tbounty",
  "solarian\t20\t20\t0",
  "drifter\t-5\t0\t150",
].join("\n");

describe("game-text-parser: parseTextTable", () => {
  it("skips preamble, reads header, stops at the trailing non-tab line", () => {
    const { headers, rows } = parseTextTable(GET_CARGO_TEXT);
    expect(headers).toEqual(["item", "qty", "size"]);
    expect(rows.length).toBe(3); // Credits line excluded
    expect(rows[0]).toEqual(["Power Cell", "35", "2"]);
  });

  it("returns empty for text with no table", () => {
    expect(parseTextTable("Cargo is empty.")).toEqual({ headers: [], rows: [] });
  });
});

describe("game-text-parser: itemNameToId", () => {
  it("inverts the id→name transform", () => {
    expect(itemNameToId("Power Cell")).toBe("power_cell");
    expect(itemNameToId("Trade Authenticator")).toBe("trade_authenticator");
    expect(itemNameToId("Shield Booster II")).toBe("shield_booster_ii");
  });
});

describe("game-text-parser: parseCargoText", () => {
  it("parses the formatted text table into id+quantity items", () => {
    expect(parseCargoText(GET_CARGO_TEXT)).toEqual([
      { item_id: "power_cell", quantity: 35 },
      { item_id: "shield_emitter", quantity: 6 },
      { item_id: "trade_authenticator", quantity: 18 },
    ]);
  });

  it("returns empty for empty/tableless cargo text", () => {
    expect(parseCargoText("Cargo: 0/0 used, 0 available.\n\nCredits: 6cr")).toEqual([]);
  });
});

describe("game-text-parser: parseCargoUtilizationText", () => {
  it("reads Cargo: U/C from a get_status dashboard string", () => {
    const util = parseCargoUtilizationText(GET_STATUS_TEXT);
    expect(util).toEqual({ used: 629, capacity: 655, freeSpace: 26, pctFull: (629 / 655) * 100 });
  });

  it("clamps freeSpace at 0 when over capacity", () => {
    expect(parseCargoUtilizationText("Cargo: 110/100")?.freeSpace).toBe(0);
  });

  it("returns null when no Cargo line or capacity is 0", () => {
    expect(parseCargoUtilizationText("no cargo line here")).toBeNull();
    expect(parseCargoUtilizationText("Cargo: 0/0 used")).toBeNull();
  });
});

describe("game-text-parser: parseMarketDemandText", () => {
  it("includes demand/sell_here/supply_imbalance rows and excludes opportunity", () => {
    const demand = parseMarketDemandText(ANALYZE_MARKET_TEXT);
    expect(demand.has("liquid_hydrogen")).toBe(true);
    expect(demand.has("shield_emitter")).toBe(true);
    expect(demand.has("power_cell")).toBe(true);
    expect(demand.has("titanium_alloy")).toBe(false); // opportunity is excluded
  });

  it("keys each demand row by both id and name-slug → canonical id", () => {
    const text =
      "Trading insights at X:\n" +
      "priority\tcategory\titem\titem_id\tinsight\n" +
      "100\tdemand\tMining Laser I\tmining_laser_1\tStation pays 90cr";
    const demand = parseMarketDemandText(text);
    expect(demand.get("mining_laser_1")).toBe("mining_laser_1");
    expect(demand.get("mining_laser_i")).toBe("mining_laser_1");
  });

  it("returns empty when there is no item_id column", () => {
    expect(parseMarketDemandText("no table here").size).toBe(0);
  });
});

describe("game-text-parser: parseMarketAliasesText", () => {
  it("maps every row's id and name-slug regardless of category", () => {
    const aliases = parseMarketAliasesText(ANALYZE_MARKET_TEXT);
    // opportunity rows are excluded from demand but included here
    expect(aliases.get("titanium_alloy")).toBe("titanium_alloy");
    expect(aliases.get("shield_emitter")).toBe("shield_emitter");
  });

  it("resolves a name-slug alias to the canonical id when they differ", () => {
    const text =
      "Trading insights at X:\n" +
      "priority\tcategory\titem\titem_id\tinsight\n" +
      "100\topportunity\tMining Laser I\tmining_laser_1\tArbitrage route";
    const aliases = parseMarketAliasesText(text);
    expect(aliases.get("mining_laser_i")).toBe("mining_laser_1");
    expect(aliases.get("mining_laser_1")).toBe("mining_laser_1");
  });
});

describe("game-text-parser: parseGetStatusText", () => {
  it("parses the header line into username/empire/credits/system", () => {
    const p = parseGetStatusText(GET_STATUS_TEXT);
    expect(p.username).toBe("Rust Vane");
    expect(p.empire).toBe("solarian");
    expect(p.credits).toBe(54_877_005);
    expect(p.systemDisplayName).toBe("Sirius");
  });

  it("parses hull/shield/armor/speed/fuel/cargo/cpu/power stat pairs", () => {
    const p = parseGetStatusText(GET_STATUS_TEXT);
    expect([p.hull, p.maxHull]).toEqual([480, 480]);
    expect([p.shield, p.maxShield]).toEqual([225, 225]);
    expect(p.armor).toBe(22);
    expect(p.speed).toBe(1);
    expect([p.fuel, p.maxFuel]).toEqual([253, 350]);
    expect([p.cargoUsed, p.cargoCapacity]).toEqual([629, 655]);
    expect([p.cpuUsed, p.cpuCapacity]).toEqual([27, 32]);
    expect([p.powerUsed, p.powerCapacity]).toEqual([49, 80]);
  });

  it("reads the dock line, and leaves it undefined in space", () => {
    expect(parseGetStatusText(GET_STATUS_TEXT).dockedAt).toBe("sirius_observatory_station");
    const inSpace = GET_STATUS_TEXT.replace(/\nDocked at:.*/, "");
    expect(parseGetStatusText(inSpace).dockedAt).toBeUndefined();
    // placeholder guard
    expect(parseGetStatusText("Docked at: none").dockedAt).toBeUndefined();
  });

  it("parses modules / cargo / skills / standings sections without cross-leak", () => {
    const p = parseGetStatusText(FULL_GET_STATUS);
    expect(p.modules.map((m) => m.id)).toEqual(["mod-1", "mod-2"]);
    expect(p.cargo).toEqual([
      { name: "Gold Ore", quantity: 14 },
      { name: "Iron Ore", quantity: 3 },
    ]);
    expect(p.skills.find((s) => s.name === "mining")).toEqual({
      name: "mining", level: 13, xp: 478, xpToNext: 6885,
    });
    expect(p.standings.solarian).toEqual({ reputation: 20, baseline: 20, bounty: 0 });
    expect(p.standings.drifter).toEqual({ reputation: -5, baseline: 0, bounty: 150 });
  });

  it("returns empty collections (never throws) on unparseable text", () => {
    const p = parseGetStatusText("garbage with no recognizable lines");
    expect(p.modules).toEqual([]);
    expect(p.cargo).toEqual([]);
    expect(p.skills).toEqual([]);
    expect(p.standings).toEqual({});
    expect(p.username).toBeUndefined();
  });
});
