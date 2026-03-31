import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createDatabase, closeDb } from "./database.js";
import { createHandoff, getUnconsumedHandoff, consumeHandoff } from "./handoff.js";

describe("handoff service", () => {
  beforeEach(() => {
    createDatabase(":memory:");
  });
  afterEach(() => closeDb());

  it("creates and retrieves a handoff", () => {
    createHandoff({
      agent: "drifter-gale",
      location_system: "SOL-001",
      location_poi: "Station Alpha",
      credits: 5000,
      fuel: 80,
      cargo_summary: JSON.stringify([{ item_id: "iron", quantity: 50 }]),
      last_actions: JSON.stringify(["mine", "mine", "sell"]),
      active_goals: "Mine iron until cargo full, then sell",
    });
    const handoff = getUnconsumedHandoff("drifter-gale");
    expect(handoff).not.toBeNull();
    expect(handoff!.location_system).toBe("SOL-001");
    expect(handoff!.credits).toBe(5000);
  });

  it("returns null when no handoff exists", () => {
    const handoff = getUnconsumedHandoff("drifter-gale");
    expect(handoff).toBeNull();
  });

  it("marks handoff as consumed", () => {
    createHandoff({ agent: "drifter-gale", credits: 1000 });
    const handoff = getUnconsumedHandoff("drifter-gale");
    consumeHandoff(handoff!.id);
    const again = getUnconsumedHandoff("drifter-gale");
    expect(again).toBeNull();
  });

  it("only returns latest unconsumed handoff", () => {
    createHandoff({ agent: "drifter-gale", credits: 1000 });
    createHandoff({ agent: "drifter-gale", credits: 2000 });
    const handoff = getUnconsumedHandoff("drifter-gale");
    expect(handoff!.credits).toBe(2000);
  });
});
