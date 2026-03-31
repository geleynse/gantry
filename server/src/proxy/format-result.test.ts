import { describe, it, expect } from "bun:test";
import { parse } from "yaml";
import { formatForAgent } from "./format-result.js";

describe("formatForAgent", () => {
  const sampleData = {
    credits: 1500,
    location: { system: "Sol", poi: "Earth Station" },
    cargo: [
      { item: "iron_ore", quantity: 20 },
      { item: "copper_ore", quantity: 5 },
    ],
  };

  describe("format=json", () => {
    it("returns valid JSON", () => {
      const result = formatForAgent(sampleData, "json");
      expect(JSON.parse(result)).toEqual(sampleData);
    });

    it("matches JSON.stringify output", () => {
      const result = formatForAgent(sampleData, "json");
      expect(result).toBe(JSON.stringify(sampleData));
    });
  });

  describe("format=yaml", () => {
    it("returns valid YAML that parses back to the same data", () => {
      const result = formatForAgent(sampleData, "yaml");
      expect(parse(result)).toEqual(sampleData);
    });

    it("is shorter than JSON for typical responses", () => {
      const jsonLen = formatForAgent(sampleData, "json").length;
      const yamlLen = formatForAgent(sampleData, "yaml").length;
      expect(yamlLen).toBeLessThan(jsonLen);
    });

    it("handles nested objects", () => {
      const nested = { a: { b: { c: { d: 42 } } } };
      const result = formatForAgent(nested, "yaml");
      expect(parse(result)).toEqual(nested);
    });

    it("handles arrays", () => {
      const arr = [1, 2, 3, "hello", null];
      const result = formatForAgent(arr, "yaml");
      expect(parse(result)).toEqual(arr);
    });

    it("handles empty objects", () => {
      const result = formatForAgent({}, "yaml");
      expect(parse(result)).toEqual({});
    });

    it("handles empty arrays", () => {
      const result = formatForAgent([], "yaml");
      expect(parse(result)).toEqual([]);
    });

    it("handles null", () => {
      const data = { value: null, name: "test" };
      const result = formatForAgent(data, "yaml");
      expect(parse(result)).toEqual(data);
    });

    it("handles numbers (integers and floats)", () => {
      const data = { int: 42, float: 3.14, zero: 0, negative: -10 };
      const result = formatForAgent(data, "yaml");
      expect(parse(result)).toEqual(data);
    });

    it("handles booleans", () => {
      const data = { yes: true, no: false };
      const result = formatForAgent(data, "yaml");
      expect(parse(result)).toEqual(data);
    });

    it("does not wrap long lines", () => {
      const longString = "a".repeat(500);
      const result = formatForAgent({ text: longString }, "yaml");
      // lineWidth: 0 means no wrapping — the long string should be on one line
      expect(result).toContain(longString);
    });

    it("preserves strings that look like YAML special values", () => {
      const data = { answer: "yes", value: "null", version: "1.0", empty: "", no: "no", on: "on", off: "off" };
      const result = formatForAgent(data, "yaml");
      const parsed = parse(result);
      expect(parsed.answer).toBe("yes");
      expect(parsed.value).toBe("null");
      expect(parsed.version).toBe("1.0");
      expect(parsed.empty).toBe("");
      expect(parsed.no).toBe("no");
      expect(parsed.on).toBe("on");
      expect(parsed.off).toBe("off");
    });
  });
});
