/**
 * GET /api/rate-limits
 *
 * Returns per-agent and per-exit-IP rate limit stats for game API calls.
 * Tracks requests against the game server's 30 req/min/IP limit.
 */
import { Router } from "express";
import { getTracker } from "../../services/rate-limit-tracker.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("rate-limits-game-route");
const router: Router = Router();

router.get("/", (_req, res) => {
  try {
    const tracker = getTracker();
    if (!tracker) {
      // Tracker not initialized (e.g. no config loaded) — return empty snapshot
      res.json({
        limit: 30,
        window_seconds: 60,
        by_ip: {},
        by_agent: {},
        recent_429s: [],
      });
      return;
    }
    res.json(tracker.getSnapshot());
  } catch (err) {
    log.error("Failed to get game rate limit stats", { error: String(err) });
    res.status(500).json({ error: "Internal error fetching rate limit stats" });
  }
});

export default router;
