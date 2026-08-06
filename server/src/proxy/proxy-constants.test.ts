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

  // P1 fix (throttle/tick-wait reuse): dispatchV1ToV2's translateV1ArgsToV2
  // renames `recipe_id` → `id` (V1_TO_V2_PARAM_MAP.craft, the inverse of
  // schema.ts's V2_TO_V1_PARAM_MAP.craft = { id: "recipe_id" }) before a
  // craft call reaches http-game-client-v2.execute() — verified live via
  // dispatchV1ToV2("craft", { recipe_id: "x", count: 5 }) returning
  // { tool: "spacemolt", args: { action: "craft", id: "x", count: 5 } }.
  // Genuine v2-native agents also send `id` directly (same generic-param
  // convention as jump/travel/attack/loot_wreck/install_mod). Without the
  // `id` alias, a real single-recipe craft is misclassified as a bare queue
  // read at whichever call site sees this post-translation (or
  // already-generic) shape — which is exactly where the throttle gate lives.
  it("naming a recipe via `id` (no dry_run) is state-changing — post-dispatch-translation shape", () => {
    expect(isStateChangingCall("craft", { action: "craft", id: "steel_plate" })).toBe(true);
  });

  it("dry_run:true with `id` (not recipe_id) is still a read", () => {
    expect(isStateChangingCall("craft", { action: "craft", id: "steel_plate", dry_run: true })).toBe(false);
  });
});

describe("isStateChangingCall('craft') agrees across pre- and post-dispatch-translation arg shapes", () => {
  // The tick-wait path (passthrough-postprocess.ts) sees the agent-facing
  // payload as typed ("pre" below); the throttle path
  // (http-game-client-v2.ts execute()) sees it AFTER dispatchV1ToV2 has
  // already renamed recipe_id → id ("post" below). Both call the SAME
  // isStateChangingCall/isCraftStateChanging predicate — no second, possibly
  // divergent craft check — so for every semantically-equivalent pair the
  // decision must agree.
  const cases: Array<{ name: string; pre: Record<string, unknown>; post: Record<string, unknown>; expected: boolean }> = [
    { name: "real single-recipe craft", pre: { recipe_id: "steel_plate", count: 5 }, post: { action: "craft", id: "steel_plate", count: 5 }, expected: true },
    { name: "dry_run quote", pre: { recipe_id: "steel_plate", dry_run: true }, post: { action: "craft", id: "steel_plate", dry_run: true }, expected: false },
    { name: "cancel via action:'cancel' (pre only — v2 dispatch key can't carry it post-translation, job_id does)", pre: { action: "cancel", job_id: "job-1" }, post: { action: "craft", job_id: "job-1" }, expected: true },
    { name: "cancel via job_id", pre: { job_id: "job-1" }, post: { action: "craft", job_id: "job-1" }, expected: true },
    { name: "cancel via job_ids", pre: { job_ids: ["job-1", "job-2"] }, post: { action: "craft", job_ids: ["job-1", "job-2"] }, expected: true },
    { name: "bulk jobs", pre: { jobs: [{ recipe_id: "a" }] }, post: { action: "craft", jobs: [{ recipe_id: "a" }] }, expected: true },
    { name: "bare queue read", pre: {}, post: { action: "craft" }, expected: false },
  ];
  for (const c of cases) {
    it(`${c.name}: pre- and post-translation shapes agree (both -> ${c.expected})`, () => {
      expect(isStateChangingCall("craft", c.pre)).toBe(c.expected);
      expect(isStateChangingCall("craft", c.post)).toBe(c.expected);
    });
  }
});
