/**
 * market-insights.ts — parse the station-contextual `analyze_market` insight text
 * into structured per-STATION market opportunities.
 *
 * analyze_market returns a tab-separated "Trading insights at <STATION>" report
 * (verified live 2026-06-22 via proxy_tool_calls). Columns:
 *   priority \t category \t item \t item_id \t insight
 *
 * Only `opportunity` rows name a concrete station + prices in the insight text:
 *   "<item> has buy orders at <STATION>: ~<qty> at ~<price>cr, …"  → you SELL there
 *   "<item> has sell orders at <STATION>: ~<qty> at ~<price>cr, …" → you BUY there
 * `demand` rows are faction-wide ("strong demand across <faction> space") with no
 * station, so they are intentionally ignored — recording them per-station would be
 * wrong. item_id is taken from the clean column, NOT parsed from prose.
 */

/** A station-level market opportunity extracted from an analyze_market insight. */
export interface MarketOpportunity {
  item_id: string;
  item_name: string;
  /** Station NAME as written in the insight (resolve to a poi_id at record time). */
  station: string;
  /**
   * For a SELL opportunity: the highest buy-order price (best you'd get selling).
   * For a BUY opportunity: the lowest sell-order price (cheapest you'd buy).
   */
  best_price: number;
  /** 'sell' = buy orders exist at the station (you sell into them); 'buy' = vice-versa. */
  type: "sell" | "buy";
}

// "buy orders at <station>: <price list>"  — capture station + the price list up to
// the trailing parenthetical (the "(~N total fill …)" summary) or end of line.
const ORDER_RE = /\b(buy|sell) orders at (.+?):\s*([^()]+)/i;
// Each per-order price, e.g. "~2300 at ~3,650cr".
const PRICE_RE = /at\s*~?([\d,]+)\s*cr/gi;

/** Parse an analyze_market insight text into structured station opportunities. */
export function parseMarketInsights(resultText: string): MarketOpportunity[] {
  const out: MarketOpportunity[] = [];
  if (typeof resultText !== "string" || resultText.length === 0) return out;

  for (const line of resultText.split("\n")) {
    const cols = line.split("\t");
    if (cols.length < 5) continue;
    const category = cols[1]?.trim();
    if (category !== "opportunity") continue;

    const item_name = cols[2]?.trim() ?? "";
    const item_id = cols[3]?.trim() ?? "";
    const insight = cols[4] ?? "";
    if (!item_id) continue;

    const m = insight.match(ORDER_RE);
    if (!m) continue;
    const side = m[1].toLowerCase();
    const station = m[2].trim();
    const priceList = m[3];

    const prices: number[] = [];
    for (const pm of priceList.matchAll(PRICE_RE)) {
      const n = parseInt(pm[1].replace(/,/g, ""), 10);
      if (!Number.isNaN(n)) prices.push(n);
    }
    if (!station || prices.length === 0) continue;

    // "buy orders" = stations buying → you SELL → best is the HIGHEST bid.
    // "sell orders" = stations selling → you BUY → best is the LOWEST ask.
    const type: "sell" | "buy" = side === "buy" ? "sell" : "buy";
    const best_price = type === "sell" ? Math.max(...prices) : Math.min(...prices);

    out.push({ item_id, item_name, station, best_price, type });
  }
  return out;
}
