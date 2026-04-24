import { createLogger } from '../lib/logger.js';
import type { GameTransport as GameClient } from './game-transport.js';
import type { MockGameClient } from './mock-game-client.js';
import { registerItem, getItem } from '../services/game-item-registry.js';
import { registerRecipe } from '../services/recipe-registry.js';

const log = createLogger('discovery');

const DISCOVERY_COOLDOWN = 1000 * 60 * 60; // 1 hour

/**
 * DiscoveryService — Proactively discovers game data (items, recipes, etc.)
 * by calling catalog tools via an active game session.
 *
 * Each instance tracks its own cooldown state.
 */
export class DiscoveryService {
  private lastCatalogDiscovery = 0;

  /**
   * Run a discovery pass using the provided client.
   * Fetches item and recipe catalogs and feeds them to the registries.
   */
  async runDiscovery(client: GameClient | MockGameClient): Promise<void> {
    const now = Date.now();
    if (now - this.lastCatalogDiscovery < DISCOVERY_COOLDOWN) return;

    // Claim the slot immediately to prevent concurrent discovery from multiple agents
    // logging in simultaneously. If discovery fails, the next login will retry.
    this.lastCatalogDiscovery = now;

    log.info(`[${client.label}] Starting proactive discovery pass`);

    try {
      // 1. Discover Items
      const itemResp = await client.execute('catalog', { type: 'items' }, { skipMetrics: true });
      if (itemResp.result && typeof itemResp.result === 'object') {
        const result = itemResp.result as Record<string, unknown>;
        const items = result.items || result.result || [];
        if (Array.isArray(items)) {
          log.info(`[${client.label}] Discovered ${items.length} items from catalog`);
          for (const item of items) {
            this.registerItemFromData(item);
          }
        }
      }

      // 2. Discover Recipes
      const recipeResp = await client.execute('catalog', { type: 'recipes' }, { skipMetrics: true });
      if (recipeResp.result && typeof recipeResp.result === 'object') {
        const result = recipeResp.result as Record<string, unknown>;
        const recipes = result.recipes || result.result || [];
        if (Array.isArray(recipes)) {
          log.info(`[${client.label}] Discovered ${recipes.length} recipes from catalog`);
          for (const recipe of recipes) {
            const recipe_id = recipe.recipe_id || recipe.id;
            const output_item_id = recipe.output_item_id;

            if (recipe_id && output_item_id) {
              // Register the recipe
              registerRecipe({
                id: String(recipe_id),
                output_item_id: String(output_item_id),
                output_quantity: recipe.output_quantity || 1,
                inputs: recipe.inputs || [],
                skills: recipe.skills,
                time_seconds: recipe.time_seconds
              });

              // Recursive Discovery: If output item or any input item is unknown, try to fetch it
              await this.ensureItemKnown(client, output_item_id);
              if (Array.isArray(recipe.inputs)) {
                for (const input of recipe.inputs) {
                  if (input.item_id) {
                    await this.ensureItemKnown(client, input.item_id);
                  }
                }
              }
            }
          }
        }
      }

      log.info(`[${client.label}] Discovery pass complete`);
    } catch (e) {
      log.error(`[${client.label}] Discovery pass failed`, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * Ensures an item is known in the registry. If not, attempts to fetch its metadata.
   */
  private async ensureItemKnown(client: GameClient | MockGameClient, itemId: string): Promise<void> {
    if (getItem(itemId)) return;

    log.info(`[${client.label}] Unknown item ${itemId} encountered, fetching metadata...`);
    try {
      const resp = await client.execute('catalog', { type: 'items', id: itemId }, { skipMetrics: true });
      if (resp.result && typeof resp.result === 'object') {
        this.registerItemFromData(resp.result as Record<string, unknown>, itemId);
      }
    } catch (e) {
      log.warn(`[${client.label}] Failed to fetch metadata for item ${itemId}`);
    }
  }

  private registerItemFromData(item: Record<string, unknown>, fallbackId?: string): void {
    const id = item.id || item.item_id || fallbackId;
    const name = item.name || item.item_name;
    if (id && name) {
      registerItem({
        id: String(id),
        name: String(name),
        type: (item.type || item.slot_type) as string | undefined,
        mass: item.mass as number | undefined,
        value: item.value as number | undefined,
        legality: item.legality as string | undefined,
        base_price: item.base_price as number | undefined,
      });
    }
  }
}

// Default instance for backward compatibility
const defaultService = new DiscoveryService();

/**
 * @deprecated Use DiscoveryService instance directly.
 */
export async function runDiscovery(client: GameClient | MockGameClient): Promise<void> {
  return defaultService.runDiscovery(client);
}
