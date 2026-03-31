import { describe, it, expect } from "bun:test";
import {
  MAX_INSTRUCTION_LENGTH,
  sanitizeInjectInstruction,
  validateInjectInstruction,
} from "./inject.js";

describe("sanitizeInjectInstruction", () => {
  it("trims and normalizes CRLF", () => {
    const value = sanitizeInjectInstruction("  hello\r\nworld  ");
    expect(value).toBe("hello\nworld");
  });

  it("removes control characters except tab/newline", () => {
    const value = sanitizeInjectInstruction("a\u0000b\u0007c\td\n");
    expect(value).toBe("abc\td");
  });
});

describe("validateInjectInstruction", () => {
  it("rejects non-string values", () => {
    const result = validateInjectInstruction({ instruction: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/non-empty string/);
    }
  });

  it("rejects empty string after sanitization", () => {
    const result = validateInjectInstruction(" \u0000 \u0007 ");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/non-empty string/);
    }
  });

  it("rejects over max length", () => {
    const tooLong = "a".repeat(MAX_INSTRUCTION_LENGTH + 1);
    const result = validateInjectInstruction(tooLong);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/must not exceed/);
    }
  });

  it("returns sanitized value for valid input", () => {
    const result = validateInjectInstruction("  ping\u0000 agent\r\nnow  ");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("ping agent\nnow");
    }
  });
});
