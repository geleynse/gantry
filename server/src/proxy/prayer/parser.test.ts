import { describe, expect, test } from "bun:test";
import { formatPrayerProgram, parsePrayerScript } from "./parser.js";
import { PrayerParseError } from "./types.js";

describe("PrayerLang parser", () => {
  test("parses commands and nested blocks", () => {
    const program = parsePrayerScript(`
      // comment
      if FUEL() < 20 {
        go $nearest_station;
        dock;
      }
      until CARGO_PCT() >= 80 {
        mine iron_ore;
      }
    `);

    expect(program.statements).toHaveLength(2);
    expect(program.statements[0].kind).toBe("if");
    expect(program.statements[1].kind).toBe("until");
  });

  test("pretty prints canonical script text", () => {
    const program = parsePrayerScript("mine iron_ore; go $home;");
    expect(formatPrayerProgram(program)).toBe("mine iron_ore;\ngo $home;");
  });

  test("rejects unknown macros", () => {
    expect(() => parsePrayerScript("go $somewhere;")).toThrow(PrayerParseError);
  });

  test("trailing semicolon is optional on the last statement", () => {
    // `wait 1` (no trailing semicolon) should parse identically to `wait 1;`
    const withSemi = parsePrayerScript("wait 1;");
    const withoutSemi = parsePrayerScript("wait 1");
    expect(withoutSemi.statements).toHaveLength(1);
    expect(withoutSemi.statements[0].kind).toBe("command");
    expect(withSemi.statements).toHaveLength(1);
    expect(withSemi.statements[0].kind).toBe("command");
  });

  test("trailing semicolon optional: multi-statement script still requires semis between statements", () => {
    // All statements except the last must still have semicolons
    const prog = parsePrayerScript("go sol; dock");
    expect(prog.statements).toHaveLength(2);
    expect(prog.statements[0].kind).toBe("command");
    expect(prog.statements[1].kind).toBe("command");
  });

  test("emits helpful error for quoted strings", () => {
    expect(() => parsePrayerScript('go "sol";')).toThrow(
      /PrayerLang uses bare identifiers, not quoted strings/,
    );
    expect(() => parsePrayerScript("go 'sol';")).toThrow(
      /PrayerLang uses bare identifiers, not quoted strings/,
    );
  });
});
