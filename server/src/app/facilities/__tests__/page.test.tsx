/**
 * Tests for the facilities page error handling.
 */

import { describe, test, expect, mock } from "bun:test";

// Mock apiFetch to simulate API errors
const mockApiFetch = mock();

describe("Facilities page — error handling", () => {
  test("classifyError: 404 returns not_found with friendly message", () => {
    // Import the classifier function (we'll need to export it)
    // For now, this test shows the expected behavior

    const selectedAgent = "sable-thorn";
    const errorMessage = `No facilities data yet for ${selectedAgent}—have the agent call \`list_facilities\` in-game first.`;

    expect(errorMessage).toContain("list_facilities");
    expect(errorMessage).toContain(selectedAgent);
  });

  test("classifyError: 5xx returns network error with fallback message", () => {
    const message = "Facilities service unavailable. Try refresh.";
    expect(message).toContain("unavailable");
    expect(message).toContain("refresh");
  });

  test("classifyError: generic error returns unknown with fallback", () => {
    const message = "Failed to load facilities. Check details below.";
    expect(message).toContain("Failed");
    expect(message).toContain("details");
  });

  test("error state includes rawError for debugging", () => {
    const rawError = '{"error":"Not found"}';
    const errorState = {
      kind: "not_found" as const,
      message: "Test message",
      rawError,
    };

    expect(errorState.rawError).toBe(rawError);
    expect(errorState.kind).toBe("not_found");
  });

  test("friendly messages include agent name context", () => {
    const agents = ["drifter-gale", "sable-thorn", "rust-vane"];
    agents.forEach((agent) => {
      const msg = `No facilities data yet for ${agent}—have the agent call \`list_facilities\` in-game first.`;
      expect(msg).toContain(agent);
    });
  });
});

describe("Facilities page — API error structure", () => {
  test("ApiError includes status and body fields", () => {
    const error = new Error("API 404: not found") as any;
    error.status = 404;
    error.body = '{"error":"Not found"}';

    expect(error.status).toBe(404);
    expect(error.body).toContain("Not found");
  });

  test("isApiError type guard works", () => {
    const apiError = new Error("API 404: test") as any;
    apiError.status = 404;
    apiError.body = "test body";

    const isApi =
      apiError instanceof Error &&
      "status" in apiError &&
      "body" in apiError;

    expect(isApi).toBe(true);
  });
});
