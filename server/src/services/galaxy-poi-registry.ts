import { getDb, queryOne, queryAll, queryRun } from './database.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('galaxy-poi-registry');

export interface GalaxyPoi {
  id: string;
  name: string;
  system: string;
  type?: string;
  services?: string[];
  updated_at?: string;
}

/**
 * GalaxyPoiRegistry — Manages persistent knowledge of POIs and their services.
 */
export function registerPoi(poi: GalaxyPoi): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO galaxy_pois (
        id, name, system, type, services_json, updated_at
      )
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        system = excluded.system,
        type = COALESCE(excluded.type, type),
        services_json = COALESCE(excluded.services_json, services_json),
        updated_at = datetime('now')
    `).run(
      poi.id,
      poi.name,
      poi.system,
      poi.type ?? null,
      poi.services ? JSON.stringify(poi.services) : null
    );
    
    log.info(`Registered POI: ${poi.name} (${poi.id}) in ${poi.system}`);
  } catch (e) {
    log.error(`Failed to register POI ${poi.id}`, { error: e });
  }
}

interface PoiRow {
  id: string;
  name: string;
  system: string;
  type: string | null;
  services_json: string | null;
  dockable: number | null;
  updated_at: string;
}

function rowToPoi(row: PoiRow): GalaxyPoi {
  return {
    id: row.id,
    name: row.name,
    system: row.system,
    type: row.type ?? undefined,
    services: row.services_json ? JSON.parse(row.services_json) : undefined,
    updated_at: row.updated_at,
  };
}

export function getPoi(id: string): GalaxyPoi | null {
  try {
    const row = queryOne<PoiRow>('SELECT * FROM galaxy_pois WHERE id = ?', id);
    return row ? rowToPoi(row) : null;
  } catch (e) {
    log.error(`Failed to get POI ${id}`, { error: e });
    return null;
  }
}

export function findPoisByService(service_type: string): GalaxyPoi[] {
  try {
    // Simple LIKE check, might need better JSON querying if performance matters
    return queryAll<PoiRow>('SELECT * FROM galaxy_pois WHERE services_json LIKE ?', `%${service_type}%`)
      .map(rowToPoi)
      .filter(poi => poi.services?.includes(service_type));
  } catch (e) {
    log.error(`Failed to find POIs by service ${service_type}`, { error: e });
    return [];
  }
}

export function getPoisBySystem(system: string): GalaxyPoi[] {
  try {
    return queryAll<PoiRow>('SELECT * FROM galaxy_pois WHERE system = ?', system).map(rowToPoi);
  } catch (e) {
    log.error(`Failed to get POIs for system ${system}`, { error: e });
    return [];
  }
}

/** Fallback metadata for markDockable upsert when POI isn't registered yet. */
interface PoiFallback {
  name: string;
  system: string;
  type?: string;
}

/**
 * Mark a POI as dockable or not. If the POI doesn't exist and fallback metadata
 * is provided, it will be inserted. Without fallback, unregistered POIs are silently skipped.
 */
export function markDockable(id: string, dockable: boolean, fallback?: PoiFallback): void {
  try {
    const changes = queryRun(
      `UPDATE galaxy_pois SET dockable = ?, updated_at = datetime('now') WHERE id = ?`,
      dockable ? 1 : 0,
      id,
    );
    if (changes === 0 && fallback) {
      getDb().prepare(`
        INSERT INTO galaxy_pois (id, name, system, type, dockable, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET
          dockable = excluded.dockable,
          updated_at = datetime('now')
      `).run(id, fallback.name, fallback.system, fallback.type ?? null, dockable ? 1 : 0);
    }
  } catch (e) {
    log.error(`Failed to mark dockable for POI ${id}`, { error: e });
  }
}

/** Returns true/false based on stored dockable value, or null if unknown. */
export function isDockable(id: string): boolean | null {
  try {
    const row = queryOne<{ dockable: number | null }>('SELECT dockable FROM galaxy_pois WHERE id = ?', id);
    if (!row) return null;
    if (row.dockable === null) return null;
    return row.dockable === 1;
  } catch (e) {
    log.error(`Failed to check dockable for POI ${id}`, { error: e });
    return null;
  }
}

/** Return all registered POIs ordered by system and name, with dockable status. */
export function getAllPois(): (GalaxyPoi & { dockable?: boolean })[] {
  try {
    return queryAll<PoiRow>('SELECT * FROM galaxy_pois ORDER BY system, name').map(row => ({
      ...rowToPoi(row),
      dockable: row.dockable === null ? undefined : row.dockable === 1,
    }));
  } catch (e) {
    log.error('Failed to get all POIs', { error: e });
    return [];
  }
}
