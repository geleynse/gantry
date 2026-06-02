/**
 * Static v1 → v2 tool dispatch tables and helper.
 *
 * Extracted from passthrough-handler.ts so that internal callers (routines,
 * compound tools, prayer executor) can dispatch directly via
 * HttpGameClientV2.execute() without re-routing through executeForClient.
 *
 * Without this shared lookup, a routine calling `client.execute("analyze_market")`
 * would hit the v2 game server with an unknown tool name and fail with
 * `-32602 Unknown tool: analyze_market`.
 */
import { V2_TO_V1_PARAM_MAP } from "./schema.js";

/**
 * v1 tool name → { v2Tool, v2Action }. Anything not in this map is presumed
 * to already be a v2-namespaced tool (or an unknown name the game will reject).
 */
export const V1_TO_V2_DISPATCH: Record<string, { tool: string; action: string }> = {
  // spacemolt (default namespace)
  mine: { tool: "spacemolt", action: "mine" },
  travel: { tool: "spacemolt", action: "travel" },
  jump: { tool: "spacemolt", action: "jump" },
  jump_route: { tool: "spacemolt", action: "jump_route" },
  dock: { tool: "spacemolt", action: "dock" },
  undock: { tool: "spacemolt", action: "undock" },
  refuel: { tool: "spacemolt", action: "refuel" },
  repair: { tool: "spacemolt", action: "repair" },
  sell: { tool: "spacemolt", action: "sell" },
  buy: { tool: "spacemolt", action: "buy" },
  craft: { tool: "spacemolt", action: "craft" },
  jettison: { tool: "spacemolt", action: "jettison" },
  install_mod: { tool: "spacemolt", action: "install_mod" },
  uninstall_mod: { tool: "spacemolt", action: "uninstall_mod" },
  repair_module: { tool: "spacemolt", action: "repair_module" },
  use_item: { tool: "spacemolt", action: "use_item" },
  cloak: { tool: "spacemolt", action: "cloak" },
  self_destruct: { tool: "spacemolt", action: "self_destruct" },
  survey_system: { tool: "spacemolt", action: "survey_system" },
  distress_signal: { tool: "spacemolt", action: "distress_signal" },
  // query actions
  get_status: { tool: "spacemolt", action: "get_status" },
  get_state: { tool: "spacemolt", action: "get_state" },
  get_player: { tool: "spacemolt", action: "get_player" },
  get_location: { tool: "spacemolt", action: "get_location" },
  get_queue: { tool: "spacemolt", action: "get_queue" },
  get_ship: { tool: "spacemolt", action: "get_ship" },
  get_cargo: { tool: "spacemolt", action: "get_cargo" },
  get_nearby: { tool: "spacemolt", action: "get_nearby" },
  get_system: { tool: "spacemolt", action: "get_system" },
  get_skills: { tool: "spacemolt", action: "get_skills" },
  get_poi: { tool: "spacemolt", action: "get_poi" },
  get_base: { tool: "spacemolt", action: "get_base" },
  get_map: { tool: "spacemolt", action: "get_map" },
  get_version: { tool: "spacemolt", action: "get_version" },
  get_notifications: { tool: "spacemolt", action: "get_notifications" },
  get_commands: { tool: "spacemolt", action: "get_commands" },
  search_systems: { tool: "spacemolt", action: "search_systems" },
  find_route: { tool: "spacemolt", action: "find_route" },
  scan: { tool: "spacemolt", action: "scan" },
  // mission actions
  get_missions: { tool: "spacemolt", action: "get_missions" },
  get_active_missions: { tool: "spacemolt", action: "get_active_missions" },
  accept_mission: { tool: "spacemolt", action: "accept_mission" },
  complete_mission: { tool: "spacemolt", action: "complete_mission" },
  decline_mission: { tool: "spacemolt", action: "decline_mission" },
  abandon_mission: { tool: "spacemolt", action: "abandon_mission" },
  completed_missions: { tool: "spacemolt", action: "completed_missions" },
  view_completed_mission: { tool: "spacemolt", action: "view_completed_mission" },
  missions: { tool: "spacemolt", action: "get_missions" },
  // market namespace
  view_market: { tool: "spacemolt_market", action: "view_market" },
  view_orders: { tool: "spacemolt_market", action: "view_orders" },
  estimate_purchase: { tool: "spacemolt_market", action: "estimate_purchase" },
  analyze_market: { tool: "spacemolt_market", action: "analyze_market" },
  create_sell_order: { tool: "spacemolt_market", action: "create_sell_order" },
  create_buy_order: { tool: "spacemolt_market", action: "create_buy_order" },
  cancel_order: { tool: "spacemolt_market", action: "cancel_order" },
  modify_order: { tool: "spacemolt_market", action: "modify_order" },
  // catalog
  catalog: { tool: "spacemolt_catalog", action: "" },
  // storage namespace
  view_storage: { tool: "spacemolt_storage", action: "view" },
  view_faction_storage: { tool: "spacemolt_storage", action: "view_faction" },
  deposit_items: { tool: "spacemolt_storage", action: "deposit" },
  withdraw_items: { tool: "spacemolt_storage", action: "withdraw" },
  // battle namespace
  attack: { tool: "spacemolt_battle", action: "engage" },
  reload: { tool: "spacemolt_battle", action: "reload" },
  battle: { tool: "spacemolt_battle", action: "" },
  get_battle_status: { tool: "spacemolt_battle", action: "status" },
  // salvage namespace
  get_wrecks: { tool: "spacemolt_salvage", action: "wrecks" },
  loot_wreck: { tool: "spacemolt_salvage", action: "loot" },
  salvage_wreck: { tool: "spacemolt_salvage", action: "salvage" },
  scrap_wreck: { tool: "spacemolt_salvage", action: "scrap" },
  tow_wreck: { tool: "spacemolt_salvage", action: "tow" },
  release_tow: { tool: "spacemolt_salvage", action: "release" },
  sell_wreck: { tool: "spacemolt_salvage", action: "sell" },
  buy_insurance: { tool: "spacemolt_salvage", action: "insure" },
  get_insurance_quote: { tool: "spacemolt_salvage", action: "quote" },
  view_insurance: { tool: "spacemolt_salvage", action: "view_insurance" },
  // ship namespace
  commission_status: { tool: "spacemolt_ship", action: "commission_status" },
  commission_ship: { tool: "spacemolt_ship", action: "commission" },
  // social namespace
  captains_log_list: { tool: "spacemolt_social", action: "captains_log_list" },
  captains_log_get: { tool: "spacemolt_social", action: "captains_log_get" },
  captains_log_add: { tool: "spacemolt_social", action: "captains_log_add" },
  // facility namespace — v0.327 Recycling Processor
  // configure_recycler(facility_id, recipe_id) → spacemolt_facility(action="configure_recycler", facility_id, recipe_id)
  // Params are kept as-is (no generic id/text rename) — game API uses explicit names on this action.
  configure_recycler: { tool: "spacemolt_facility", action: "configure_recycler" },
};

/**
 * Inverse of V2_TO_V1_PARAM_MAP per v2 action — for outbound v1 → v2
 * arg-name renames (target_system → id, wreck_id → id, etc.).
 */
const V1_TO_V2_PARAM_MAP: Record<string, Record<string, string>> = (() => {
  const inverted: Record<string, Record<string, string>> = {};
  for (const [action, paramMap] of Object.entries(V2_TO_V1_PARAM_MAP)) {
    const inverse: Record<string, string> = {};
    for (const [v2Param, v1Param] of Object.entries(paramMap)) {
      if (v2Param === v1Param) continue;
      if (inverse[v1Param] !== undefined) continue;
      inverse[v1Param] = v2Param;
    }
    inverted[action] = inverse;
  }
  return inverted;
})();

export function translateV1ArgsToV2(action: string, args: Record<string, unknown> | undefined): Record<string, unknown> {
  const paramMap = V1_TO_V2_PARAM_MAP[action];
  if (!paramMap || !args) return { ...(args ?? {}) };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const renamed = paramMap[key] ?? key;
    out[renamed] = value;
  }
  return out;
}

/** Per-action arg-name aliases for actions where agents send the wrong param name. */
export const V2_AGENT_ARG_ALIASES: Record<string, Record<string, string>> = {
  deposit: { id: "item_id" },
  withdraw: { id: "item_id" },
};

export function applyV2ArgAliases(action: string, args: Record<string, unknown>): Record<string, unknown> {
  const aliases = V2_AGENT_ARG_ALIASES[action];
  if (!aliases) return args;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    const target = aliases[k] ?? k;
    // Don't clobber an explicit v2 name with an alias-renamed value.
    if (out[target] === undefined) out[target] = v;
  }
  return out;
}

/** Tools that use generic v2 param names (id, text). Others keep v1-style explicit names. */
const TRANSLATE_TOOLS = new Set(["spacemolt", "spacemolt_battle", "spacemolt_salvage", "spacemolt_ship"]);

/**
 * Translate a v1-style flat call (`toolName + args`) into a v2 call shape
 * (`{tool, args}` where args includes `action`). Returns null when toolName
 * is not a v1 alias — caller should pass through as-is.
 */
export function dispatchV1ToV2(
  toolName: string,
  args?: Record<string, unknown>,
): { tool: string; args: Record<string, unknown> } | null {
  const dispatch = V1_TO_V2_DISPATCH[toolName];
  if (!dispatch) return null;

  // catalog uses `type` not `action`
  if (dispatch.tool === "spacemolt_catalog") {
    const { action: _drop, ...rest } = (args ?? {}) as Record<string, unknown>;
    return { tool: "spacemolt_catalog", args: rest };
  }

  // battle sub-actions: caller passes action via args.action
  if (dispatch.tool === "spacemolt_battle" && dispatch.action === "" && args?.action) {
    const subAction = String(args.action);
    return { tool: "spacemolt_battle", args: translateV1ArgsToV2(subAction, args) };
  }

  const shouldTranslate = TRANSLATE_TOOLS.has(dispatch.tool);
  const finalArgs = shouldTranslate ? translateV1ArgsToV2(dispatch.action, args) : { ...(args ?? {}) };
  const { action: _agentAction, ...argsNoAction } = finalArgs;
  const renamed = applyV2ArgAliases(dispatch.action, argsNoAction);
  return { tool: dispatch.tool, args: { action: dispatch.action, ...renamed } };
}
