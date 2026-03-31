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

    // Seed with known common values if empty
    if (cache.size === 0) {
      seedRegistry();
    }
  } catch (e) {
    // DB might not be ready yet
  }
}

/** Seed the registry with known hex IDs from logs */
function seedRegistry(): void {
  const seeds: MetadataEntry[] = [
    { id: 'ab4007e5f47f61bc4a1fe05646f10528', name: 'Mining Laser I', type: 'weapon' },
    { id: '849db6ad0d36c1e0b246f8d93ef1335f', name: 'Autocannon I', type: 'weapon' },
    { id: 'e620f6fbc2a5d5702082a90ffe86e4ea', name: 'Autocannon I', type: 'weapon' },
    { id: 'e26f282363a5ebdf7d0b404884e9dcf7', name: 'Armor Plate I', type: 'defense' },
    { id: '5e563a1b17f6c0f724a3c95d8029f0ca', name: 'Mining Laser I', type: 'weapon' },
    { id: '52b9b8749ff6c10f1db46358312d1756', name: 'Mining Laser I', type: 'weapon' },
    { id: '35dbb366ddde00053a90cbb7f0e46e80', name: 'FTL Drive I', type: 'utility' },
    { id: '6a8b2a8ef82d0f17e68ba88207e2f0a2', name: 'Shield Generator I', type: 'defense' },
  ];

  for (const entry of seeds) {
    learnMetadata(entry.id, entry.name, entry.type);
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
