import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, readFileSync, existsSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { atomicWriteFileSync } from "./atomic-write";

// Temp directory shared across tests in this suite
const TEST_DIR = join(tmpdir(), `atomic-write-test-${process.pid}`);

function listTmps(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.includes(".tmp."));
}

describe("atomicWriteFileSync", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    // Clean up test dir contents
    try {
      for (const f of readdirSync(TEST_DIR)) {
        try { unlinkSync(join(TEST_DIR, f)); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  });

  test("writes content to target file", () => {
    const target = join(TEST_DIR, "output.json");
    const data = JSON.stringify({ hello: "world" }, null, 2);

    atomicWriteFileSync(target, data);

    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe(data);
  });

  test("overwrites existing file", () => {
    const target = join(TEST_DIR, "overwrite.json");
    writeFileSync(target, "old content", "utf-8");

    const newData = JSON.stringify({ updated: true });
    atomicWriteFileSync(target, newData);

    expect(readFileSync(target, "utf-8")).toBe(newData);
  });

  test("leaves no temp files after successful write", () => {
    const target = join(TEST_DIR, "clean.json");
    atomicWriteFileSync(target, "{}");

    expect(listTmps(TEST_DIR)).toEqual([]);
  });

  test("leaves no temp files after failure", () => {
    // Point at a non-existent directory to force an error
    const badTarget = join(TEST_DIR, "nonexistent-subdir", "file.json");

    expect(() => atomicWriteFileSync(badTarget, "{}")).toThrow();

    // No temp files should be left in TEST_DIR
    expect(listTmps(TEST_DIR)).toEqual([]);
  });

  test("writes unicode content correctly", () => {
    const target = join(TEST_DIR, "unicode.json");
    const data = JSON.stringify({ emoji: "🚀", chars: "áéíóú" });

    atomicWriteFileSync(target, data);

    expect(readFileSync(target, "utf-8")).toBe(data);
  });

  test("writes empty string", () => {
    const target = join(TEST_DIR, "empty.txt");
    atomicWriteFileSync(target, "");

    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe("");
  });

  test("writes large content", () => {
    const target = join(TEST_DIR, "large.json");
    const obj: Record<string, string> = {};
    for (let i = 0; i < 10_000; i++) {
      obj[`key${i}`] = `value${i}`.repeat(10);
    }
    const data = JSON.stringify(obj, null, 2);

    atomicWriteFileSync(target, data);

    expect(readFileSync(target, "utf-8")).toBe(data);
  });
});
