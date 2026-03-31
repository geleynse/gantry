/**
 * API routes for game catalog data.
 *
 * GET /api/catalog              — full catalog (all types)
 * GET /api/catalog?type=item    — items only
 * GET /api/catalog?type=recipe  — recipes only
 * GET /api/catalog?type=ship    — ships only
 * GET /api/catalog?search=iron  — search by name across all types
 * GET /api/catalog?id=iron_ore  — exact ID lookup
 */

import { Router } from "express";
import { getCatalog, searchCatalog } from "../../services/game-catalog.js";

export function createCatalogRouter(): Router {
  const router = Router();

  router.get("/", (req, res) => {
    const type = (req.query.type as string | undefined) ?? "all";
    const search = req.query.search as string | undefined;
    const id = req.query.id as string | undefined;

    const validTypes = ["item", "recipe", "ship", "all"];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: `Invalid type. Must be one of: ${validTypes.join(", ")}` });
    }

    const results = searchCatalog(type as "item" | "recipe" | "ship" | "all", search, id, 200);
    const total = results.items.length + results.recipes.length + results.ships.length;

    return res.json({
      ...results,
      total,
      fetched_at: getCatalog()?.fetched_at ?? null,
    });
  });

  router.get("/status", (_req, res) => {
    const catalog = getCatalog();
    if (!catalog) {
      return res.json({ available: false, message: "Catalog not yet loaded" });
    }
    return res.json({
      available: true,
      item_count: catalog.items.length,
      recipe_count: catalog.recipes.length,
      ship_count: catalog.ships.length,
      fetched_at: catalog.fetched_at,
    });
  });

  return router;
}
