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

type StatusCacheEntry = { data: Record<string, any>; fetchedAt: number };

export function createCatalogRouter(statusCache?: Map<string, StatusCacheEntry>): Router {
  const router = Router();

  router.get("/", (req, res) => {
    let type = (req.query.type as string | undefined) ?? "all";
    const search = req.query.search as string | undefined;
    const id = req.query.id as string | undefined;

    const isModuleCompat = type === "module_compat";
    if (isModuleCompat) {
      type = "item"; // Search items, filter later
    }

    const validTypes = ["item", "recipe", "ship", "all", "module_compat"];
    if (!validTypes.includes(type) && !isModuleCompat) {
      return res.status(400).json({ error: `Invalid type. Must be one of: ${validTypes.join(", ")}` });
    }

    let results = searchCatalog(type as "item" | "recipe" | "ship" | "all", search, id, 200);

    // Compute dynamic module info
    const equippedModuleIds = new Set<string>();
    if (statusCache) {
      for (const entry of statusCache.values()) {
        const mods = entry.data?.ship?.modules;
        if (Array.isArray(mods)) {
          mods.forEach((m) => {
            if (m && m.item_id) equippedModuleIds.add(String(m.item_id));
          });
        }
      }
    }

    const itemsWithModuleInfo = results.items.map((item) => {
      const isWeapon = item.type === "weapon";
      const isShield = item.type === "shield";
      const isScanner = item.type === "scanner";
      const isModule = isWeapon || isShield || isScanner || equippedModuleIds.has(item.id);

      const compatible_slots: string[] = [];
      if (isWeapon) compatible_slots.push("weapon");
      if (isShield) compatible_slots.push("defense");
      if (isScanner) compatible_slots.push("utility");

      return {
        ...item,
        is_module: isModule,
        compatible_slots,
      };
    });

    if (isModuleCompat) {
      results.items = itemsWithModuleInfo.filter((item) => item.is_module);
    } else {
      results.items = itemsWithModuleInfo;
    }

    const total = results.items.length + results.recipes.length + results.ships.length;

    // Handle single item lookup returning 404 if not found
    if (id && total === 0) {
      return res.status(404).json({ error: "Not found" });
    }

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
