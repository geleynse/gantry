import type { MarketData } from "./market-cache.js";

interface BetterPrice {
  item: string;
  local_bid: number;
  best_bid: number;
  best_empire: string;
  improvement: string;
}

interface GlobalMarketContext {
  your_station: string;
  better_prices_elsewhere: BetterPrice[];
}

export function enrichWithGlobalContext(
  cargo: Array<{ item_id: string; quantity: number }>,
  localBids: Map<string, number>,
  marketData: MarketData | null,
  currentStation: string,
): GlobalMarketContext | null {
  if (!marketData || cargo.length === 0) return null;

  const betterPrices: BetterPrice[] = [];

  for (const item of cargo) {
    const localBid = localBids.get(item.item_id) ?? 0;
    const globalItems = marketData.items.filter((m) => m.item_id === item.item_id && m.best_bid > 0);
    if (globalItems.length === 0) continue;

    const best = globalItems.reduce((a, b) => (a.best_bid > b.best_bid ? a : b));

    if (localBid > 0 && best.best_bid > localBid) {
      const improvement = (best.best_bid - localBid) / localBid;
      if (improvement >= 0.2) {
        betterPrices.push({
          item: item.item_id,
          local_bid: localBid,
          best_bid: best.best_bid,
          best_empire: best.empire,
          improvement: `+${Math.round(improvement * 100)}%`,
        });
      }
    } else if (localBid === 0 && best.best_bid > 0) {
      betterPrices.push({
        item: item.item_id,
        local_bid: 0,
        best_bid: best.best_bid,
        best_empire: best.empire,
        improvement: "no local demand",
      });
    }
  }

  if (betterPrices.length === 0) return null;

  return { your_station: currentStation, better_prices_elsewhere: betterPrices };
}
