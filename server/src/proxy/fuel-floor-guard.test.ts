import { describe, it, expect } from "bun:test";
import {
  checkFuelFloorGuard,
  checkCargoFullDockGuard,
  hasPathfinderDrive,
  FUEL_PER_JUMP_ESTIMATE,
  CARGO_FULL_THRESHOLD,
} from "./fuel-floor-guard.js";

/** Build a cached status entry in the shape handlePassthrough stores. */
function makeCached(
  ship: Record<string, unknown>,
  player: Record<string, unknown> = {},
  fetchedAt: number = Date.now(),
): { data: Record<string, unknown>; fetchedAt: number } {
  return {
    data: {
      ship,
      player: { current_system: "delta_major", docked_at_base: false, ...player },
    },
    fetchedAt,
  };
}

describe("checkFuelFloorGuard", () => {
  it("blocks an outbound jump when undocked and fuel <= one jump's worth", () => {
    const cached = makeCached({ fuel: 0, max_fuel: 160 });
    const result = checkFuelFloorGuard("jump", cached);
    expect(result).not.toBeNull();
    expect(result!.error).toBe("fuel_floor_guard");
    expect(result!.current_fuel).toBe(0);
    expect(result!.max_fuel).toBe(160);
    // Message must surface the actionable numbers.
    expect(result!.message).toContain("0/160");
    expect(result!.message.toLowerCase()).toContain("dock");
  });

  it("blocks the real cinder-wake incident shape (0/160 at a star, undocked)", () => {
    const cached = makeCached(
      { fuel: 0, max_fuel: 160 },
      { current_system: "delta_major", current_poi: "delta_major_star", docked_at_base: false },
    );
    const result = checkFuelFloorGuard("jump", cached);
    expect(result).not.toBeNull();
    expect(result!.current_system).toBe("delta_major");
  });

  it("blocks at exactly one jump's worth of fuel (no buffer left after move)", () => {
    const cached = makeCached({ fuel: FUEL_PER_JUMP_ESTIMATE, max_fuel: 160 });
    expect(checkFuelFloorGuard("jump", cached)).not.toBeNull();
  });

  it("blocks jump_route the same way as jump", () => {
    const cached = makeCached({ fuel: 5, max_fuel: 160 });
    const result = checkFuelFloorGuard("jump_route", cached);
    expect(result).not.toBeNull();
    expect(result!.error).toBe("fuel_floor_guard");
  });

  it("ALLOWS a jump that keeps the ship above the floor", () => {
    const cached = makeCached({ fuel: FUEL_PER_JUMP_ESTIMATE + 1, max_fuel: 160 });
    expect(checkFuelFloorGuard("jump", cached)).toBeNull();
  });

  it("ALLOWS a jump with plenty of fuel", () => {
    const cached = makeCached({ fuel: 120, max_fuel: 160 });
    expect(checkFuelFloorGuard("jump", cached)).toBeNull();
  });

  it("ALLOWS when docked even at 0 fuel (can refuel in place)", () => {
    const cached = makeCached({ fuel: 0, max_fuel: 160 }, { docked_at_base: true });
    expect(checkFuelFloorGuard("jump", cached)).toBeNull();
  });

  it("ALLOWS when docked_at_base is a station id string", () => {
    const cached = makeCached({ fuel: 0 }, { docked_at_base: "delta_major_station" });
    expect(checkFuelFloorGuard("jump", cached)).toBeNull();
  });

  it("ALLOWS when the ship has a Pathfinder Drive (module name)", () => {
    const cached = makeCached({
      fuel: 0,
      modules: [{ slot: "drive", name: "Pathfinder Drive Mk II" }],
    });
    expect(checkFuelFloorGuard("jump", cached)).toBeNull();
  });

  it("ALLOWS when the ship has a Pathfinder Drive (module id)", () => {
    const cached = makeCached({
      fuel: 0,
      modules: [{ slot: "aux", id: "pathfinder_drive" }],
    });
    expect(checkFuelFloorGuard("jump", cached)).toBeNull();
  });

  it("ALLOWS when fuel is unknown (never block blind)", () => {
    const cached = makeCached({ max_fuel: 160 });
    expect(checkFuelFloorGuard("jump", cached)).toBeNull();
  });

  it("ALLOWS when there is no cached status at all", () => {
    expect(checkFuelFloorGuard("jump", undefined)).toBeNull();
  });

  it("does NOT apply to non-jump actions (travel, dock, mine)", () => {
    const cached = makeCached({ fuel: 0, max_fuel: 160 });
    expect(checkFuelFloorGuard("travel", cached)).toBeNull();
    expect(checkFuelFloorGuard("dock", cached)).toBeNull();
    expect(checkFuelFloorGuard("mine", cached)).toBeNull();
    expect(checkFuelFloorGuard("travel_to", cached)).toBeNull();
  });

  it("respects a custom fuelPerJump override", () => {
    const cached = makeCached({ fuel: 15, max_fuel: 160 });
    // Default estimate (10): 15 > 10 → allow.
    expect(checkFuelFloorGuard("jump", cached)).toBeNull();
    // Override to 20: 15 <= 20 → block.
    expect(checkFuelFloorGuard("jump", cached, { fuelPerJump: 20 })).not.toBeNull();
  });

  it("reads ship fuel from a flat (non-nested) status shape", () => {
    // Some cached entries store player/ship flattened at data root.
    const cached = {
      data: { fuel: 0, max_fuel: 160, current_system: "delta_major", docked_at_base: false },
      fetchedAt: Date.now(),
    };
    const result = checkFuelFloorGuard("jump", cached);
    expect(result).not.toBeNull();
  });
});

describe("checkCargoFullDockGuard", () => {
  it("blocks an outbound jump when undocked and cargo >= 95%", () => {
    const cached = makeCached({ fuel: 100, cargo_used: 48, cargo_capacity: 50 });
    const result = checkCargoFullDockGuard("jump", cached);
    expect(result).not.toBeNull();
    expect(result!.error).toBe("cargo_full_dock_guard");
    expect(result!.cargo_pct).toBe(96);
    expect(result!.message.toLowerCase()).toContain("sell");
  });

  it("blocks at exactly the 95% threshold", () => {
    const cached = makeCached({ fuel: 100, cargo_used: 95, cargo_capacity: 100 });
    expect(checkCargoFullDockGuard("jump", cached)).not.toBeNull();
  });

  it("ALLOWS at 90% (below the hard threshold — soft advisory territory)", () => {
    const cached = makeCached({ fuel: 100, cargo_used: 90, cargo_capacity: 100 });
    expect(checkCargoFullDockGuard("jump", cached)).toBeNull();
  });

  it("ALLOWS when docked even with full cargo (can sell in place)", () => {
    const cached = makeCached(
      { fuel: 100, cargo_used: 50, cargo_capacity: 50 },
      { docked_at_base: true },
    );
    expect(checkCargoFullDockGuard("jump", cached)).toBeNull();
  });

  it("ALLOWS when cargo numbers are unknown (never block blind)", () => {
    const cached = makeCached({ fuel: 100 });
    expect(checkCargoFullDockGuard("jump", cached)).toBeNull();
  });

  it("ALLOWS when cargo_capacity is 0 (avoid divide-by-zero false block)", () => {
    const cached = makeCached({ fuel: 100, cargo_used: 0, cargo_capacity: 0 });
    expect(checkCargoFullDockGuard("jump", cached)).toBeNull();
  });

  it("does NOT apply to non-jump actions", () => {
    const cached = makeCached({ fuel: 100, cargo_used: 50, cargo_capacity: 50 });
    expect(checkCargoFullDockGuard("travel", cached)).toBeNull();
    expect(checkCargoFullDockGuard("mine", cached)).toBeNull();
  });

  it("applies to jump_route", () => {
    const cached = makeCached({ fuel: 100, cargo_used: 50, cargo_capacity: 50 });
    expect(checkCargoFullDockGuard("jump_route", cached)).not.toBeNull();
  });

  it("respects a custom threshold override", () => {
    const cached = makeCached({ fuel: 100, cargo_used: 80, cargo_capacity: 100 });
    // 80% < default 95% → allow.
    expect(checkCargoFullDockGuard("jump", cached)).toBeNull();
    // Threshold 0.80 → 80% >= 80% → block.
    expect(checkCargoFullDockGuard("jump", cached, { threshold: 0.8 })).not.toBeNull();
  });
});

describe("hasPathfinderDrive", () => {
  it("detects via module name", () => {
    expect(hasPathfinderDrive({ modules: [{ name: "Pathfinder Drive" }] })).toBe(true);
  });
  it("detects via module id", () => {
    expect(hasPathfinderDrive({ modules: [{ id: "pathfinder_drive_mk1" }] })).toBe(true);
  });
  it("detects via explicit boolean flag", () => {
    expect(hasPathfinderDrive({ has_pathfinder_drive: true })).toBe(true);
  });
  it("returns false for ordinary loadouts", () => {
    expect(hasPathfinderDrive({ modules: [{ name: "Mining Laser" }, { name: "Shield Booster" }] })).toBe(false);
  });
  it("returns false for empty / missing ship", () => {
    expect(hasPathfinderDrive(undefined)).toBe(false);
    expect(hasPathfinderDrive({})).toBe(false);
    expect(hasPathfinderDrive({ modules: [] })).toBe(false);
  });
});

describe("guards fail open on a stale cache", () => {
  // The #1 field footgun: a frozen statusCache shows a full hold / low fuel the
  // ship no longer has, and the guard blocks the very jump that would resync it.
  // A structural anti-strand block must only fire on FRESH numbers.
  it("fuel-floor guard ALLOWS when the cached status is stale", () => {
    const stale = makeCached({ fuel: 0, max_fuel: 160 }, {}, Date.now() - 10 * 60_000);
    expect(checkFuelFloorGuard("jump", stale)).toBeNull();
  });

  it("cargo-full guard ALLOWS when the cached status is stale", () => {
    const stale = makeCached({ cargo_used: 100, cargo_capacity: 100 }, {}, Date.now() - 10 * 60_000);
    expect(checkCargoFullDockGuard("jump", stale)).toBeNull();
  });

  it("fuel-floor guard still BLOCKS on a fresh low-fuel reading", () => {
    const fresh = makeCached({ fuel: 0, max_fuel: 160 });
    expect(checkFuelFloorGuard("jump", fresh)).not.toBeNull();
  });

  it("cargo-full guard still BLOCKS on a fresh full reading", () => {
    const fresh = makeCached({ cargo_used: 100, cargo_capacity: 100 });
    expect(checkCargoFullDockGuard("jump", fresh)).not.toBeNull();
  });
});

describe("constants", () => {
  it("CARGO_FULL_THRESHOLD is 0.95 as specified", () => {
    expect(CARGO_FULL_THRESHOLD).toBe(0.95);
  });
  it("FUEL_PER_JUMP_ESTIMATE is a positive number", () => {
    expect(FUEL_PER_JUMP_ESTIMATE).toBeGreaterThan(0);
  });
});
