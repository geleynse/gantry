import { describe, it, expect, beforeEach } from "bun:test";
import { OverseerEventLog } from "./overseer-event-log.js";
import type { GameEvent } from "../proxy/event-buffer.js";

function makeEvent(type: string, payload: unknown = {}): GameEvent {
  return { type, payload, receivedAt: Date.now() };
}

describe("OverseerEventLog", () => {
  let log: OverseerEventLog;

  beforeEach(() => {
    log = new OverseerEventLog(30 * 60 * 1000);
  });

  it("stores pushed events and returns them via since()", () => {
    const before = Date.now();
    log.push("gale", makeEvent("trade_fill", { item: "iron" }));
    log.push("sable", makeEvent("combat_update", { damage: 10 }));

    const events = log.since(before - 1);
    expect(events).toHaveLength(2);
    expect(events[0].agent).toBe("gale");
    expect(events[1].agent).toBe("sable");
  });

  it("since() filters by timestamp", () => {
    const t1 = Date.now();
    log.push("gale", makeEvent("trade_fill"));
    // Force a gap
    const entry = (log as any).events[0];
    entry.timestamp = t1 - 1000; // backdate it

    log.push("sable", makeEvent("combat_update"));

    const events = log.since(t1);
    expect(events).toHaveLength(1);
    expect(events[0].agent).toBe("sable");
  });

  it("prune() removes old events", () => {
    const shortLog = new OverseerEventLog(1);
    shortLog.push("gale", makeEvent("old_event"));
    // Backdate the event
    const entry = (shortLog as any).events[0];
    entry.timestamp = Date.now() - 100;

    shortLog.prune();
    expect(shortLog.since(0)).toHaveLength(0);
  });

  it("since() does not consume events (non-destructive)", () => {
    log.push("gale", makeEvent("trade_fill"));
    const ts = Date.now() - 1;

    const first = log.since(ts);
    const second = log.since(ts);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });

  it("size reflects current event count", () => {
    expect(log.size).toBe(0);
    log.push("gale", makeEvent("x"));
    expect(log.size).toBe(1);
    log.push("sable", makeEvent("y"));
    expect(log.size).toBe(2);
  });
});
