import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { envInt } from "./env.js";

// envInt is imported statically (a single module instance) — this is safe.
// The hazard is only the importFresh pattern (delete require.cache + dynamic
// import), which creates duplicate module instances and breaks `export let`
// live bindings, poisoning setFleetDirForTesting for other test files.

describe("Environment Config", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("should use default market scan interval", () => {
    delete process.env.MARKET_SCAN_INTERVAL_MS;
    expect(envInt("MARKET_SCAN_INTERVAL_MS", 300000)).toBe(300000);
  });

  test("should use custom market scan interval", () => {
    process.env.MARKET_SCAN_INTERVAL_MS = "5000";
    expect(envInt("MARKET_SCAN_INTERVAL_MS", 300000)).toBe(5000);
  });

  test("should use default market prune interval", () => {
    delete process.env.MARKET_PRUNE_INTERVAL_MS;
    expect(envInt("MARKET_PRUNE_INTERVAL_MS", 600000)).toBe(600000);
  });

  test("should use custom market prune interval", () => {
    process.env.MARKET_PRUNE_INTERVAL_MS = "10000";
    expect(envInt("MARKET_PRUNE_INTERVAL_MS", 600000)).toBe(10000);
  });

  test("should use default schema TTL", () => {
    delete process.env.SCHEMA_TTL_MS;
    expect(envInt("SCHEMA_TTL_MS", 3600000)).toBe(3600000);
  });

  test("should use custom schema TTL", () => {
    process.env.SCHEMA_TTL_MS = "60000";
    expect(envInt("SCHEMA_TTL_MS", 3600000)).toBe(60000);
  });

  test("should use default danger poll interval", () => {
    delete process.env.DANGER_POLL_INTERVAL_MS;
    expect(envInt("DANGER_POLL_INTERVAL_MS", 300000)).toBe(300000);
  });

  test("should use custom danger poll interval", () => {
    process.env.DANGER_POLL_INTERVAL_MS = "1000";
    expect(envInt("DANGER_POLL_INTERVAL_MS", 300000)).toBe(1000);
  });

  test("should use default position poll interval", () => {
    delete process.env.POSITION_POLL_INTERVAL_MS;
    expect(envInt("POSITION_POLL_INTERVAL_MS", 15000)).toBe(15000);
  });

  test("should use custom position poll interval", () => {
    process.env.POSITION_POLL_INTERVAL_MS = "500";
    expect(envInt("POSITION_POLL_INTERVAL_MS", 15000)).toBe(500);
  });

  test("should fallback to default if env var is not a number", () => {
    process.env.MARKET_SCAN_INTERVAL_MS = "not-a-number";
    // parseInt("not-a-number") returns NaN, so the default should be used.
    expect(envInt("MARKET_SCAN_INTERVAL_MS", 300000)).toBe(300000);
  });

  test("should clamp a negative interval to the default (no setInterval hot loop)", () => {
    process.env.MARKET_SCAN_INTERVAL_MS = "-1";
    expect(envInt("MARKET_SCAN_INTERVAL_MS", 300000)).toBe(300000);
  });

  test("should clamp zero to the default for setInterval consumers", () => {
    process.env.MARKET_SCAN_INTERVAL_MS = "0";
    expect(envInt("MARKET_SCAN_INTERVAL_MS", 300000)).toBe(300000);
  });

  test("should honor a custom minimum of 0 when zero is legitimate", () => {
    process.env.MARKET_SCAN_INTERVAL_MS = "0";
    expect(envInt("MARKET_SCAN_INTERVAL_MS", 300000, 0)).toBe(0);
  });
});
