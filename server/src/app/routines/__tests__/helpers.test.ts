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

describe("formatDuration (re-export of lib/format helper)", () => {
  test("renders sub-second durations in ms", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(500)).toBe("500ms");
  });

  test("renders sub-minute durations as Ns with one decimal", () => {
    expect(formatDuration(2_500)).toBe("2.5s");
    expect(formatDuration(45_000)).toBe("45.0s");
  });

  test("renders minute-scale durations as `Xm Ys`", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(125_000)).toBe("2m 5s");
  });

  test("returns em-dash for invalid input", () => {
    expect(formatDuration(NaN)).toBe("—");
    expect(formatDuration(-100)).toBe("—");
  });
});
