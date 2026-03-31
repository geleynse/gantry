/**
 * Intel API routes — Task #29.
 * GET /api/intel/forum           — get cached forum intel (latest posts + game updates)
 * GET /api/intel/forum/search    — search forum posts by keyword
 */

import { Router } from "express";
import { createLogger } from "../../lib/logger.js";
import { createForumService } from "../../services/forum-scraper.js";
import { getConfig } from "../../config.js";

const log = createLogger("intel-routes");
const router: Router = Router();

// Lazy-initialize forum service so it picks up config at request time
function getForumService() {
  try {
    const config = getConfig();
    return createForumService(config.forumUrl);
  } catch {
    // Config not loaded in test env
    return createForumService(undefined);
  }
}

// GET /api/intel/forum — latest posts + game updates
router.get("/forum", async (_req, res) => {
  try {
    const service = getForumService();

    if (!service.isConfigured()) {
      res.json({
        configured: false,
        message: "No forum URL configured. Set forumUrl in fleet-config.json to enable.",
        latest_posts: [],
        game_updates: [],
      });
      return;
    }

    const [latestPosts, gameUpdates] = await Promise.all([
      service.getLatestPosts(),
      service.getGameUpdates(),
    ]);

    res.json({
      configured: true,
      latest_posts: latestPosts,
      game_updates: gameUpdates,
      post_count: latestPosts.length + gameUpdates.length,
    });
  } catch (err) {
    log.warn("GET /api/intel/forum failed", { error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/intel/forum/search?q=keyword — search forum posts
router.get("/forum/search", async (req, res) => {
  try {
    const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!query) {
      res.status(400).json({ error: "q parameter required" });
      return;
    }

    const service = getForumService();

    if (!service.isConfigured()) {
      res.json({
        configured: false,
        message: "No forum URL configured.",
        results: [],
      });
      return;
    }

    const results = await service.searchPosts(query);
    res.json({ configured: true, query, results, count: results.length });
  } catch (err) {
    log.warn("GET /api/intel/forum/search failed", { error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

export default router;
