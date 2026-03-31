import { describe, expect, it } from "bun:test";
import { getCargoUtilization } from "./routine-utils.js";

describe("routine-utils: getCargoUtilization", () => {
  it("parses valid get_cargo response", () => {
    const cargo = {
      used: 50,
      capacity: 100,
      cargo: [{ item_id: "ore", quantity: 50, size: 1 }]
    };
    const util = getCargoUtilization(cargo);
    expect(util).toEqual({
      used: 50,
      capacity: 100,
      freeSpace: 50,
      pctFull: 50
    });
  });

  it("handles result wrapper from ctx.client.execute()", () => {
    const resp = {
      result: {
        used: 25,
        capacity: 100
      }
    };
    const util = getCargoUtilization(resp);
    expect(util?.used).toBe(25);
    expect(util?.pctFull).toBe(25);
  });

  it("handles mining tool response shape (cargo_after)", () => {
    const resp = {
      cargo_after: {
        used: 90,
        max: 100
      }
    };
    const util = getCargoUtilization(resp);
    expect(util).toEqual({
      used: 90,
      capacity: 100,
      freeSpace: 10,
      pctFull: 90
    });
  });

  it("returns null for invalid data", () => {
    expect(getCargoUtilization(null)).toBeNull();
    expect(getCargoUtilization(undefined)).toBeNull();
    expect(getCargoUtilization("not an object")).toBeNull();
    expect(getCargoUtilization({})).toBeNull();
  });

  it("returns null if capacity is 0", () => {
    const util = getCargoUtilization({ used: 10, capacity: 0 });
    expect(util).toBeNull();
  });

  it("calculates free space correctly", () => {
    const util = getCargoUtilization({ used: 110, capacity: 100 });
    expect(util?.freeSpace).toBe(0);
    expect(util?.pctFull).toBeCloseTo(110);
  });
});
