/**
 * POI Lore API routes — Task #27.
 * GET /api/lore           — all lore entries (optionally filtered by ?search=keyword)
 * GET /api/lore/:system   — lore for a specific system
 * POST /api/lore          — record new lore (admin)
 * DELETE /api/lore/:system/:poi — delete specific lore entry (admin)
 */

import { Router } from "express";
import { createLogger } from "../../lib/logger.js";
import {
  getLore,
  searchLore,
  recordLore,
  deleteLore,
} from "../../services/poi-lore.js";

const log = createLogger("lore-routes");
const router: Router = Router();

// GET /api/lore?search=keyword — search all lore, or return everything
router.get("/", (req, res) => {
  try {
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    if (search) {
      const results = searchLore(search);
      res.json({ lore: results, count: results.length, query: search });
    } else {
      // Return a sample (all systems would be large — use search for targeted queries)
      const results = searchLore(""); // empty returns []
      res.json({ lore: results, count: results.length });
    }
  } catch (err) {
    log.warn("GET /api/lore failed", { error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/lore/:system — all lore for a system
router.get("/:system", (req, res) => {
  try {
    const system = req.params.system;
    if (!system) {
      res.status(400).json({ error: "system parameter required" });
      return;
    }
    const lore = getLore(system);
    res.json({ system, lore, count: lore.length });
  } catch (err) {
    log.warn("GET /api/lore/:system failed", { system: req.params.system, error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/lore — record or update a lore entry
router.post("/", (req, res) => {
  try {
    const { system, poi_name, note, discovered_by, tags } = req.body ?? {};
    if (!system || !poi_name || !note || !discovered_by) {
      res.status(400).json({ error: "system, poi_name, note, discovered_by are required" });
      return;
    }
    const tagsArr = Array.isArray(tags) ? tags : undefined;
    recordLore(String(system), String(poi_name), String(note), String(discovered_by), tagsArr);
    res.json({ ok: true, system, poi_name });
  } catch (err) {
    log.warn("POST /api/lore failed", { error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /api/lore/:system/:poi — remove a lore entry
router.delete("/:system/:poi", (req, res) => {
  try {
    const { system, poi } = req.params;
    const deleted = deleteLore(system, poi);
    if (!deleted) {
      res.status(404).json({ error: "Lore entry not found" });
      return;
    }
    res.json({ ok: true, system, poi_name: poi });
  } catch (err) {
    log.warn("DELETE /api/lore failed", { error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

export default router;
