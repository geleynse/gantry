import { describe, it, expect } from "bun:test";
import { addErrorHint } from "./error-hints.js";

describe("addErrorHint", () => {
  it("adds hint for 'not docked' error", () => {
    const msg = "[not_docked] You are not docked at a base";
    const result = addErrorHint(msg);
    expect(result).toContain(msg);
    expect(result).toContain("Hint:");
    expect(result).toContain("dock");
  });

  it("adds hint for 'cargo full' error", () => {
    const msg = "[cargo_full] Cargo Full";
    const result = addErrorHint(msg);
    expect(result).toContain("Hint:");
    expect(result).toContain("multi_sell");
  });

  it("adds hint for 'not enough fuel' error", () => {
    const msg = "[low_fuel] Not enough fuel to jump";
    const result = addErrorHint(msg);
    expect(result).toContain("Hint:");
    expect(result).toContain("refuel");
  });

  it("adds hint for 'insufficient credits' error", () => {
    const msg = "[funds] Insufficient Credits";
    const result = addErrorHint(msg);
    expect(result).toContain("Hint:");
    expect(result).toContain("credits");
  });

  it("adds hint for 'in transit' error", () => {
    const msg = "[busy] Ship is in transit";
    const result = addErrorHint(msg);
    expect(result).toContain("Hint:");
    expect(result).toContain("Wait");
  });

  it("adds hint for 'in combat' error", () => {
    const msg = "[combat] You are in combat";
    const result = addErrorHint(msg);
    expect(result).toContain("Hint:");
  });

  it("passes through unrecognized errors unchanged", () => {
    const msg = "[unknown_error] Something weird happened";
    const result = addErrorHint(msg);
    expect(result).toBe(msg);
  });

  it("is case insensitive", () => {
    const msg = "[err] NOT DOCKED at station";
    const result = addErrorHint(msg);
    expect(result).toContain("Hint:");
  });
});

describe("addErrorHint with context", () => {
  it("provides cargo-specific hint when context provided", () => {
    const msg = "Cargo Full";
    const context = { cargoUsed: 340, cargoCapacity: 350 };
    const result = addErrorHint(msg, context);
    expect(result).toContain("340/350");
    expect(result).toContain("Sell items or upgrade");
  });

  it("provides credits-specific hint when context provided", () => {
    const msg = "Insufficient Credits";
    const context = { credits: 45 };
    const result = addErrorHint(msg, context);
    expect(result).toContain("45cr");
    expect(result).toContain("Mine and sell");
  });

  it("provides fuel-specific hint when context provided", () => {
    const msg = "Not enough fuel";
    const context = { fuel: 12 };
    const result = addErrorHint(msg, context);
    expect(result).toContain("12/100");
    expect(result).toContain("Dock at the nearest station");
  });

  it("suggests installing weapon when no weapon equipped", () => {
    const msg = "No weapon module equipped";
    const context = { hasWeapon: false };
    const result = addErrorHint(msg, context);
    expect(result).toContain("No weapon equipped");
    expect(result).toContain("install_mod");
  });

  it("suggests mining at asteroid belt when not docked at belt", () => {
    const msg = "Not docked";
    const context = { currentPoi: "asteroid_belt_1" };
    const result = addErrorHint(msg, context);
    expect(result).toContain("asteroid belt");
    expect(result).toContain("Travel to a station");
  });

  it("suggests docking when not docked at station", () => {
    const msg = "Not docked";
    const context = { currentPoi: "krynn_base", docked: false };
    const result = addErrorHint(msg, context);
    expect(result).toContain("not docked");
    expect(result).toContain("Use dock");
  });

  it("suggests trading tools when at docked station", () => {
    const msg = "Action blocked";
    const context = { currentPoi: "krynn_base", docked: true };
    const result = addErrorHint(msg, context);
    // Should not contain mining suggestions
    expect(result).not.toContain("batch_mine");
  });

  it("works with partial context", () => {
    const msg = "Cargo Full";
    const context = { cargoUsed: 350 }; // Missing cargoCapacity
    const result = addErrorHint(msg, context);
    expect(result).toContain("Hint:");
  });

  it("falls back to generic hint when context doesn't match", () => {
    const msg = "Cargo Full";
    const context = { credits: 100 }; // Credits not relevant
    const result = addErrorHint(msg, context);
    expect(result).toContain("Hint:");
    expect(result).toContain("multi_sell");
  });

  it("is backward compatible without context", () => {
    const msg = "Cargo Full";
    const result = addErrorHint(msg);
    expect(result).toContain("Hint:");
    expect(result).toContain("multi_sell");
  });

  it("provides POI-specific hint for no_base at asteroid belt", () => {
    const msg = "[no_base] Cannot dock here";
    const context = { currentPoi: "cygni_asteroid_belt" };
    const result = addErrorHint(msg, context);
    expect(result).toContain("cygni_asteroid_belt");
    expect(result).toContain("not a station");
    expect(result).toContain("get_system");
  });

  it("provides POI-specific hint for no_base at anomaly", () => {
    const msg = "[no_base] No base here";
    const context = { currentPoi: "sigma_anomaly" };
    const result = addErrorHint(msg, context);
    expect(result).toContain("sigma_anomaly");
    expect(result).toContain("not a station");
  });

  it("provides POI-specific hint for dock_verification_failed at remnants", () => {
    const msg = "dock_verification_failed: Dock returned 'completed' but you are NOT docked. This POI may not be a base.";
    const context = { currentPoi: "old_empire_remnants" };
    const result = addErrorHint(msg, context);
    expect(result).toContain("old_empire_remnants");
    expect(result).toContain("not a station");
  });

  it("uses generic dock hint for no_base without POI context", () => {
    const msg = "[no_base] Cannot dock";
    const result = addErrorHint(msg);
    expect(result).toContain("Hint:");
    // Hint tells the agent to re-sync state and find a station
    expect(result).toContain("get_state");
    expect(result).toContain("station");
  });

  it("uses generic dock hint for dock_verification_failed without context", () => {
    const msg = "dock_verification_failed: action failed";
    const result = addErrorHint(msg);
    expect(result).toContain("Hint:");
    expect(result).toContain("dockable station");
  });
});

describe("addErrorHint — v0.332 no_life_support", () => {
  it("adds hint for no_life_support error code", () => {
    const msg = "[no_life_support] Life support is already at maximum capacity";
    const result = addErrorHint(msg);
    expect(result).toContain("Hint:");
    expect(result).toContain("structurally maxed");
  });

  it("suggests building elsewhere for no_life_support", () => {
    const msg = "[no_life_support] Cannot expand life support here";
    const result = addErrorHint(msg);
    expect(result).toContain("Build elsewhere");
  });

  it("is case insensitive for no_life_support", () => {
    const msg = "[err] NO_LIFE_SUPPORT limit reached";
    const result = addErrorHint(msg);
    expect(result).toContain("Hint:");
    expect(result).toContain("structurally maxed");
  });
});

describe("addErrorHint — v0.360/v0.361 durable-txn codes", () => {
  it("adds a verify-then-retry hint for persist_failed", () => {
    const result = addErrorHint("[persist_failed] durable write was reverted");
    expect(result).toContain("Hint:");
    expect(result).toContain("get_status");
    expect(result.toLowerCase()).toContain("revert");
  });

  it("adds a verify-then-retry hint for persist_timeout", () => {
    const result = addErrorHint("[persist_timeout] durable write timed out");
    expect(result).toContain("Hint:");
    expect(result).toContain("get_status");
  });
});

describe("addErrorHint — v0.342 facility idle_reason enum", () => {
  it("explains no_inputs idle facilities", () => {
    const result = addErrorHint("facility idle: no_inputs");
    expect(result).toContain("Hint:");
    expect(result.toLowerCase()).toContain("input");
  });

  it("explains output_storage_full idle facilities", () => {
    const result = addErrorHint("facility idle_reason=output_storage_full");
    expect(result).toContain("Hint:");
  });
});
