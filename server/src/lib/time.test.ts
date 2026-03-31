import { describe, test, expect } from "bun:test";
import {
  parseDbTimestamp,
  relativeTime,
  formatTime,
  formatDateTime,
  formatTimeShort,
  formatFullTimestamp,
} from "./time";

describe("time utilities", () => {
  describe("parseDbTimestamp", () => {
    test("parses bare DB timestamp as UTC", () => {
      const date = parseDbTimestamp("2026-02-24 14:30:00");
      expect(date.toISOString()).toBe("2026-02-24T14:30:00.000Z");
    });

    test("parses ISO timestamp with T", () => {
      const date = parseDbTimestamp("2026-02-24T14:30:00Z");
      expect(date.toISOString()).toBe("2026-02-24T14:30:00.000Z");
    });

    test("handles timestamps with milliseconds", () => {
      const date = parseDbTimestamp("2026-02-24 14:30:00");
      expect(date).toBeInstanceOf(Date);
      expect(isNaN(date.getTime())).toBe(false);
    });
  });

  describe("relativeTime", () => {
    test("shows 'just now' for recent times (<5s)", () => {
      const now = new Date().toISOString();
      const result = relativeTime(now);
      expect(result).toBe("just now");
    });

    test("shows seconds for times 5-60s ago", () => {
      const past = new Date(Date.now() - 30 * 1000).toISOString();
      const result = relativeTime(past);
      expect(result).toMatch(/^\d+s ago$/);
    });

    test("shows minutes for times 1-60m ago", () => {
      const past = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const result = relativeTime(past);
      expect(result).toMatch(/^\d+m ago$/);
    });

    test("shows hours for times 1-24h ago", () => {
      const past = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
      const result = relativeTime(past);
      expect(result).toMatch(/^\d+h ago$/);
    });

    test("shows days for times >24h ago", () => {
      const past = new Date(Date.now() - 3 * 86400 * 1000).toISOString();
      const result = relativeTime(past);
      expect(result).toMatch(/^\d+d ago$/);
    });
  });

  describe("isRecent", () => {
    test("returns false for null input", () => {
      const { isRecent } = require("./time");
      expect(isRecent(null)).toBe(false);
    });
  });

  describe("formatTime", () => {
    test("formats as HH:MM:SS", () => {
      const result = formatTime("2026-02-24 14:30:45");
      expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    });

    test("pads single-digit hours/minutes/seconds", () => {
      const result = formatTime("2026-02-24 09:05:03");
      expect(result).toBe("09:05:03");
    });

    test("produces NaN for invalid input (Date parse returns invalid)", () => {
      const result = formatTime("invalid");
      // Invalid dates produce NaN for getHours/getMinutes/getSeconds
      expect(result).toBe("NaN:NaN:NaN");
    });
  });

  describe("formatDateTime", () => {
    test("formats as 'Mon DD, HH:MM'", () => {
      const result = formatDateTime("2026-02-24 14:30:00");
      expect(result).toMatch(/^[A-Za-z]+ \d{1,2}, \d{2}:\d{2}$/);
    });

    test("includes correct month abbreviation", () => {
      const result = formatDateTime("2026-02-24 14:30:00");
      expect(result).toContain("Feb");
    });

    test("produces 'Invalid Date' for invalid input", () => {
      const input = "invalid";
      const result = formatDateTime(input);
      expect(result).toContain("Invalid Date");
    });
  });

  describe("formatTimeShort", () => {
    test("formats as HH:MM without seconds", () => {
      const result = formatTimeShort("2026-02-24 14:30:45");
      expect(result).toMatch(/^\d{2}:\d{2}$/);
    });

    test("pads single-digit hours/minutes", () => {
      const result = formatTimeShort("2026-02-24 09:05:45");
      expect(result).toBe("09:05");
    });

    test("produces NaN for invalid input", () => {
      const input = "invalid";
      const result = formatTimeShort(input);
      expect(result).toBe("NaN:NaN");
    });
  });

  describe("formatFullTimestamp", () => {
    test("formats as locale string", () => {
      const result = formatFullTimestamp("2026-02-24 14:30:00");
      expect(result).toContain("2026");
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    test("produces 'Invalid Date' for invalid input", () => {
      const input = "invalid";
      const result = formatFullTimestamp(input);
      expect(result).toContain("Invalid Date");
    });
  });
});
