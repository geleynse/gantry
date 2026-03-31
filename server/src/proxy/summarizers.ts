import { createLogger } from "../lib/logger.js";

const log = createLogger("summarizers");

type Summarizer = (result: unknown) => unknown;

// Fields stripped from all unsummarized tool responses.
// These are purely for database/sync logic and contain no game-world info.
const SKIP_FIELDS = new Set([
  "created_at", "last_login_at", "last_active_at", "joined_at", "last_seen",
  "primary_color", "secondary_color",
]);

/**
 * Transparently pick fields but log any unknown ones.
 * Always includes all fields from obj that are NOT in SKIP_FIELDS.
 * Fields in 'importantKeys' are considered "known" and don't trigger discovery logs.
 */
function discoverPick<T extends Record<string, unknown>>(
  toolName: string,
  obj: T,
  importantKeys: string[]
): Partial<T> {
  const out: Record<string, unknown> = {};
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out as Partial<T>;
  
  const known = new Set(importantKeys);
  
  // 1. Process all fields in the object
  for (const [k, v] of Object.entries(obj)) {
    if (SKIP_FIELDS.has(k)) continue;

    out[k] = v;

    // 2. If it's a new field we didn't explicitly expect, log it for developers
    if (!known.has(k) && !k.startsWith("_")) {
      log.info(`[discovery] New field in ${toolName}: "${k}"`, { 
        tool: toolName, 
        field: k,
        value_type: typeof v
      });
    }
  }

  return out as Partial<T>;
}

function stripFields(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(stripFields);
  if (typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (!SKIP_FIELDS.has(k)) {
        out[k] = typeof v === "object" ? stripFields(v) : v;
      }
    }
    return out;
  }
  return obj;
}

function limitArray(arr: unknown[] | undefined, max: number): unknown[] {
  if (!arr) return [];
  return arr.slice(0, max);
}

const SUMMARIZERS: Record<string, Summarizer> = {
  get_status: (r) => {
    const d = (r && typeof r === "object") ? r as Record<string, unknown> : {};
    const ship = d.ship && typeof d.ship === "object" ? d.ship as Record<string, unknown> : undefined;
    
    let modules = ship?.modules;
    if (Array.isArray(modules)) {
      modules = (modules as Record<string, unknown>[]).map(m => 
        discoverPick("module", m, ["id", "name", "slot_type", "slot", "type", "item_id", "item_name", "module_id", "module_name"])
      );
    }

    const summarized = discoverPick("get_status", d, ["username", "credits", "current_system", "current_poi", "docked_at_base", "skills", "stats", "discovered_systems", "status_message", "ship"]);
    if (ship) {
      summarized.ship = {
        ...discoverPick("ship", ship, ["name", "class_id", "hull", "max_hull", "shield", "max_shield", "fuel", "max_fuel", "cargo_used", "cargo_capacity", "stats", "position", "modules"]),
        modules
      };
    }
    return summarized;
  },
  get_system: (r) => {
    const raw = r as Record<string, unknown>;
    const sys = (raw.system ?? raw) as Record<string, unknown>;
    const d = discoverPick("get_system", sys, ["id", "name", "empire", "connections", "pois", "police_level", "position"]);
    if (Array.isArray(d.pois)) {
      d.pois = (d.pois as Record<string, unknown>[]).map((p) => discoverPick("poi", p, ["id", "name", "type", "resources", "services"]));
    }
    return d;
  },
  get_nearby: (r) => {
    const d = r as Record<string, unknown>;
    const nearby = (d.nearby as Record<string, unknown>[] | undefined) ?? [];
    const summarized = discoverPick("get_nearby", d, ["count", "nearby"]);
    summarized.nearby = limitArray(nearby, 10).map((p) => discoverPick("nearby_player", p as Record<string, unknown>, ["username", "ship_class", "faction", "in_combat", "position", "status_message"]));
    return summarized;
  },
  get_ship: (r) => {
    const ship = (r && typeof r === "object") ? r as Record<string, unknown> : {};
    let modules = ship.modules;
    if (Array.isArray(modules)) {
      modules = (modules as Record<string, unknown>[]).map(m => 
        discoverPick("module", m, ["id", "name", "slot_type", "slot", "type", "item_id", "item_name", "module_id", "module_name"])
      );
    }
    const summarized = discoverPick("get_ship", ship, ["name", "class_id", "hull", "max_hull", "shield", "max_shield", "fuel", "max_fuel", "cargo_used", "cargo_capacity", "stats", "modules"]);
    summarized.modules = modules;
    return summarized;
  },
  mine: (r) => discoverPick("mine", r as Record<string, unknown>, ["ore_type", "quantity", "message"]),
  travel: (r) => discoverPick("travel", r as Record<string, unknown>, ["ticks", "destination", "message"]),
  jump: (r) => discoverPick("jump", r as Record<string, unknown>, ["ticks", "destination", "message"]),
  get_cargo: (r) => {
    const d = (r && typeof r === "object") ? r as Record<string, unknown> : {};
    const items = (d.cargo as unknown[] | undefined) ?? (d.items as unknown[] | undefined) ?? (Array.isArray(d) ? d : []);
    const summarized = discoverPick("get_cargo", d, ["cargo_used", "cargo_capacity", "items"]);
    summarized.items = items.map((i) => discoverPick("cargo_item", (i && typeof i === "object" ? i as Record<string, unknown> : {}), ["item_id", "name", "quantity", "category", "size"]));
    return summarized;
  },
  scan: (r) => {
    const d = r as Record<string, unknown>;
    const entities = (d.entities as unknown[] | undefined) ?? (d.nearby as unknown[] | undefined) ?? (Array.isArray(d) ? d : []);
    const summarized = discoverPick("scan", d, ["count", "entities"]);
    summarized.entities = limitArray(entities, 15).map((e) => discoverPick("entity", e as Record<string, unknown>, ["id", "username", "ship_class", "faction", "in_combat", "type", "name", "position", "status_message"]));
    return summarized;
  },
  get_active_missions: (r) => {
    const d = r as Record<string, unknown>;
    const missions = (d.missions as unknown[] | undefined) ?? (Array.isArray(d) ? d : []);
    const summarized = discoverPick("get_active_missions", d, ["missions"]);
    summarized.missions = limitArray(missions, 5).map((m) => discoverPick("mission", m as Record<string, unknown>, ["id", "title", "objectives", "reward", "status"]));
    return summarized;
  },
  find_route: (r) => {
    const d = r as Record<string, unknown>;
    const route = (d.route as unknown[] | undefined) ?? [];
    const summarized = discoverPick("find_route", d, ["jumps", "route", "fuel_estimate", "fuel_per_jump", "current_fuel", "total_fuel"]);
    summarized.route = route.map((s) => discoverPick("route_step", s as Record<string, unknown>, ["id", "name", "fuel_cost"]));
    return summarized;
  },
  search_systems: (r) => {
    const d = r as Record<string, unknown>;
    const systems = (d.systems as unknown[] | undefined) ?? (Array.isArray(d) ? d : []);
    const summarized = discoverPick("search_systems", d, ["count", "systems"]);
    summarized.systems = limitArray(systems, 10).map((s) => discoverPick("system_result", s as Record<string, unknown>, ["id", "name", "empire", "connections"]));
    return summarized;
  },
  get_missions: (r) => {
    const d = r as Record<string, unknown>;
    const missions = (d.missions as unknown[] | undefined) ?? (Array.isArray(d) ? d : []);
    const summarized = discoverPick("get_missions", d, ["missions"]);
    summarized.missions = limitArray(missions, 5).map((m) => discoverPick("mission", m as Record<string, unknown>, ["id", "title", "objectives", "reward"]));
    return summarized;
  },
  view_market: (r) => {
    const d = r as Record<string, unknown>;
    const orders = (d.orders as unknown[] | undefined) ?? (Array.isArray(d) ? d : []);
    const summarized = discoverPick("view_market", d, ["orders", "categories", "hint"]);
    summarized.orders = limitArray(orders, 15).map((o) => discoverPick("market_order", o as Record<string, unknown>, ["id", "item_id", "category", "quantity", "price", "my_quantity", "seller"]));
    return summarized;
  },
  forum_list: (r) => {
    const d = r as Record<string, unknown>;
    const threads = (d.threads as unknown[] | undefined) ?? (Array.isArray(d) ? d : []);
    const summarized = discoverPick("forum_list", d, ["total", "threads"]);
    summarized.threads = limitArray(threads, 20).map((t) => discoverPick("forum_thread", t as Record<string, unknown>, [
      "id", "title", "author", "author_empire", "author_faction_tag",
      "category", "reply_count", "upvotes", "pinned",
    ]));
    return summarized;
  },
  battle: (r) => discoverPick("battle", r as Record<string, unknown>, ["battle_id", "stance", "zone", "target", "message", "status"]),
  get_battle_status: (r) => discoverPick("get_battle_status", r as Record<string, unknown>, ["battle_id", "zone", "stance", "hull", "shields", "target", "combatants", "status"]),
  get_insurance_quote: (r) => discoverPick("get_insurance_quote", r as Record<string, unknown>, ["premium", "coverage", "policy_id", "message"]),
  buy_insurance: (r) => discoverPick("buy_insurance", r as Record<string, unknown>, ["policy_id", "premium", "coverage", "message"]),
  claim_insurance: (r) => discoverPick("claim_insurance", r as Record<string, unknown>, ["payout", "message", "status"]),
  salvage_wreck: (r) => {
    const d = r as Record<string, unknown>;
    const loot = (d.loot as unknown[] | undefined) ?? (d.items as unknown[] | undefined) ?? [];
    const summarized = discoverPick("salvage_wreck", d, ["wreck_id", "message", "loot"]);
    summarized.loot = limitArray(loot, 10).map((i) => discoverPick("loot_item", i as Record<string, unknown>, ["item_id", "name", "quantity"]));
    return summarized;
  },
  craft: (r) => {
    const d = r as Record<string, unknown>;
    const outputs = (d.outputs as unknown[] | undefined) ?? [];
    const summarized = discoverPick("craft", d, ["recipe_id", "message", "outputs"]);
    summarized.outputs = outputs.map((o) => discoverPick("craft_output", o as Record<string, unknown>, ["item_id", "name", "quantity", "bonus_quantity"]));
    return summarized;
  },
  view_storage: (r) => {
    const d = r as Record<string, unknown>;
    const items = (d.items as unknown[] | undefined) ?? (Array.isArray(d) ? d : []);
    const summarized = discoverPick("view_storage", d, ["station_id", "items"]);
    summarized.items = items.map((i) => discoverPick("storage_item", i as Record<string, unknown>, ["item_id", "name", "quantity", "size", "instance_id"]));
    return summarized;
  },
  commission_status: (r) => {
    const d = r as Record<string, unknown>;
    const picked = discoverPick("commission_status", d, ["status", "ship_class", "ship_class_id", "materials_gathered", "required_materials", "completion_percentage", "message"]);
    if (Object.keys(picked).length === 0) {
      return { status: "none", message: "No active ship commission. Use commission_quote to check prices, then commission_ship to start one." };
    }
    return picked;
  },
  forum_get_thread: (r) => {
    const d = r as Record<string, unknown>;
    const replies = (d.replies as unknown[] | undefined) ?? [];
    const summarized = discoverPick("forum_get_thread", d, ["title", "author", "author_empire", "author_faction_tag", "category", "upvotes", "created_at", "content", "reply_count", "replies"]);
    summarized.replies = replies.map((reply) => discoverPick("forum_reply", reply as Record<string, unknown>, ["author", "author_empire", "author_faction_tag", "content", "upvotes", "created_at"]));
    return summarized;
  },
};

function isErrorResponse(result: unknown): boolean {
  if (result === null || result === undefined) return false;
  if (typeof result !== "object") return false;
  return "error" in (result as Record<string, unknown>);
}

function isPendingResponse(result: unknown): boolean {
  if (result === null || result === undefined) return false;
  if (typeof result !== "object") return false;
  return "pending" in (result as Record<string, unknown>);
}

export function summarizeToolResult(toolName: string, result: unknown): unknown {
  if (isErrorResponse(result)) return result;
  if (isPendingResponse(result)) return result;
  
  // Hardened input check to prevent "obj is not an Object" errors
  if (result === null || result === undefined || typeof result !== "object") {
    return result;
  }

  const summarizer = SUMMARIZERS[toolName];
  let summarized = summarizer ? summarizer(result) : stripFields(result);

  // Preserve proxy-injected fields (starting with _) that might have been
  // added before summarization (e.g. _nav_warning, _calledTools).
  if (typeof result === "object" && result !== null && typeof summarized === "object" && summarized !== null) {
    const resObj = result as Record<string, unknown>;
    const sumObj = summarized as Record<string, unknown>;
    for (const key of Object.keys(resObj)) {
      if (key.startsWith("_") && !(key in sumObj)) {
        sumObj[key] = resObj[key];
      }
    }
  }

  return summarized;
}
