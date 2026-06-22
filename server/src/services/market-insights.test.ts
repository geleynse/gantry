import { describe, it, expect } from "bun:test";
import { parseMarketInsights } from "./market-insights.js";

// Real analyze_market result captured live from proxy_tool_calls on 2026-06-22
// (Central Nexus, trading skill 42). Tab-separated columns:
// priority \t category \t item \t item_id \t insight
const REAL_RESULT = [
  "Trading insights at Central Nexus (trading skill 42):",
  "priority\tcategory\titem\titem_id\tinsight",
  "12354048\tdemand\tContained Uranium Hexafluoride\tcontained_uranium_hexafluoride\tContained Uranium Hexafluoride has strong demand across Solarian Confederacy space — 107520+ units wanted.",
  "7085988\topportunity\tShield Emitter\tshield_emitter\tShield Emitter has buy orders at Confederacy Central Command: ~2300 at ~3650cr, ~7000 at ~2800cr, ~9 at ~2350cr, ~12700 at ~35cr (~48323Kcr total fill for 19467 units).",
  "5846762\topportunity\tLiquid Hydrogen\tliquid_hydrogen\tLiquid Hydrogen has buy orders at Crimson War Citadel: ~3400 at ~140cr, ~17000 at ~130cr, ~38600 at ~110cr, ~425900 at ~65cr (~41013Kcr total fill for 429909 units).",
].join("\n");

describe("parseMarketInsights", () => {
  it("extracts station + best price from 'buy orders at' opportunity rows", () => {
    const ops = parseMarketInsights(REAL_RESULT);
    const shield = ops.find((o) => o.item_id === "shield_emitter");
    expect(shield).toBeDefined();
    expect(shield!.station).toBe("Confederacy Central Command");
    expect(shield!.best_price).toBe(3650); // highest of 3650/2800/2350/35
    expect(shield!.type).toBe("sell"); // buy orders at a station = you SELL there
  });

  it("captures every opportunity row, not just the first", () => {
    const ops = parseMarketInsights(REAL_RESULT);
    const ids = ops.map((o) => o.item_id).sort();
    expect(ids).toEqual(["liquid_hydrogen", "shield_emitter"]);
  });

  it("ignores faction-wide 'demand' rows (no station named)", () => {
    const ops = parseMarketInsights(REAL_RESULT);
    expect(ops.some((o) => o.item_id === "contained_uranium_hexafluoride")).toBe(false);
  });

  it("parses 'sell orders at' as a buy opportunity (you BUY there)", () => {
    const text = [
      "priority\tcategory\titem\titem_id\tinsight",
      "100\topportunity\tIron Ore\tiron_ore\tIron Ore has sell orders at Trade Hub Beta: ~500 at ~12cr, ~900 at ~20cr.",
    ].join("\n");
    const ops = parseMarketInsights(text);
    expect(ops.length).toBe(1);
    expect(ops[0].type).toBe("buy");
    expect(ops[0].station).toBe("Trade Hub Beta");
    expect(ops[0].best_price).toBe(12); // lowest ask is the best buy price
  });

  it("returns [] for non-string / empty / order-less input", () => {
    expect(parseMarketInsights("")).toEqual([]);
    expect(parseMarketInsights(undefined as unknown as string)).toEqual([]);
    expect(parseMarketInsights("Trading insights at X:\nno tabs here")).toEqual([]);
  });

  it("handles comma-grouped prices", () => {
    const text = [
      "priority\tcategory\titem\titem_id\tinsight",
      "1\topportunity\tGold\tgold\tGold has buy orders at Vault: ~10 at ~1,250cr, ~5 at ~900cr.",
    ].join("\n");
    const ops = parseMarketInsights(text);
    expect(ops[0].best_price).toBe(1250);
  });
});
