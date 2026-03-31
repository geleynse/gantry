/**
 * Leaderboard routes — viewer-accessible, no DI needed.
 *
 * GET /api/leaderboard        — returns { data, fetchedAt, fromCache }
 * GET /api/leaderboard/status — cache health without triggering a fetch
 */

import { Router } from "express";
import { getLeaderboard, getCacheStatus } from "../../services/leaderboard-cache.js";

const router: Router = Router();

router.get("/", async (_req, res) => {
  try {
    const { data, fetchedAt, fromCache } = await getLeaderboard();
    res.json({ data, fetchedAt, fromCache });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: `Upstream leaderboard fetch failed: ${message}` });
  }
});

router.get("/status", (_req, res) => {
  res.json(getCacheStatus());
});

export default router;
