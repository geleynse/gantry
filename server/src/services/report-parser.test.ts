import { describe, it, expect } from "bun:test";
import { parseReport } from "./report-parser.js";

describe("parseReport", () => {
  it("extracts combat alert with system and attacker", () => {
    const result = parseReport(
      "sable-thorn",
      "COMBAT ALERT: Hull critical (25%) fighting pirate_boss at Sol/asteroid_belt. Stance: defensive.",
    );
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("combat_warning");
    expect(result[0].priority).toBe("urgent");
    expect(result[0].target_agent).toBeNull();
    expect(result[0].message).toContain("Sol/asteroid_belt");
    expect(result[0].message).toContain("pirate_boss");
    expect(result[0].message).toContain("sable-thorn");
  });

  it("extracts ore discovery with location", () => {
    const result = parseReport(
      "drifter-gale",
      "Found rich crystal_ore deposits at Vega/mining_station. Multiple asteroids available.",
    );
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("ore_discovery");
    expect(result[0].priority).toBe("normal");
    expect(result[0].message).toContain("crystal_ore");
    expect(result[0].message).toContain("Vega/mining_station");
  });

  it("extracts trade opportunity", () => {
    const result = parseReport(
      "lumen-shoal",
      "High demand for ion_cores at Nova_Terra. Price 500cr each.",
    );
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("trade_opportunity");
    expect(result[0].message).toContain("ion_cores");
    expect(result[0].message).toContain("Nova_Terra");
  });

  it("returns empty array for unrecognized content", () => {
    const result = parseReport("lumen-shoal", "Just exploring, nothing interesting.");
    expect(result).toHaveLength(0);
  });

  it("extracts multiple patterns from one report", () => {
    const result = parseReport(
      "drifter-gale",
      "Found rich iron_ore deposits at Krynn/belt_alpha. Also high demand for steel at Krynn/station.",
    );
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("ore_discovery");
    expect(result[1].type).toBe("trade_opportunity");
  });

  it("handles discovered keyword for ore", () => {
    const result = parseReport(
      "lumen-shoal",
      "Discovered titanium_ore deposits at Sirius/belt_2.",
    );
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("ore_discovery");
    expect(result[0].message).toContain("titanium_ore");
  });
});
