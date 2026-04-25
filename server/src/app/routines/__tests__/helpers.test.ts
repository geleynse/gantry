import { describe, test, expect } from "bun:test";
import { abbreviateTrace, formatDuration } from "../helpers";

describe("abbreviateTrace", () => {
  test("returns the first 8 characters when the trace is longer", () => {
    expect(abbreviateTrace("abcdef1234567890")).toBe("abcdef12");
  });

  test("returns the trace unchanged when it is 8 chars or shorter", () => {
    expect(abbreviateTrace("short")).toBe("short");
    expect(abbreviateTrace("12345678")).toBe("12345678");
  });

  test("returns an em-dash for nullish input", () => {
    expect(abbreviateTrace(null)).toBe("—");
    expect(abbreviateTrace(undefined)).toBe("—");
    expect(abbreviateTrace("")).toBe("—");
  });
});

describe("formatDuration", () => {
  test("renders sub-minute durations in seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(500)).toBe("1s");
    expect(formatDuration(45_000)).toBe("45s");
  });

  test("renders minute-scale durations as `Xm Ys`", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(125_000)).toBe("2m 5s");
  });

  test("clamps invalid input to 0s", () => {
    expect(formatDuration(NaN)).toBe("0s");
    expect(formatDuration(-100)).toBe("0s");
  });
});
