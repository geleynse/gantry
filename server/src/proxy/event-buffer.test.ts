import { describe, it, expect } from "bun:test";
import { EventBuffer, EventPriority, type GameEvent, categorizeEvent } from "./event-buffer.js";

describe("categorizeEvent", () => {
  it("classifies combat_update as critical", () => {
    expect(categorizeEvent("combat_update")).toBe(EventPriority.Critical);
  });

  it("classifies player_died as critical", () => {
    expect(categorizeEvent("player_died")).toBe(EventPriority.Critical);
  });

  it("classifies trade_offer_received as critical", () => {
    expect(categorizeEvent("trade_offer_received")).toBe(EventPriority.Critical);
  });

  it("classifies scan_detected as critical", () => {
    expect(categorizeEvent("scan_detected")).toBe(EventPriority.Critical);
  });

  it("classifies police_warning as critical", () => {
    expect(categorizeEvent("police_warning")).toBe(EventPriority.Critical);
  });

  it("classifies pirate_combat as critical", () => {
    expect(categorizeEvent("pirate_combat")).toBe(EventPriority.Critical);
  });

  it("classifies respawn_state as critical", () => {
    expect(categorizeEvent("respawn_state")).toBe(EventPriority.Critical);
  });

  it("classifies tick as internal", () => {
    expect(categorizeEvent("tick")).toBe(EventPriority.Internal);
  });

  it("classifies state_update as internal", () => {
    expect(categorizeEvent("state_update")).toBe(EventPriority.Internal);
  });

  it("classifies welcome as internal", () => {
    expect(categorizeEvent("welcome")).toBe(EventPriority.Internal);
  });

  it("classifies logged_in as internal", () => {
    expect(categorizeEvent("logged_in")).toBe(EventPriority.Internal);
  });

  it("classifies chat_message as normal", () => {
    expect(categorizeEvent("chat_message")).toBe(EventPriority.Normal);
  });

  it("classifies arrived as normal", () => {
    expect(categorizeEvent("arrived")).toBe(EventPriority.Normal);
  });

  it("classifies unknown types as normal", () => {
    expect(categorizeEvent("some_future_event")).toBe(EventPriority.Normal);
  });
});

describe("EventBuffer", () => {
  it("starts empty", () => {
    const buf = new EventBuffer();
    expect(buf.drain()).toEqual([]);
    expect(buf.drainCritical()).toEqual([]);
    expect(buf.size).toBe(0);
  });

  it("stores and drains events in order", () => {
    const buf = new EventBuffer();
    buf.push({ type: "chat_message", payload: { text: "hello" }, receivedAt: 1 });
    buf.push({ type: "arrived", payload: { poi: "sol_station" }, receivedAt: 2 });
    const events = buf.drain();
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("chat_message");
    expect(events[1].type).toBe("arrived");
    // drain clears the buffer
    expect(buf.drain()).toEqual([]);
  });

  it("drainCritical only returns critical events and removes them", () => {
    const buf = new EventBuffer();
    buf.push({ type: "chat_message", payload: {}, receivedAt: 1 });
    buf.push({ type: "combat_update", payload: { damage: 10 }, receivedAt: 2 });
    buf.push({ type: "arrived", payload: {}, receivedAt: 3 });
    buf.push({ type: "player_died", payload: {}, receivedAt: 4 });

    const critical = buf.drainCritical();
    expect(critical).toHaveLength(2);
    expect(critical[0].type).toBe("combat_update");
    expect(critical[1].type).toBe("player_died");

    // Non-critical events remain
    const remaining = buf.drain();
    expect(remaining).toHaveLength(2);
    expect(remaining[0].type).toBe("chat_message");
    expect(remaining[1].type).toBe("arrived");
  });

  it("does not store internal events", () => {
    const buf = new EventBuffer();
    buf.push({ type: "tick", payload: { tick: 1 }, receivedAt: 1 });
    buf.push({ type: "state_update", payload: {}, receivedAt: 2 });
    buf.push({ type: "welcome", payload: {}, receivedAt: 3 });
    buf.push({ type: "logged_in", payload: {}, receivedAt: 4 });
    expect(buf.size).toBe(0);
    expect(buf.drain()).toEqual([]);
  });

  it("respects max capacity and drops oldest events", () => {
    const buf = new EventBuffer(3);
    buf.push({ type: "chat_message", payload: { n: 1 }, receivedAt: 1 });
    buf.push({ type: "chat_message", payload: { n: 2 }, receivedAt: 2 });
    buf.push({ type: "chat_message", payload: { n: 3 }, receivedAt: 3 });
    buf.push({ type: "chat_message", payload: { n: 4 }, receivedAt: 4 });
    const events = buf.drain();
    expect(events).toHaveLength(3);
    expect((events[0].payload as { n: number }).n).toBe(2); // oldest dropped
  });

  it("drain with type filter returns only matching events", () => {
    const buf = new EventBuffer();
    buf.push({ type: "chat_message", payload: { text: "hi" }, receivedAt: 1 });
    buf.push({ type: "arrived", payload: {}, receivedAt: 2 });
    buf.push({ type: "chat_message", payload: { text: "bye" }, receivedAt: 3 });

    const chats = buf.drain(["chat_message"]);
    expect(chats).toHaveLength(2);
    // Non-matching events remain
    const rest = buf.drain();
    expect(rest).toHaveLength(1);
    expect(rest[0].type).toBe("arrived");
  });

  it("drain with limit returns only N events, keeps rest in buffer", () => {
    const buf = new EventBuffer();
    buf.push({ type: "chat_message", payload: { n: 1 }, receivedAt: 1 });
    buf.push({ type: "chat_message", payload: { n: 2 }, receivedAt: 2 });
    buf.push({ type: "chat_message", payload: { n: 3 }, receivedAt: 3 });
    buf.push({ type: "arrived", payload: { n: 4 }, receivedAt: 4 });
    buf.push({ type: "arrived", payload: { n: 5 }, receivedAt: 5 });

    const first = buf.drain(undefined, 2);
    expect(first).toHaveLength(2);
    expect((first[0].payload as { n: number }).n).toBe(1);
    expect((first[1].payload as { n: number }).n).toBe(2);

    // Remaining 3 events still in buffer
    expect(buf.size).toBe(3);
    const rest = buf.drain();
    expect(rest).toHaveLength(3);
  });

  it("drain with limit larger than buffer returns all events", () => {
    const buf = new EventBuffer();
    buf.push({ type: "chat_message", payload: {}, receivedAt: 1 });
    buf.push({ type: "arrived", payload: {}, receivedAt: 2 });

    const events = buf.drain(undefined, 100);
    expect(events).toHaveLength(2);
    expect(buf.size).toBe(0);
  });

  it("drain with type filter and limit caps matching events", () => {
    const buf = new EventBuffer();
    buf.push({ type: "chat_message", payload: { text: "a" }, receivedAt: 1 });
    buf.push({ type: "arrived", payload: {}, receivedAt: 2 });
    buf.push({ type: "chat_message", payload: { text: "b" }, receivedAt: 3 });
    buf.push({ type: "chat_message", payload: { text: "c" }, receivedAt: 4 });

    const chats = buf.drain(["chat_message"], 1);
    expect(chats).toHaveLength(1);
    expect((chats[0].payload as { text: string }).text).toBe("a");

    // Excess matching events + non-matching events stay in buffer
    const rest = buf.drain();
    expect(rest).toHaveLength(3);
    expect(rest[0].type).toBe("arrived");
    expect(rest[1].type).toBe("chat_message"); // text "b"
    expect(rest[2].type).toBe("chat_message"); // text "c"
  });

  it("pushReconnectMarker adds a special event", () => {
    const buf = new EventBuffer();
    buf.pushReconnectMarker();
    const events = buf.drain();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("_reconnected");
  });
});

describe("EventBuffer circular buffer", () => {
  it("push wraps around correctly after overflow", () => {
    const buf = new EventBuffer(3);
    for (let i = 1; i <= 5; i++) {
      buf.push({ type: "chat_message", payload: { n: i }, receivedAt: i });
    }
    expect(buf.size).toBe(3);
    const events = buf.drain();
    expect(events.map(e => (e.payload as { n: number }).n)).toEqual([3, 4, 5]);
  });

  it("maintains order through multiple overflow cycles", () => {
    const buf = new EventBuffer(4);
    // Push 12 events (3 full cycles)
    for (let i = 1; i <= 12; i++) {
      buf.push({ type: "arrived", payload: { n: i }, receivedAt: i });
    }
    expect(buf.size).toBe(4);
    const events = buf.drain();
    expect(events.map(e => (e.payload as { n: number }).n)).toEqual([9, 10, 11, 12]);
  });

  it("drain with limit works correctly after wrap-around", () => {
    const buf = new EventBuffer(4);
    for (let i = 1; i <= 6; i++) {
      buf.push({ type: "chat_message", payload: { n: i }, receivedAt: i });
    }
    // Buffer has [3,4,5,6], drain first 2
    const first = buf.drain(undefined, 2);
    expect(first.map(e => (e.payload as { n: number }).n)).toEqual([3, 4]);
    expect(buf.size).toBe(2);
    const rest = buf.drain();
    expect(rest.map(e => (e.payload as { n: number }).n)).toEqual([5, 6]);
  });

  it("drainCritical works after wrap-around", () => {
    const buf = new EventBuffer(4);
    buf.push({ type: "chat_message", payload: {}, receivedAt: 1 });
    buf.push({ type: "combat_update", payload: {}, receivedAt: 2 });
    buf.push({ type: "arrived", payload: {}, receivedAt: 3 });
    buf.push({ type: "player_died", payload: {}, receivedAt: 4 });
    // Overflow: push one more to wrap head pointer
    buf.push({ type: "chat_message", payload: { late: true }, receivedAt: 5 });

    const critical = buf.drainCritical();
    expect(critical).toHaveLength(2);
    expect(critical[0].type).toBe("combat_update");
    expect(critical[1].type).toBe("player_died");

    const rest = buf.drain();
    expect(rest).toHaveLength(2);
    expect(rest[0].type).toBe("arrived");
    expect(rest[1].type).toBe("chat_message");
  });

  it("findAndRemove works after wrap-around", () => {
    const buf = new EventBuffer(3);
    for (let i = 1; i <= 5; i++) {
      buf.push({ type: "chat_message", payload: { n: i }, receivedAt: i });
    }
    // Buffer has [3,4,5]
    const found = buf.findAndRemove(e => (e.payload as { n: number }).n === 4);
    expect(found).toBeDefined();
    expect((found!.payload as { n: number }).n).toBe(4);
    expect(buf.size).toBe(2);
    const rest = buf.drain();
    expect(rest.map(e => (e.payload as { n: number }).n)).toEqual([3, 5]);
  });

  it("hasEventOfType works after wrap-around", () => {
    const buf = new EventBuffer(3);
    buf.push({ type: "chat_message", payload: {}, receivedAt: 1 });
    buf.push({ type: "arrived", payload: {}, receivedAt: 2 });
    buf.push({ type: "combat_update", payload: {}, receivedAt: 3 });
    buf.push({ type: "chat_message", payload: {}, receivedAt: 4 }); // overflow

    expect(buf.hasEventOfType(["combat_update"])).toBe(true);
    expect(buf.hasEventOfType(["player_died"])).toBe(false);
  });

  it("push and drain at capacity=1", () => {
    const buf = new EventBuffer(1);
    buf.push({ type: "chat_message", payload: { n: 1 }, receivedAt: 1 });
    buf.push({ type: "arrived", payload: { n: 2 }, receivedAt: 2 });
    expect(buf.size).toBe(1);
    const events = buf.drain();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("arrived");
  });
});

// ---------------------------------------------------------------------------
// mining_yield drone_id preservation — v0.329.0 added drone_id to mining_yield
// notification payloads. The EventBuffer stores payloads as opaque `unknown` and
// returns them verbatim, so no stripping can occur. These tests confirm that.
// ---------------------------------------------------------------------------

describe("mining_yield drone_id preservation (v0.329.0+)", () => {
  it("preserves drone_id in a mining_yield event payload", () => {
    const buf = new EventBuffer();
    buf.push({
      type: "mining_yield",
      payload: { ore_type: "iron_ore", quantity: 4, drone_id: "drone_a1b2" },
      receivedAt: Date.now(),
    });
    const events = buf.drain();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("mining_yield");
    const p = events[0].payload as Record<string, unknown>;
    expect(p.drone_id).toBe("drone_a1b2");
    expect(p.ore_type).toBe("iron_ore");
    expect(p.quantity).toBe(4);
  });

  it("preserves drone_id when mining_yield is mixed with other events", () => {
    const buf = new EventBuffer();
    buf.push({ type: "arrived", payload: { poi: "main_belt" }, receivedAt: 1 });
    buf.push({
      type: "mining_yield",
      payload: { ore_type: "copper_ore", quantity: 2, drone_id: "drone_x9y0", automated: true },
      receivedAt: 2,
    });
    buf.push({ type: "chat_message", payload: { text: "hello" }, receivedAt: 3 });

    // Drain only mining_yield events
    const miningEvents = buf.drain(["mining_yield"]);
    expect(miningEvents).toHaveLength(1);
    const p = miningEvents[0].payload as Record<string, unknown>;
    expect(p.drone_id).toBe("drone_x9y0");
    expect(p.automated).toBe(true);

    // Other events remain
    expect(buf.size).toBe(2);
  });

  it("mining_yield without drone_id is not modified", () => {
    // Pre-v0.329.0 manual mine events have no drone_id — buffer must not inject one.
    const buf = new EventBuffer();
    buf.push({
      type: "mining_yield",
      payload: { ore_type: "silver_ore", quantity: 1 },
      receivedAt: Date.now(),
    });
    const events = buf.drain();
    const p = events[0].payload as Record<string, unknown>;
    expect(p.drone_id).toBeUndefined();
  });
});
