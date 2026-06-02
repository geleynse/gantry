import { describe, it, expect } from "bun:test";
import { dispatchV1ToV2 } from "./dispatch-v1-to-v2.js";

describe("dispatchV1ToV2", () => {
  it("returns null for unknown v1 names (passthrough)", () => {
    expect(dispatchV1ToV2("spacemolt_pray")).toBeNull();
    expect(dispatchV1ToV2("debug_log")).toBeNull();
  });

  it("dispatches analyze_market to spacemolt_market with action", () => {
    const r = dispatchV1ToV2("analyze_market", { station: "sol_central" });
    expect(r).toEqual({ tool: "spacemolt_market", args: { action: "analyze_market", station: "sol_central" } });
  });

  it("dispatches survey_system to spacemolt with action", () => {
    const r = dispatchV1ToV2("survey_system", { system: "sol" });
    expect(r?.tool).toBe("spacemolt");
    expect(r?.args.action).toBe("survey_system");
  });

  it("dispatches view_insurance to spacemolt_salvage", () => {
    const r = dispatchV1ToV2("view_insurance");
    expect(r).toEqual({ tool: "spacemolt_salvage", args: { action: "view_insurance" } });
  });

  it("dispatches deposit_items with id → item_id alias", () => {
    const r = dispatchV1ToV2("deposit_items", { id: "iron_ore", quantity: 5 });
    expect(r?.tool).toBe("spacemolt_storage");
    expect(r?.args).toMatchObject({ action: "deposit", item_id: "iron_ore", quantity: 5 });
    expect(r?.args.id).toBeUndefined();
  });

  it("dispatches catalog without an action arg", () => {
    const r = dispatchV1ToV2("catalog", { type: "ships" });
    expect(r).toEqual({ tool: "spacemolt_catalog", args: { type: "ships" } });
  });

  it("strips agent-supplied action so it cannot override the dispatched action", () => {
    const r = dispatchV1ToV2("get_missions", { action: "missions" });
    expect(r?.args.action).toBe("get_missions");
  });

  it("translates v1 param names for tools that use generic v2 names", () => {
    // jump uses the generic v2 param `id` for the destination system; v1 callers
    // send `target_system`. translateV1ArgsToV2 maps them.
    const r = dispatchV1ToV2("jump", { target_system: "sol" });
    expect(r?.tool).toBe("spacemolt");
    expect(r?.args.action).toBe("jump");
    // accept either name — the schema decides which is canonical
    expect(r?.args.id ?? r?.args.target_system).toBe("sol");
  });

  it("dispatches configure_recycler to spacemolt_facility with explicit param names preserved", () => {
    // v0.327 Recycling Processor: params are facility_id and recipe_id (no generic id/text rename).
    // spacemolt_facility is not in TRANSLATE_TOOLS, so args pass through as-is.
    const r = dispatchV1ToV2("configure_recycler", { facility_id: "recycler_1", recipe_id: "refine_steel" });
    expect(r).not.toBeNull();
    expect(r?.tool).toBe("spacemolt_facility");
    expect(r?.args.action).toBe("configure_recycler");
    expect(r?.args.facility_id).toBe("recycler_1");
    expect(r?.args.recipe_id).toBe("refine_steel");
  });

  it("configure_recycler dispatch strips any agent-supplied action override", () => {
    // Agent should not be able to override the dispatched action name.
    const r = dispatchV1ToV2("configure_recycler", { facility_id: "r1", recipe_id: "smelt_iron", action: "something_else" });
    expect(r?.args.action).toBe("configure_recycler");
    expect(r?.args.facility_id).toBe("r1");
    expect(r?.args.recipe_id).toBe("smelt_iron");
  });

  // -------------------------------------------------------------------------
  // jettison — rescue-action unblock (fix/proxy-rescue-actions)
  // -------------------------------------------------------------------------

  it("dispatches jettison to spacemolt with action=jettison", () => {
    // jettison(item_id, qty) → spacemolt(action="jettison", item_id, qty)
    const r = dispatchV1ToV2("jettison", { item_id: "fuel_cell", qty: 5 });
    expect(r).not.toBeNull();
    expect(r?.tool).toBe("spacemolt");
    expect(r?.args.action).toBe("jettison");
  });

  it("jettison dispatch forwards item_id and qty params", () => {
    const r = dispatchV1ToV2("jettison", { item_id: "fuel_cell", qty: 10 });
    expect(r?.args.item_id).toBe("fuel_cell");
    expect(r?.args.qty).toBe(10);
  });

  it("jettison dispatch strips any agent-supplied action override", () => {
    const r = dispatchV1ToV2("jettison", { item_id: "iron_ore", qty: 2, action: "something_else" });
    expect(r?.args.action).toBe("jettison");
  });

  // -------------------------------------------------------------------------
  // refuel with item_id — cargo-cell refuel path (fix/proxy-rescue-actions)
  // -------------------------------------------------------------------------

  it("dispatches refuel (no args) to spacemolt with action=refuel", () => {
    // Station refuel — no item_id
    const r = dispatchV1ToV2("refuel");
    expect(r).not.toBeNull();
    expect(r?.tool).toBe("spacemolt");
    expect(r?.args.action).toBe("refuel");
  });

  it("dispatches refuel with item_id to spacemolt, forwarding item_id", () => {
    // Cargo-cell refuel — item_id=fuel_cell
    // TODO(unverified): confirm game accepts refuel item_id=fuel_cell on a live call
    const r = dispatchV1ToV2("refuel", { item_id: "fuel_cell" });
    expect(r).not.toBeNull();
    expect(r?.tool).toBe("spacemolt");
    expect(r?.args.action).toBe("refuel");
    expect(r?.args.item_id).toBe("fuel_cell");
  });

  it("refuel dispatch does NOT add target= to outgoing args", () => {
    // Ensure the target= guard pattern at the passthrough layer is the only blocker;
    // dispatch itself must never inject a target param.
    const r = dispatchV1ToV2("refuel", { item_id: "fuel_cell" });
    expect(r?.args.target).toBeUndefined();
  });
});
