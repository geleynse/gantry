import { getDb } from './database.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('metadata-registry');

/**
 * LearnedMetadataService — Dynamically resolve IDs to names.
 * Persists discovered mappings in the learned_metadata table.
 */

interface MetadataEntry {
  id: string;
  name: string;
  type?: string;
}

/** In-memory caches for fast lookups */
const cache = new Map<string, string>();
const typeCache = new Map<string, string>();
let initialized = false;

/** Initialize the service by loading all mappings from the DB */
function init(): void {
  if (initialized) return;
  try {
    const db = getDb();
    const rows = db.prepare('SELECT id, name, type FROM learned_metadata').all() as { id: string; name: string; type: string | null }[];
    for (const row of rows) {
      cache.set(row.id, row.name);
      if (row.type) typeCache.set(row.id, row.type);
    }
    initialized = true;
  } catch (e) {
    // DB might not be ready yet
  }
}

/** 
 * Resolve an ID to a human-friendly name.
 * Returns null if not found in the registry.
 */
export function resolveName(id: string | undefined): string | null {
  if (!id) return null;
  if (!initialized) init();
  return cache.get(id) || null;
}

/** Get all learned mappings (for debugging or tools). */
export function getLearnedMetadata(): MetadataEntry[] {
  if (!initialized) init();
  const result: MetadataEntry[] = [];
  for (const [id, name] of cache.entries()) {
    const type = typeCache.get(id);
    result.push(type ? { id, name, type } : { id, name });
  }
  return result;
}

/**
 * Reset in-memory caches and force re-initialization from DB on next access.
 * Primarily for test isolation.
 */
export function resetCaches(): void {
  cache.clear();
  typeCache.clear();
  initialized = false;
}

/**
 * Record a newly discovered ID -> Name mapping.
 * Safely ignores duplicates or invalid data.
 */
export function learnMetadata(id: string | undefined, name: string | undefined, type?: string): void {
  if (!id || !name || id === name) return;
  if (!initialized) init();

  // Skip if already cached with same name and type (if type provided)
  if (cache.get(id) === name && (!type || typeCache.get(id) === type)) return;

  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO learned_metadata (id, name, type, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        type = COALESCE(excluded.type, type),
        updated_at = datetime('now')
    `).run(id, name, type || null);

    cache.set(id, name);
    if (type) typeCache.set(id, type);
    log.info(`Learned new metadata mapping: ${id} -> ${name}`);
  } catch (e) {
    // Non-fatal, e.g. DB locked
  }
}

/**
 * Resolve an ID to its stored slot type (e.g. "weapon", "defense", "utility").
 * Returns null if not found.
 */
export function getType(id: string | undefined): string | null {
  if (!id) return null;
  if (!initialized) init();
  return typeCache.get(id) || null;
}

/** 
 * Helper to process an array of objects (modules or cargo) 
 * and learn any mappings they contain.
 */
export function learnFromObjects(items: any[]): void {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    
    // Support various common ID/Name field patterns
    const id = item.id || item.item_id || item.module_id;
    const name = item.name || item.item_name || item.module_name;
    const type = item.type || item.slot_type;
    
    if (id && name) {
      learnMetadata(String(id), String(name), type ? String(type) : undefined);
    }
  }
}
