import { Router } from "express";
import type { MarketCache } from "../../proxy/market-cache.js";
import type { ArbitrageAnalyzer } from "../../proxy/arbitrage-analyzer.js";
import type { MarketReservationCache } from "../../proxy/market-reservations.js";
import type { AnalyzeMarketCache } from "../../proxy/analyze-market-cache.js";
import { runMarketScan } from "../../services/market-scanner.js";

export interface MarketRouterDeps {
  marketCache: MarketCache;
  arbitrageAnalyzer: ArbitrageAnalyzer;
  marketReservations: MarketReservationCache;
  analyzeMarketCache?: AnalyzeMarketCache;
}

export function createMarketRouter({ marketCache, arbitrageAnalyzer, marketReservations, analyzeMarketCache }: MarketRouterDeps): Router {
  const router = Router();

  router.post("/scan", async (_req, res) => {
    try {
      const result = await runMarketScan();
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.get("/arbitrage", (_req, res) => {
    const opportunities = arbitrageAnalyzer.getOpportunities(marketCache);
    res.json(opportunities);
  });

  // --- Market cache stats endpoint ---

  router.get("/cache-stats", (_req, res) => {
    if (!analyzeMarketCache) {
      res.json({ error: "Market cache not available" });
      return;
    }
    res.json(analyzeMarketCache.getFullMetrics());
  });

  // --- Market reservation endpoints ---

  router.get("/reservations", (_req, res) => {
    const reservations = marketReservations.getAllReservations();
    res.json({ reservations, count: reservations.length });
  });

  router.delete("/reservations/:agent", (req, res) => {
    const agent = req.params.agent;
    marketReservations.releaseAll(agent);
    res.json({ ok: true, agent });
  });

  return router;
}
