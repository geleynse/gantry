/**
 * Unit tests for proxy-constants invariants.
 */

import { describe, it, expect } from "bun:test";
import { STATE_CHANGING_TOOLS, MUTATION_COMMANDS, isStateChangingCall } from "./proxy-constants.js";

describe("proxy-constants invariants", () => {
  it("MUTATION_COMMANDS is a subset of STATE_CHANGING_TOOLS", () => {
    const violations: string[] = [];
    for (const cmd of MUTATION_COMMANDS) {
      if (!STATE_CHANGING_TOOLS.has(cmd)) {
        violations.push(cmd);
      }
    }
    if (violations.length > 0) {
      console.error(
        `[proxy-constants] MUTATION_COMMANDS entries missing from STATE_CHANGING_TOOLS:\n` +
        violations.map((t) => `  - ${t}`).join("\n"),
      );
    }
    expect(violations).toEqual([]);
  });

  it("configure_recycler is in STATE_CHANGING_TOOLS", () => {
    expect(STATE_CHANGING_TOOLS.has("configure_recycler")).toBe(true);
  });

  it("configure_recycler is in MUTATION_COMMANDS", () => {
    expect(MUTATION_COMMANDS.has("configure_recycler")).toBe(true);
  });

  it("load_passenger and unload_passenger are in STATE_CHANGING_TOOLS (passenger loop, v0.354.0+)", () => {
    // Boarding/dropping passengers changes ship manifest state — must route
    // through the same cache-refresh/tick-wait path as other state-changing
    // tools (passthrough-postprocess.ts handleStateChangingTickWait).
    expect(STATE_CHANGING_TOOLS.has("load_passenger")).toBe(true);
    expect(STATE_CHANGING_TOOLS.has("unload_passenger")).toBe(true);
  });
});

describe("isStateChangingCall('craft', args) — dry_run / cancel / bulk edge cases", () => {
  // Must-fix 1: cancellation must never be downgraded to a read by a
  // (possibly bogus, possibly malicious) dry_run:true flag. Cancelling
  // refunds escrowed inputs/labor/fees — a real mutation. Before the fix,
  // `args.dry_run === true` was checked BEFORE the cancel check, so both of
  // these returned `false` (misclassified as a read).
  it("cancellation via action:'cancel' + dry_run:true is still state-changing", () => {
    expect(isStateChangingCall("craft", { action: "cancel", dry_run: true })).toBe(true);
  });

  it("cancellation via job_id + dry_run:true is still state-changing", () => {
    expect(isStateChangingCall("craft", { job_id: "job-1", dry_run: true })).toBe(true);
  });

  // Must-fix 2: the /craft spec states twice that dry_run is "Not supported
  // with bulk jobs" — a bulk `jobs` array always queues real jobs (up to 50),
  // regardless of a dry_run flag the server ignores.
  it("bulk jobs + dry_run:true is still state-changing (dry_run not supported for bulk)", () => {
    expect(
      isStateChangingCall("craft", { jobs: [{ recipe_id: "a" }, { recipe_id: "b" }], dry_run: true }),
    ).toBe(true);
  });

  it("bulk jobs without dry_run is state-changing", () => {
    expect(isStateChangingCall("craft", { jobs: [{ recipe_id: "a" }] })).toBe(true);
  });

  // Should-fix 3: job_id is spec-typed as a string, so an explicit empty
  // string must be decided rather than falling through on truthiness.
  // ASSUMPTION: treat job_id: "" as cancel-intent (state-changing), matching
  // the spec's "job_id implies cancel" and using `!= null` instead of
  // truthiness so the empty string isn't silently reclassified as a read.
  it("job_id: '' (empty string, still present) is treated as a cancel — state-changing", () => {
    expect(isStateChangingCall("craft", { job_id: "" })).toBe(true);
  });

  it("job_ids: [] (empty array, still present) is treated as a cancel — state-changing", () => {
    expect(isStateChangingCall("craft", { job_ids: [] })).toBe(true);
  });

  // Ordinary read paths remain reads.
  it("dry_run:true with a single recipe_id is a read (quote)", () => {
    expect(isStateChangingCall("craft", { recipe_id: "steel_plate", dry_run: true })).toBe(false);
  });

  // Must-fix 4 / mutation M6: the `!recipe_id && !jobs` guard is what
  // actually decides the bare-queue-listing read on the real v2 call shape
  // (`action` is v2's dispatch key, so a real v2 craft call always arrives
  // as `action: "craft"` — never `action: "queue"`). Deleting that guard
  // left this case silently misclassified as state-changing with the full
  // suite still green (143 pass / 0 fail) — nothing exercised it.
  it("action:'craft' with no recipe_id/jobs (real v2 bare-queue payload) is a read", () => {
    expect(isStateChangingCall("craft", { action: "craft" })).toBe(false);
  });

  it("args with an unrelated field only (no recipe_id/jobs) is a read", () => {
    expect(isStateChangingCall("craft", { quantity: 5 })).toBe(false);
  });

  it("naming a recipe_id (no dry_run) is state-changing", () => {
    expect(isStateChangingCall("craft", { recipe_id: "steel_plate" })).toBe(true);
  });
});
