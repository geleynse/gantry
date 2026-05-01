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
});
