import { describe, test, expect } from "bun:test";
import { AGENT_COLORS, cn, formatCredits, getAgentColor, relativeTime } from "./utils";

describe("utils", () => {
  describe("AGENT_COLORS", () => {
    test("AGENT_COLORS values are valid hex colors", () => {
      for (const color of Object.values(AGENT_COLORS)) {
        expect(color).toMatch(/^#[0-9a-f]{6}$/i);
      }
    });
  });

  describe("getAgentColor()", () => {
    test("returns canonical color for a known agent", () => {
      // Seed AGENT_COLORS with a known entry then read it back.
      AGENT_COLORS["test-known-agent"] = "#abcdef";
      try {
        expect(getAgentColor("test-known-agent")).toBe("#abcdef");
      } finally {
        delete AGENT_COLORS["test-known-agent"];
      }
    });

    test("returns a deterministic hsl fallback for unknown agents", () => {
      const a = getAgentColor("unknown-agent-x");
      const b = getAgentColor("unknown-agent-x");
      expect(a).toMatch(/^hsl\(\d+,/);
      expect(a).toBe(b);
    });
  });

  describe("cn()", () => {
    test("merges single class", () => {
      const result = cn("px-4");
      expect(result).toContain("px-4");
    });

    test("merges multiple classes", () => {
      const result = cn("px-4", "py-2", "text-white");
      expect(result).toContain("px-4");
      expect(result).toContain("py-2");
      expect(result).toContain("text-white");
    });

    test("handles conflicting Tailwind classes", () => {
      const result = cn("px-4", "px-8");
      // tailwind-merge should keep the last one
      expect(result).toContain("px-8");
      expect(result).not.toContain("px-4 px-8");
    });

    test("filters out falsy values", () => {
      const result = cn("px-4", false && "py-2", undefined, "text-white");
      expect(result).toContain("px-4");
      expect(result).toContain("text-white");
    });
  });

  describe("formatCredits", () => {
    test("formats millions with M cr suffix", () => {
      const result = formatCredits(1_000_000);
      expect(result).toBe("1.0M cr");
    });

    test("formats 2.5M correctly", () => {
      const result = formatCredits(2_500_000);
      expect(result).toBe("2.5M cr");
    });

    test("formats thousands with k cr suffix", () => {
      const result = formatCredits(1_000);
      expect(result).toBe("1.0k cr");
    });

    test("formats 50k correctly", () => {
      const result = formatCredits(50_000);
      expect(result).toBe("50.0k cr");
    });

    test("handles small numbers with cr suffix", () => {
      const result = formatCredits(999);
      expect(result).toBe("999 cr");
    });

    test("handles zero", () => {
      const result = formatCredits(0);
      expect(result).toBe("0 cr");
    });

    test("returns --- for null", () => {
      const result = formatCredits(null);
      expect(result).toBe("---");
    });

    test("returns --- for undefined", () => {
      const result = formatCredits(undefined);
      expect(result).toBe("---");
    });
  });

  describe("relativeTime (in utils)", () => {
    test("accepts string timestamps", () => {
      const now = new Date().toISOString();
      const result = relativeTime(now);
      expect(typeof result).toBe("string");
      expect(result).toContain("ago");
    });

    test("accepts numeric timestamps", () => {
      const now = Date.now();
      const result = relativeTime(now);
      expect(typeof result).toBe("string");
      expect(result).toContain("ago");
    });

    test("returns '0s ago' for current time", () => {
      const now = Date.now();
      const result = relativeTime(now);
      expect(result).toBe("0s ago");
    });

    test("returns correct format for past times", () => {
      const past = Date.now() - 5 * 60 * 1000; // 5 minutes ago
      const result = relativeTime(past);
      expect(result).toMatch(/^\d+[smhd] ago$/);
    });
  });
});
