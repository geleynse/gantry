/**
 * Tests for ship-level threat assessment functions added in Task #25.
 * Tests classifyShip, assessShipThreat, summarizeShipThreats, and enrichWithThreatAssessment.
 */

import { describe, it, expect } from "bun:test";
import {
  classifyShip,
  assessShipThreat,
  summarizeShipThreats,
  extractShipsFromResult,
  enrichWithThreatAssessment,
  type ShipData,
} from "./threat-assessment.js";

// ---------------------------------------------------------------------------
// classifyShip
// ---------------------------------------------------------------------------

describe("classifyShip — hull-based", () => {
  it("classifies shuttle (hull < 50)", () => {
    expect(classifyShip({ max_hull: 30 })).toBe("shuttle");
  });

  it("classifies scout (hull 50–149)", () => {
    expect(classifyShip({ max_hull: 100 })).toBe("scout");
    expect(classifyShip({ max_hull: 50 })).toBe("scout");
    expect(classifyShip({ max_hull: 149 })).toBe("scout");
  });

  it("classifies frigate (hull 150–499)", () => {
    expect(classifyShip({ max_hull: 200 })).toBe("frigate");
    expect(classifyShip({ max_hull: 499 })).toBe("frigate");
  });

  it("classifies cruiser (hull 500–1499)", () => {
    expect(classifyShip({ max_hull: 800 })).toBe("cruiser");
    expect(classifyShip({ max_hull: 1499 })).toBe("cruiser");
  });

  it("classifies capital (hull >= 1500)", () => {
    expect(classifyShip({ max_hull: 2000 })).toBe("capital");
    expect(classifyShip({ max_hull: 1500 })).toBe("capital");
  });

  it("uses hull when max_hull is absent", () => {
    expect(classifyShip({ hull: 200 })).toBe("frigate");
  });
});

describe("classifyShip — string fallback", () => {
  it("falls back to class_id string when no hull", () => {
    expect(classifyShip({ class_id: "scout_mk1" })).toBe("scout");
    expect(classifyShip({ class: "heavy_frigate" })).toBe("frigate");
    expect(classifyShip({ class: "dreadnought" })).toBe("capital");
    expect(classifyShip({ class: "shuttle_transport" })).toBe("shuttle");
  });

  it("returns unknown for empty class data", () => {
    expect(classifyShip({})).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// assessShipThreat
// ---------------------------------------------------------------------------

describe("assessShipThreat — unarmed ships", () => {
  it("harmless: unarmed shuttle", () => {
    const result = assessShipThreat({ max_hull: 30 });
    expect(result.level).toBe("harmless");
    expect(result.weaponCount).toBe(0);
    expect(result.summary).toContain("unarmed");
  });

  it("harmless/low: unarmed scout", () => {
    const result = assessShipThreat({ max_hull: 100 });
    expect(["harmless", "low"]).toContain(result.level);
    expect(result.weaponCount).toBe(0);
  });

  it("unarmed unknown class stays low", () => {
    const result = assessShipThreat({});
    expect(["harmless", "low"]).toContain(result.level);
  });
});

describe("assessShipThreat — armed ships", () => {
  it("armed frigate rates medium", () => {
    const ship: ShipData = {
      max_hull: 200,
      weapons: [{ type: "laser", damage: 20 }],
    };
    const result = assessShipThreat(ship);
    expect(["medium", "high"]).toContain(result.level);
    expect(result.weaponCount).toBe(1);
  });

  it("cruiser with multiple weapons rates high", () => {
    const ship: ShipData = {
      max_hull: 800,
      weapons: [
        { type: "cannon", damage: 40 },
        { type: "railgun", damage: 60 },
        { type: "missile", damage: 50 },
      ],
    };
    const result = assessShipThreat(ship);
    expect(["high", "extreme"]).toContain(result.level);
    expect(result.weaponCount).toBe(3);
  });

  it("capital with shields and heavy weapons rates extreme", () => {
    const ship: ShipData = {
      max_hull: 2000,
      max_shields: 500,
      weapons: [
        { type: "torpedo" },
        { type: "railgun" },
        { type: "cannon" },
        { type: "plasma" },
        { type: "laser" },
      ],
    };
    const result = assessShipThreat(ship);
    expect(result.level).toBe("extreme");
  });

  it("shields add to threat score", () => {
    const noShields: ShipData = { max_hull: 200, weapons: [{ type: "laser" }] };
    const withShields: ShipData = { ...noShields, max_shields: 100 };
    const a = assessShipThreat(noShields);
    const b = assessShipThreat(withShields);
    // shielded ship should be at least as threatening
    const order = ["harmless", "low", "medium", "high", "extreme"];
    expect(order.indexOf(b.level)).toBeGreaterThanOrEqual(order.indexOf(a.level));
  });
});

describe("assessShipThreat — summary format", () => {
  it("includes ship class in summary", () => {
    const result = assessShipThreat({ max_hull: 200, weapons: [{ type: "laser" }] });
    expect(result.summary).toContain("frigate");
    expect(result.summary).toContain("1 weapon");
    expect(result.summary.toUpperCase()).toContain(result.level.toUpperCase());
  });

  it("includes weapon count in summary", () => {
    const result = assessShipThreat({
      max_hull: 800,
      weapons: [{ type: "cannon" }, { type: "missile" }],
    });
    expect(result.summary).toContain("2 weapons");
  });

  it("reports 'unarmed' when no weapons", () => {
    const result = assessShipThreat({ max_hull: 200 });
    expect(result.summary).toContain("unarmed");
  });
});

describe("assessShipThreat — weapon types", () => {
  it("captures weapon type names", () => {
    const result = assessShipThreat({
      max_hull: 200,
      weapons: [{ type: "laser" }, { type: "cannon" }],
    });
    expect(result.weaponTypes).toContain("laser");
    expect(result.weaponTypes).toContain("cannon");
  });

  it("deduplicates weapon types", () => {
    const result = assessShipThreat({
      max_hull: 200,
      weapons: [{ type: "laser" }, { type: "laser" }, { type: "laser" }],
    });
    expect(result.weaponTypes).toHaveLength(1);
    expect(result.weaponTypes[0]).toBe("laser");
  });

  it("uses weapon name as fallback when type is absent", () => {
    const result = assessShipThreat({
      max_hull: 200,
      weapons: [{ name: "Plasma Cannon" }],
    });
    expect(result.weaponTypes[0]).toBe("plasma cannon");
  });
});

// ---------------------------------------------------------------------------
// summarizeShipThreats
// ---------------------------------------------------------------------------

describe("summarizeShipThreats", () => {
  it("returns null for empty array", () => {
    expect(summarizeShipThreats([])).toBeNull();
  });

  it("handles single ship", () => {
    const result = summarizeShipThreats([{ max_hull: 200, weapons: [{ type: "laser" }] }]);
    expect(result).not.toBeNull();
    expect(result).toContain("frigate");
  });

  it("groups ships by class and threat level", () => {
    const ships: ShipData[] = [
      { max_hull: 200, weapons: [{ type: "laser" }] },
      { max_hull: 200, weapons: [{ type: "cannon" }] },
      { max_hull: 100 }, // unarmed scout
    ];
    const result = summarizeShipThreats(ships);
    expect(result).not.toBeNull();
    // Should mention frigates (plural for 2 of same class/level)
    expect(result).toMatch(/frigate/i);
    expect(result).toMatch(/scout/i);
  });

  it("sorts highest threat first", () => {
    const ships: ShipData[] = [
      { max_hull: 100 }, // harmless scout
      { max_hull: 2000, max_shields: 500, weapons: Array(5).fill({ type: "cannon" }) }, // extreme capital
    ];
    const result = summarizeShipThreats(ships);
    expect(result).not.toBeNull();
    const capitalIdx = result!.indexOf("capital");
    const scoutIdx = result!.indexOf("scout");
    expect(capitalIdx).toBeLessThan(scoutIdx);
  });

  it("includes threat level labels in output", () => {
    const ships: ShipData[] = [
      { max_hull: 800, weapons: [{ type: "cannon" }, { type: "railgun" }] },
    ];
    const result = summarizeShipThreats(ships);
    // Output should have an uppercase threat level in parens
    expect(result).toMatch(/\((HARMLESS|LOW|MEDIUM|HIGH|EXTREME)\)/);
  });
});

// ---------------------------------------------------------------------------
// extractShipsFromResult
// ---------------------------------------------------------------------------

describe("extractShipsFromResult", () => {
  it("returns null for non-object input", () => {
    expect(extractShipsFromResult(null)).toBeNull();
    expect(extractShipsFromResult("string")).toBeNull();
    expect(extractShipsFromResult(42)).toBeNull();
  });

  it("extracts from result.ships", () => {
    const ships = [{ max_hull: 200 }];
    expect(extractShipsFromResult({ ships })).toBe(ships);
  });

  it("extracts from result.nearby_ships", () => {
    const ships = [{ max_hull: 100 }];
    expect(extractShipsFromResult({ nearby_ships: ships })).toBe(ships);
  });

  it("extracts from result.entities", () => {
    const ships = [{ max_hull: 500 }];
    expect(extractShipsFromResult({ entities: ships })).toBe(ships);
  });

  it("extracts from result.contacts", () => {
    const ships = [{ max_hull: 300 }];
    expect(extractShipsFromResult({ contacts: ships })).toBe(ships);
  });

  it("extracts from nested result.location.ships", () => {
    const ships = [{ max_hull: 200 }];
    expect(extractShipsFromResult({ location: { ships } })).toBe(ships);
  });

  it("returns null when ships array is empty", () => {
    expect(extractShipsFromResult({ ships: [] })).toBeNull();
  });

  it("returns null when no ship fields present", () => {
    expect(extractShipsFromResult({ credits: 5000, system: "Sol" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// enrichWithThreatAssessment
// ---------------------------------------------------------------------------

describe("enrichWithThreatAssessment", () => {
  it("returns false for non-object input", () => {
    expect(enrichWithThreatAssessment(null)).toBe(false);
    expect(enrichWithThreatAssessment("string")).toBe(false);
  });

  it("returns false when no ships present", () => {
    const result = { system: "Sol", credits: 5000 };
    expect(enrichWithThreatAssessment(result)).toBe(false);
    expect(result).not.toHaveProperty("_threat_summary");
  });

  it("enriches result with _threat_summary when ships present", () => {
    const result = {
      system: "Sol",
      ships: [{ max_hull: 200, weapons: [{ type: "laser" }] }],
    };
    const enriched = enrichWithThreatAssessment(result);
    expect(enriched).toBe(true);
    expect(result).toHaveProperty("_threat_summary");
    expect(typeof (result as any)._threat_summary).toBe("string");
  });

  it("_threat_summary contains useful info", () => {
    const result = {
      ships: [
        { max_hull: 800, weapons: [{ type: "cannon" }, { type: "railgun" }] },
        { max_hull: 100 },
      ],
    };
    enrichWithThreatAssessment(result);
    const summary = (result as any)._threat_summary as string;
    expect(summary).toMatch(/\(/);
    expect(summary.length).toBeGreaterThan(5);
  });

  it("enriches from nearby_ships field", () => {
    const result = {
      nearby_ships: [{ max_hull: 200, weapons: [{ type: "laser" }] }],
    };
    expect(enrichWithThreatAssessment(result)).toBe(true);
    expect(result).toHaveProperty("_threat_summary");
  });
});
