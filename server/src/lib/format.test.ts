import { describe, test, expect } from "bun:test";
import {
  formatNumber,
  formatCredits,
  formatCreditsCompact,
  formatCompactNumber,
  formatDelta,
  formatCreditsDelta,
  formatCreditsDeltaCompact,
} from "./format";

describe("formatNumber", () => {
  test("adds thousands separators", () => {
    expect(formatNumber(1234567)).toBe("1,234,567");
  });

  test("returns '—' for null / undefined / NaN / Infinity", () => {
    expect(formatNumber(null)).toBe("—");
    expect(formatNumber(undefined)).toBe("—");
    expect(formatNumber(NaN)).toBe("—");
    expect(formatNumber(Infinity)).toBe("—");
  });

  test("respects fractionDigits", () => {
    expect(formatNumber(1234.567, 2)).toBe("1,234.57");
  });
});

describe("formatCompactNumber", () => {
  test("uses K for thousands", () => {
    expect(formatCompactNumber(1234)).toBe("1.23K");
    expect(formatCompactNumber(12_300)).toBe("12.3K");
    expect(formatCompactNumber(999)).toBe("999");
  });

  test("uses M for millions", () => {
    expect(formatCompactNumber(1_500_000)).toBe("1.5M");
    expect(formatCompactNumber(12_300_000)).toBe("12.3M");
  });

  test("uses B for billions", () => {
    expect(formatCompactNumber(2_500_000_000)).toBe("2.5B");
  });

  test("preserves sign for negatives", () => {
    expect(formatCompactNumber(-13503)).toBe("-13.5K");
    expect(formatCompactNumber(-1_500_000)).toBe("-1.5M");
  });

  test("returns '—' for null", () => {
    expect(formatCompactNumber(null)).toBe("—");
  });

  test("trims trailing zeros", () => {
    expect(formatCompactNumber(1_000_000)).toBe("1M");
    expect(formatCompactNumber(2_000_000)).toBe("2M");
    expect(formatCompactNumber(1_200_000)).toBe("1.2M");
  });
});

describe("formatCredits", () => {
  test("appends 'cr' suffix and thousands separators", () => {
    expect(formatCredits(1_234_567)).toBe("1,234,567 cr");
  });

  test("handles zero", () => {
    expect(formatCredits(0)).toBe("0 cr");
  });

  test("returns '—' for null / undefined", () => {
    expect(formatCredits(null)).toBe("—");
    expect(formatCredits(undefined)).toBe("—");
  });
});

describe("formatCreditsCompact", () => {
  test("appends 'cr' suffix on compact form", () => {
    expect(formatCreditsCompact(1_234_567)).toBe("1.23M cr");
    expect(formatCreditsCompact(64_000)).toBe("64K cr");
  });

  test("returns '—' for null", () => {
    expect(formatCreditsCompact(null)).toBe("—");
  });
});

describe("formatDelta", () => {
  test("always shows + or -", () => {
    expect(formatDelta(1234)).toBe("+1,234");
    expect(formatDelta(-1234)).toBe("-1,234");
  });

  test("zero is unsigned", () => {
    expect(formatDelta(0)).toBe("0");
  });

  test("returns '—' for null", () => {
    expect(formatDelta(null)).toBe("—");
  });
});

describe("formatCreditsDelta", () => {
  test("signed full-precision credits", () => {
    expect(formatCreditsDelta(1_234_567)).toBe("+1,234,567 cr");
    expect(formatCreditsDelta(-13_503)).toBe("-13,503 cr");
  });

  test("zero", () => {
    expect(formatCreditsDelta(0)).toBe("0 cr");
  });
});

describe("formatCreditsDeltaCompact", () => {
  test("signed compact credits", () => {
    expect(formatCreditsDeltaCompact(1_500_000)).toBe("+1.5M cr");
    expect(formatCreditsDeltaCompact(-13_503)).toBe("-13.5K cr");
  });

  test("zero", () => {
    expect(formatCreditsDeltaCompact(0)).toBe("0 cr");
  });
});
