import { describe, it, expect } from "bun:test";

describe("BUILD_COMMIT", () => {
  it("returns a valid commit hash format (7 chars)", () => {
    const { BUILD_COMMIT } = require("./build-info.js");
    expect(BUILD_COMMIT).toMatch(/^[0-9a-f]{7}$/);
  });

  it("is not 'unknown' when running in a valid git repository", () => {
    const { BUILD_COMMIT } = require("./build-info.js");
    expect(BUILD_COMMIT).not.toBe("unknown");
  });
});

describe("BUILD_VERSION", () => {
  it("returns a valid version from package.json", () => {
    const { BUILD_VERSION } = require("./build-info.js");
    expect(BUILD_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("is not 'unknown'", () => {
    const { BUILD_VERSION } = require("./build-info.js");
    expect(BUILD_VERSION).not.toBe("unknown");
  });
});

describe("getUptimeSeconds", () => {
  it("returns a non-negative number", () => {
    const { getUptimeSeconds } = require("./build-info.js");
    const uptime = getUptimeSeconds();
    expect(typeof uptime).toBe("number");
    expect(uptime).toBeGreaterThanOrEqual(0);
  });

  it("increases over time", async () => {
    const { getUptimeSeconds } = require("./build-info.js");
    const uptime1 = getUptimeSeconds();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const uptime2 = getUptimeSeconds();
    expect(uptime2).toBeGreaterThanOrEqual(uptime1);
  });
});
