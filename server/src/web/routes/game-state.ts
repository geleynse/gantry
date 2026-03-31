import { Router } from 'express';
import { createLogger } from '../../lib/logger.js';
import { getItemName as getFallbackName } from '../../lib/utils.js';
import { AgentGameStateSchema } from '../../shared/schemas.js';
import type { MarketCache } from '../../proxy/market-cache.js';
import { resolveName, getType, learnFromObjects } from '../../services/learned-metadata.js';
import { getItem } from '../../services/game-item-registry.js';

const log = createLogger('game-state');

interface ModuleSlot {
  slot_type?: "weapon" | "defense" | "utility" | string;
  item_id?: string;
  item_name?: string;
  id?: string;
  type?: string;
  name?: string;
}

interface CargoItem {
  item_id?: string;
  name?: string;
  quantity?: number;
}

interface SkillData {
  name?: string;
  level?: number;
  xp?: number;
  xp_to_next?: number;
}

interface GantryGameState {
  player?: {
    credits?: number;
    current_system?: string;
    current_poi?: string;
    current_ship_id?: string;
    home_system?: string;
    home_poi?: string;
    faction_name?: string;
    faction_tag?: string;
    faction_storage_used?: number;
    faction_storage_max?: number;
    skills?: Record<string, unknown>;
  };
  ship?: {
    name?: string;
    class_id?: string;
    hull?: number;
    max_hull?: number;
    shield?: number;
    max_shield?: number;
    fuel?: number;
    max_fuel?: number;
    cargo_used?: number;
    cargo_capacity?: number;
    modules?: unknown[];
    cargo?: unknown[];
  };
  modules?: unknown[];
}

/** Map game-specific module types to display categories used by the frontend. */
const MODULE_TYPE_CATEGORY: Record<string, string> = {
  weapon: "weapon",
  laser: "weapon",
  blaster: "weapon",
  shield: "defense",
  armor: "defense",
  defense: "defense",
  utility: "utility",
  scanner: "utility",
  engine: "utility",
  mining: "utility",
};

/** Infer slot category from a resolved module name when no type metadata is available. */
function inferSlotType(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (/laser|cannon|blaster|gun|turret|torpedo/.test(lower)) return 'weapon';
  if (/shield|armor|plate/.test(lower)) return 'defense';
  if (/drive|engine|scanner|sensor/.test(lower)) return 'utility';
  return undefined;
}


function normalizeModules(modules: unknown[], marketCache?: MarketCache): ModuleSlot[] {
  if (!Array.isArray(modules)) return [];
  
  // Learn any mappings present in the module objects
  learnFromObjects(modules);

  return modules.map((m) => {
    // Handle string IDs (some game versions return raw hex IDs for modules)
    if (typeof m === 'string') {
      const registryItem = getItem(m);
      const resolvedName = resolveName(m) || registryItem?.name || marketCache?.getItemName(m) || null;
      if (!resolvedName) {
        log.info(`Unresolved module ID: ${m}`);
      }
      const learnedType = getType(m) || registryItem?.type;
      const inferredType = resolvedName ? inferSlotType(resolvedName) : undefined;
      const rawSlotType = learnedType ?? inferredType;
      return {
        slot_type: rawSlotType ? (MODULE_TYPE_CATEGORY[rawSlotType] ?? rawSlotType) : undefined,
        item_id: m,
        item_name: resolvedName || getFallbackName(m),
      };
    }

    const mod = m as Record<string, unknown>;
    const rawType = ((mod.slot_type ?? mod.type ?? mod.slot) as string | undefined)?.toLowerCase();
    const item_id = (mod.item_id ?? mod.id ?? mod.module_id) as string | undefined;
    const type_id = mod.type_id as string | undefined;
    const item_name = (mod.item_name ?? mod.name ?? mod.module_name) as string | undefined;
    
    if (!item_id && !item_name) {
      log.warn('Module data missing both id and name', { keys: Object.keys(mod), raw: JSON.stringify(mod).slice(0, 200) });
    }

    const registryItem = item_id ? getItem(item_id) : null;
    const resolvedName = item_name ||
      resolveName(item_id) ||
      registryItem?.name ||
      (type_id ? getFallbackName(type_id) : null) ||
      (item_id ? (marketCache?.getItemName(item_id) || getFallbackName(item_id)) : 'Unknown');
    const resolvedType = rawType || getType(item_id) || registryItem?.type;
    const inferredType = !resolvedType && resolvedName ? inferSlotType(resolvedName) : undefined;
    const finalType = resolvedType ?? inferredType;

    return {
      slot_type: finalType ? (MODULE_TYPE_CATEGORY[finalType] ?? finalType) : undefined,
      item_id,
      item_name: resolvedName,
    };
  });
}

function normalizeCargo(cargo: unknown[], marketCache?: MarketCache): CargoItem[] {
  if (!Array.isArray(cargo)) return [];
  
  // Learn any mappings present in the cargo objects
  learnFromObjects(cargo);

  return cargo.map((c) => {
    const item = c as Record<string, unknown>;
    const itemId = item.item_id as string | undefined;
    const name = item.name as string | undefined;
    
    const resolvedName = name || 
      resolveName(itemId) ||
      (itemId ? (marketCache?.getItemName(itemId) || getFallbackName(itemId)) : 'Unknown');

    return {
      item_id: itemId,
      name: resolvedName,
      quantity: item.quantity as number | undefined,
    };
  });
}

function normalizeSkills(skills: Record<string, unknown> | undefined): Record<string, SkillData> {
  if (!skills || typeof skills !== 'object') return {};
  const result: Record<string, SkillData> = {};
  for (const [skillName, skillData] of Object.entries(skills)) {
    if (typeof skillData === 'object' && skillData !== null) {
      const s = skillData as Record<string, unknown>;
      result[skillName] = {
        name: s.name as string | undefined,
        level: s.level as number | undefined,
        xp: s.xp as number | undefined,
        xp_to_next: s.xp_to_next as number | undefined,
      };
    }
  }
  return result;
}

function inferDockedAt(poi: string | undefined | null): string | null {
  if (!poi) return null;
  const lower = poi.toLowerCase();
  return (lower.includes('station') || lower.includes('base')) ? poi : null;
}

function buildFlatState(
  player: Record<string, unknown>,
  ship: GantryGameState['ship'] | undefined,
  fallbackModules: unknown[] | undefined,
  marketCache?: MarketCache,
): Record<string, unknown> {
  const poi = typeof player.current_poi === 'string' ? player.current_poi : undefined;
  return {
    credits: (player.credits as number) ?? 0,
    current_system: (player.current_system as string) ?? null,
    current_poi: poi ?? null,
    home_system: (player.home_system as string) ?? null,
    home_poi: (player.home_poi as string) ?? null,
    faction: (player.faction_name || player.faction_tag) ? {
      name: player.faction_name,
      tag: player.faction_tag,
      storage_used: player.faction_storage_used,
      storage_capacity: player.faction_storage_max
    } : null,
    docked_at_base: inferDockedAt(poi),
    ship: ship ? {
      name: ship.name ?? 'Unknown',
      class: ship.class_id ?? null,
      hull: ship.hull ?? 0,
      max_hull: ship.max_hull ?? 0,
      shield: ship.shield ?? 0,
      max_shield: ship.max_shield ?? 0,
      fuel: ship.fuel ?? 0,
      max_fuel: ship.max_fuel ?? 0,
      cargo_used: ship.cargo_used ?? 0,
      cargo_capacity: ship.cargo_capacity ?? 0,
      modules: normalizeModules((fallbackModules ?? ship.modules ?? []) as unknown[], marketCache),
      cargo: normalizeCargo((ship.cargo ?? []) as unknown[], marketCache),
    } : null,
    skills: normalizeSkills(player.skills as Record<string, unknown> | undefined),
  };
}

function withTimestamps(flat: Record<string, unknown>, fetchedAt: number): Record<string, unknown> {
  return {
    ...flat,
    data_age_s: Math.round((Date.now() - fetchedAt) / 1000),
    last_seen: new Date(fetchedAt).toISOString(),
  };
}

function flatten(raw: GantryGameState, marketCache?: MarketCache): Record<string, unknown> | null {
  if (!raw) return null;
  const rawAsAny = raw as Record<string, unknown>;
  const rawPlayer = rawAsAny.player as Record<string, unknown> | undefined;

  // Return null if there's no player data at all
  if (!rawPlayer && rawAsAny.credits === undefined) return null;

  // Merge root-level fields with the player wrapper to handle all format variations:
  // 1. Flat:   { credits, current_system, ship } — no player wrapper
  // 2. Nested: { player: { credits, current_system, ... }, ship: {...} }
  // 3. Mixed:  { credits, current_system, ship, player: { skills } } — skills-merge
  //            artifact where skills were merged into a flat-format response, creating
  //            a partial player wrapper. Without merging, buildFlatState would only see
  //            { skills } and return credits=0, current_system=null.
  const player: Record<string, unknown> = rawPlayer
    ? { ...rawAsAny, ...rawPlayer }  // root fields as base, player fields override
    : rawAsAny;

  const ship = (rawAsAny.ship ?? rawPlayer?.ship) as GantryGameState['ship'] | undefined;
  const flat = buildFlatState(player, ship, rawAsAny.modules as unknown[] | undefined, marketCache);

  // Pass through lifetime_stats if present — available in game v0.253+
  // May live at root level or inside the player wrapper
  const lifetimeStats = rawAsAny.lifetime_stats ?? rawPlayer?.lifetime_stats ?? player.lifetime_stats;
  if (lifetimeStats && typeof lifetimeStats === 'object') {
    flat.lifetime_stats = lifetimeStats;
  }

  return flat;
}

/**
 * Create the game-state router with direct access to the proxy's in-process statusCache.
 * Both the MCP proxy and web dashboard run in the same process, so no HTTP hop is needed.
 */
export function createGameStateRouter(
  statusCache: Map<string, { data: Record<string, unknown>; fetchedAt: number }>,
  marketCache?: MarketCache
): Router {
  const router = Router();

  router.get('/all', (_req, res) => {
    const result: Record<string, Record<string, unknown> | null> = {};
    for (const [agent, entry] of statusCache) {
      const flat = flatten(entry.data as GantryGameState, marketCache);
      if (flat) {
        const payload = withTimestamps(flat, entry.fetchedAt);
        // Validate shape — warn if game API response changed
        const check = AgentGameStateSchema.safeParse(payload);
        if (!check.success) {
          log.warn(`AgentGameState shape mismatch for ${agent}`, { issues: check.error.issues });
        }
        result[agent] = payload;
      }
    }
    res.json(result);
  });

  router.get('/:agent', (req, res) => {
    const entry = statusCache.get(req.params.agent);
    if (!entry) {
      res.json(null);
      return;
    }
    const flat = flatten(entry.data as GantryGameState, marketCache);
    if (!flat) {
      res.json(null);
      return;
    }
    res.json(withTimestamps(flat, entry.fetchedAt));
  });

  return router;
}

export default createGameStateRouter;
