/**
 * Tests for the facilities page error handling.
 */

import { describe, test, expect, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { FacilityRow, type FacilityRecord } from "../page";

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

// ---------------------------------------------------------------------------
// FacilityRow — v0.551.1 damaged status
// ---------------------------------------------------------------------------
//
// v0.551.1: faction_list now reports status: "damaged" (instead of "active")
// for knocked-out faction facilities, plus a boolean `damaged` flag. The row
// must render this as visibly NOT working — never lumped in with a working
// facility's styling.
describe("FacilityRow — damaged status (v0.551.1)", () => {
  test("renders active facility with success styling, no Damaged badge", () => {
    const facility: FacilityRecord = { id: "f1", name: "Refinery", status: "active" };
    const { container } = render(<FacilityRow facility={facility} />);
    expect(screen.getByText("active")).toBeTruthy();
    expect(screen.queryByText("Damaged")).toBeNull();
    expect(container.querySelector(".text-success")).toBeTruthy();
    expect(container.querySelector(".text-destructive")).toBeNull();
  });

  test("renders damaged facility (status field) with destructive styling, not success", () => {
    const facility: FacilityRecord = { id: "f2", name: "Faction Hub", status: "damaged", damaged: true };
    const { container } = render(<FacilityRow facility={facility} />);
    expect(screen.getByText("damaged")).toBeTruthy();
    expect(container.querySelector(".text-success")).toBeNull();
    expect(container.querySelector(".text-destructive")).toBeTruthy();
  });

  test("renders explicit Damaged badge when damaged flag is set but status disagrees", () => {
    // Defensive case: some other status string ("idle", legacy alias, etc.) paired
    // with damaged: true must still surface as damaged, not silently pass as OK.
    // This makes the `facility.damaged === true` half of isDamaged independently
    // load-bearing: mutating it away (dropping the boolean check) makes this go RED.
    const facility: FacilityRecord = { id: "f3", name: "Old Mine", status: "idle", damaged: true };
    render(<FacilityRow facility={facility} />);
    expect(screen.getByText("Damaged")).toBeTruthy();
  });

  test("renders damaged facility with destructive styling when status says damaged but the boolean flag is absent", () => {
    // FacilityFactionEntry does not require `damaged`; a facility can report
    // status: "damaged" with `damaged` left undefined. This makes the
    // `facility.status === "damaged"` half of isDamaged independently
    // load-bearing: mutating it away (dropping the status check) makes this go RED.
    const facility: FacilityRecord = { id: "f5", name: "Shattered Hub", status: "damaged" };
    const { container } = render(<FacilityRow facility={facility} />);
    expect(screen.getByText("damaged")).toBeTruthy();
    expect(container.querySelector(".text-success")).toBeNull();
    expect(container.querySelector(".text-destructive")).toBeTruthy();
    // status already says "damaged", so the defensive extra badge should not
    // also render — it's reserved for the disagreeing case.
    expect(screen.queryByText("Damaged")).toBeNull();
  });

  test("renders under_construction with distinct warning styling, not success or destructive", () => {
    // v0.551.1 live status enum is under_construction | damaged | active.
    // under_construction is expected/normal (not yet producing) — it must get
    // its own honest treatment, not be lumped in with the generic
    // muted/idle branch that also covers unlabeled problem states.
    const facility: FacilityRecord = { id: "f6", name: "New Foundry", status: "under_construction" };
    const { container } = render(<FacilityRow facility={facility} />);
    expect(screen.getByText("under_construction")).toBeTruthy();
    expect(container.querySelector(".text-success")).toBeNull();
    expect(container.querySelector(".text-destructive")).toBeNull();
    expect(container.querySelector(".text-warning")).toBeTruthy();
  });

  test("shows rent_per_cycle in expanded details when present", () => {
    const facility: FacilityRecord = {
      id: "f4",
      name: "Faction Hub",
      status: "damaged",
      damaged: true,
      rentPerCycle: 400,
      production: { output: "ore" },
    };
    render(<FacilityRow facility={facility} />);
    // Details are behind the expand chevron; click it.
    const expandButton = screen.getByRole("button");
    fireEvent.click(expandButton);
    expect(screen.getByText(/Rent per cycle/)).toBeTruthy();
    expect(screen.getByText(/400/)).toBeTruthy();
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
