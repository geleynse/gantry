import { afterEach, describe, expect, it } from "bun:test";
import { DEFAULT_DEVTOOLS_BASE_URL, getDevtoolsBaseUrl } from "./devtools.js";

const ORIGINAL_DEVTOOLS_URL = process.env.DEVTOOLS_URL;

describe("getDevtoolsBaseUrl", () => {
  afterEach(() => {
    if (ORIGINAL_DEVTOOLS_URL === undefined) {
      delete process.env.DEVTOOLS_URL;
      return;
    }
    process.env.DEVTOOLS_URL = ORIGINAL_DEVTOOLS_URL;
  });

  it("returns the default loopback URL when unset", () => {
    delete process.env.DEVTOOLS_URL;
    expect(getDevtoolsBaseUrl()).toBe(DEFAULT_DEVTOOLS_BASE_URL);
  });

  it("trims whitespace and trailing slashes from DEVTOOLS_URL", () => {
    process.env.DEVTOOLS_URL = "  https://devtools.example.test/base///  ";
    expect(getDevtoolsBaseUrl()).toBe("https://devtools.example.test/base");
  });
});
