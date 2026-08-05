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

// ---------------------------------------------------------------------------
// v0.548.0 / v0.520.1 column-insertion audit
//
// The game changelog (v0.548.0) warned: "The pirate tables in get_nearby and
// get_state gained a `crew` column — if you parse those tables by column
// position rather than by header, update your parser." (v0.520.1 made the same
// kind of change to the facility owned/faction_owned tables: a new `type`
// column.)
//
// AUDIT FINDING: gantry has no parser — here or anywhere else in the codebase —
// that reads get_nearby/get_state pirate data or facility owned/faction_owned
// data by column position. That data is JSON today (summarizers.ts picks fields
// by NAME via discoverPick; facilities.ts/threat-assessment.ts read named
// object properties), which is immune-by-construction to an inserted field.
// There is nothing to convert to header-driven parsing for those two tables.
//
// The tests below don't fix a bug — they lock in the CORRECT pattern (reuse
// the shared parseTextTable primitive + header.findIndex) for the day gantry
// *does* need to parse one of these as a formatted-text table, the way
// get_status/get_cargo/analyze_market already had to. They prove the pattern
// survives an inserted column, and — via the sibling "naive" helper — that a
// column-position read of the exact same data does not.
// ---------------------------------------------------------------------------
describe("game-text-parser: header-driven pattern survives an inserted column (v0.548.0/v0.520.1 audit)", () => {
  // Pirate table shape BEFORE v0.548.0: no crew column.
  const PIRATE_TABLE_BEFORE =
    "name\tclass\thull\tfaction\n" +
    "Voss Reaver\tfrigate\t320\tpirate_voss\n" +
    "Kael Marauder\tcruiser\t900\tpirate_kael";

  // Pirate table shape AFTER v0.548.0: `crew` inserted BETWEEN class and hull —
  // exactly the kind of mid-table insertion that breaks a hardcoded index.
  const PIRATE_TABLE_AFTER =
    "name\tclass\tcrew\thull\tfaction\n" +
    "Voss Reaver\tfrigate\t4\t320\tpirate_voss\n" +
    "Kael Marauder\tcruiser\t12\t900\tpirate_kael";

  // A header-driven reader in the same style as parseCargoText/parseMarketDemandText:
  // resolve each column index from the header row by name, once, then index by
  // that resolved position for every row. This is the pattern any future
  // pirate/facility text-table parser should copy.
  function readHullByHeader(text: string): number[] {
    const { headers, rows } = parseTextTable(text);
    const hullIdx = headers.findIndex((h) => h === "hull");
    if (hullIdx === -1) return [];
    return rows.map((cols) => parseInt(cols[hullIdx], 10));
  }

  // The WRONG pattern the changelog is warning about: hardcode "hull is column 2"
  // because that was true in the pre-crew-column table.
  function readHullByFixedPosition(text: string): number[] {
    const { rows } = parseTextTable(text);
    return rows.map((cols) => parseInt(cols[2], 10));
  }

  it("header-driven: reads the correct hull values before AND after the crew column is inserted", () => {
    expect(readHullByHeader(PIRATE_TABLE_BEFORE)).toEqual([320, 900]);
    expect(readHullByHeader(PIRATE_TABLE_AFTER)).toEqual([320, 900]);
  });

  it("MUTATION PROOF: the fixed-position reader is correct before the column insertion (control)", () => {
    // Establishes the naive reader isn't just broken outright — it works fine
    // until the table shape changes, which is exactly why this class of bug
    // survives review: it passes every test written against the old shape.
    expect(readHullByFixedPosition(PIRATE_TABLE_BEFORE)).toEqual([320, 900]);
  });

  it("MUTATION PROOF: the fixed-position reader goes RED (silently wrong) once crew is inserted", () => {
    // cols[2] is now the crew count (4, 12), not hull (320, 900) — this is the
    // live failure mode the changelog warned about: no exception, just silently
    // wrong data flowing into threat assessment / combat decisions.
    expect(readHullByFixedPosition(PIRATE_TABLE_AFTER)).toEqual([4, 12]);
    expect(readHullByFixedPosition(PIRATE_TABLE_AFTER)).not.toEqual([320, 900]);
  });

  // Facility owned/faction_owned table: v0.520.1 inserted a `type` column.
  const FACILITY_TABLE_BEFORE =
    "id\tname\towner\n" +
    "fac-1\tRefinery Alpha\tacme-corp\n" +
    "fac-2\tShipyard Beta\tacme-corp";

  const FACILITY_TABLE_AFTER =
    "id\tname\ttype\towner\n" +
    "fac-1\tRefinery Alpha\trefinery\tacme-corp\n" +
    "fac-2\tShipyard Beta\tshipyard\tacme-corp";

  function readOwnerByHeader(text: string): string[] {
    const { headers, rows } = parseTextTable(text);
    const ownerIdx = headers.findIndex((h) => h === "owner");
    if (ownerIdx === -1) return [];
    return rows.map((cols) => cols[ownerIdx]);
  }

  function readOwnerByFixedPosition(text: string): string[] {
    const { rows } = parseTextTable(text);
    return rows.map((cols) => cols[2]);
  }

  it("header-driven: reads the correct owner before AND after the facility `type` column is inserted", () => {
    expect(readOwnerByHeader(FACILITY_TABLE_BEFORE)).toEqual(["acme-corp", "acme-corp"]);
    expect(readOwnerByHeader(FACILITY_TABLE_AFTER)).toEqual(["acme-corp", "acme-corp"]);
  });

  it("MUTATION PROOF: fixed-position owner read goes RED once `type` is inserted", () => {
    expect(readOwnerByFixedPosition(FACILITY_TABLE_BEFORE)).toEqual(["acme-corp", "acme-corp"]);
    expect(readOwnerByFixedPosition(FACILITY_TABLE_AFTER)).toEqual(["refinery", "shipyard"]);
    expect(readOwnerByFixedPosition(FACILITY_TABLE_AFTER)).not.toEqual(["acme-corp", "acme-corp"]);
  });
});
