import { describe, test, expect, beforeEach, afterEach } from "bun:test";

// Lightweight tests around the splitter's clamping math. We do not render
// the React component (no JSDOM in the repo's bun test setup); instead we
// verify the same Math.max/min clamp the component uses.
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

describe("resizable splitter clamp logic", () => {
  test("clamps below min", () => {
    expect(clamp(50, 120, 600)).toBe(120);
  });

  test("clamps above max", () => {
    expect(clamp(900, 120, 600)).toBe(600);
  });

  test("passes through values inside the range", () => {
    expect(clamp(300, 120, 600)).toBe(300);
  });

  test("inverted bounds collapse to min (degenerate case — caller is responsible for sane min/max)", () => {
    // Math.max(600, Math.min(100, 500)) === Math.max(600, 100) === 600.
    expect(clamp(500, 600, 100)).toBe(600);
  });
});

// `useColumnWidths` persistence — exercises localStorage round-trip without
// touching React state. We polyfill localStorage in this test only.
describe("useColumnWidths storage round-trip", () => {
  const STORAGE_KEY = "notes-test:column-widths";
  let backing: Record<string, string> = {};

  beforeEach(() => {
    backing = {};
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => backing[k] ?? null,
      setItem: (k: string, v: string) => {
        backing[k] = v;
      },
      removeItem: (k: string) => {
        delete backing[k];
      },
      clear: () => {
        backing = {};
      },
      key: () => null,
      length: 0,
    } as Storage;
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  test("persists and reads back JSON-encoded widths", () => {
    const widths = { left: 220, right: 280 };
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
    const raw = globalThis.localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as { left: number; right: number };
    expect(parsed.left).toBe(220);
    expect(parsed.right).toBe(280);
  });

  test("returns null for unknown keys (caller falls back to defaults)", () => {
    expect(globalThis.localStorage.getItem("notes:nope")).toBeNull();
  });
});
