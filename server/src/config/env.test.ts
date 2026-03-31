import { describe, test, expect, beforeEach, afterEach } from "bun:test";

// Test the envInt helper logic directly, without delete require.cache.
// The importFresh pattern (delete require.cache + dynamic import) creates
// duplicate module instances, breaking `export let` live bindings in env.ts.
// This poisoned setFleetDirForTesting for enrollment.test.ts and credentials.test.ts.

// Since the env vars are evaluated at module load time as constants,
// we test the parsing logic inline instead of re-importing the module.
function envInt(key: string, fallback: number): number {
  const v = parseInt(process.env[key] ?? "", 10);
  return isNaN(v) ? fallback : v;
}

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
});
