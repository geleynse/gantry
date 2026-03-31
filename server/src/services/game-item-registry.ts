import { getDb, queryOne, queryAll } from './database.js';
import { createLogger } from '../lib/logger.js';
import { learnMetadata } from './learned-metadata.js';

const log = createLogger('game-item-registry');

export interface GameItem {
  id: string;
  name: string;
  type?: string;
  mass?: number;
  value?: number;
  legality?: string;
  base_price?: number;
  updated_at?: string;
}

/**
 * GameItemRegistry — Manages persistent knowledge of game items and their metadata.
 */
export function registerItem(item: GameItem): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO game_items (
        id, name, type, mass, value, legality, base_price, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        type = COALESCE(excluded.type, type),
        mass = COALESCE(excluded.mass, mass),
        value = COALESCE(excluded.value, value),
        legality = COALESCE(excluded.legality, legality),
        base_price = COALESCE(excluded.base_price, base_price),
        updated_at = datetime('now')
    `).run(
      item.id,
      item.name,
      item.type ?? null,
      item.mass ?? null,
      item.value ?? null,
      item.legality ?? null,
      item.base_price ?? null
    );
    
    // Also sync to the basic learned_metadata table for compatibility
    learnMetadata(item.id, item.name, item.type);
    
    log.info(`Registered item: ${item.name} (${item.id})`);
  } catch (e) {
    log.error(`Failed to register item ${item.id}`, { error: e });
  }
}

interface GameItemRow {
  id: string;
  name: string;
  type: string | null;
  mass: number | null;
  value: number | null;
  legality: string | null;
  base_price: number | null;
  updated_at: string;
}

function rowToItem(row: GameItemRow): GameItem {
  return {
    id: row.id,
    name: row.name,
    type: row.type ?? undefined,
    mass: row.mass ?? undefined,
    value: row.value ?? undefined,
    legality: row.legality ?? undefined,
    base_price: row.base_price ?? undefined,
    updated_at: row.updated_at,
  };
}

export function getItem(id: string): GameItem | null {
  try {
    const row = queryOne<GameItemRow>('SELECT * FROM game_items WHERE id = ?', id);
    return row ? rowToItem(row) : null;
  } catch (e) {
    log.error(`Failed to get item ${id}`, { error: e });
    return null;
  }
}

export function getAllItems(): GameItem[] {
  try {
    return queryAll<GameItemRow>('SELECT * FROM game_items').map(rowToItem);
  } catch (e) {
    log.error('Failed to get all items', { error: e });
    return [];
  }
}
