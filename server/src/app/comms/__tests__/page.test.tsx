import { describe, test, expect } from "bun:test";
import { buildTimelineRows, type CommsLogEntry } from "../timeline-rows";


function makeEntry(p: Partial<CommsLogEntry> & { id: number; type: string }): CommsLogEntry {
  return {
    id: p.id,
    type: p.type,
    agent: p.agent ?? null,
    message: p.message ?? "msg",
    metadata_json: p.metadata_json ?? null,
    created_at: p.created_at ?? "2026-04-24T00:00:00Z",
  };
}

describe("buildTimelineRows — ORDER/DELIVERY grouping", () => {
  test("collapses an ORDER row + its DELIVERY row into one group", () => {
    const entries: CommsLogEntry[] = [
      makeEntry({
        id: 2,
        type: "delivery",
        agent: "drifter-gale",
        metadata_json: JSON.stringify({ order_id: 42 }),
        created_at: "2026-04-24T00:01:00Z",
      }),
      makeEntry({
        id: 1,
        type: "order",
        agent: "drifter-gale",
        metadata_json: JSON.stringify({ order_id: 42 }),
        created_at: "2026-04-24T00:00:30Z",
      }),
    ];

    const rows = buildTimelineRows(entries);
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("order_group");
    if (rows[0].kind === "order_group") {
      expect(rows[0].order.id).toBe(1);
      expect(rows[0].deliveries.length).toBe(1);
      expect(rows[0].deliveries[0].id).toBe(2);
      expect(rows[0].latestAt).toBe("2026-04-24T00:01:00Z");
    }
  });

  test("groups ORDER with multiple DELIVERY rows for fleet-wide orders", () => {
    const entries: CommsLogEntry[] = [
      makeEntry({
        id: 1,
        type: "order",
        agent: null,
        metadata_json: JSON.stringify({ order_id: 7 }),
      }),
      makeEntry({
        id: 2,
        type: "delivery",
        agent: "drifter-gale",
        metadata_json: JSON.stringify({ order_id: 7 }),
        created_at: "2026-04-24T00:00:30Z",
      }),
      makeEntry({
        id: 3,
        type: "delivery",
        agent: "sable-thorn",
        metadata_json: JSON.stringify({ order_id: 7 }),
        created_at: "2026-04-24T00:01:00Z",
      }),
    ];

    const rows = buildTimelineRows(entries);
    expect(rows.length).toBe(1);
    if (rows[0].kind !== "order_group") throw new Error("expected order_group");
    expect(rows[0].order.id).toBe(1);
    expect(rows[0].deliveries.length).toBe(2);
    // Sorted by created_at ascending
    expect(rows[0].deliveries[0].id).toBe(2);
    expect(rows[0].deliveries[1].id).toBe(3);
  });

  test("REPORT entries stay as single rows", () => {
    const entries: CommsLogEntry[] = [
      makeEntry({ id: 1, type: "report", agent: "drifter-gale", message: "Mining done" }),
      makeEntry({
        id: 2,
        type: "order",
        metadata_json: JSON.stringify({ order_id: 5 }),
      }),
      makeEntry({
        id: 3,
        type: "delivery",
        agent: "drifter-gale",
        metadata_json: JSON.stringify({ order_id: 5 }),
      }),
    ];

    const rows = buildTimelineRows(entries);
    expect(rows.length).toBe(2);
    expect(rows[0].kind).toBe("single");
    if (rows[0].kind === "single") {
      expect(rows[0].entry.type).toBe("report");
    }
    expect(rows[1].kind).toBe("order_group");
  });

  test("orphan delivery (no matching order) renders as single row", () => {
    const entries: CommsLogEntry[] = [
      makeEntry({
        id: 1,
        type: "delivery",
        agent: "drifter-gale",
        metadata_json: JSON.stringify({ order_id: 999 }),
      }),
    ];

    const rows = buildTimelineRows(entries);
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("single");
  });

  test("entries with malformed metadata fall through to single rows", () => {
    const entries: CommsLogEntry[] = [
      makeEntry({ id: 1, type: "order", metadata_json: "{not json" }),
      makeEntry({ id: 2, type: "order", metadata_json: null }),
    ];

    const rows = buildTimelineRows(entries);
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.kind === "single")).toBe(true);
  });

  test("does not duplicate: an order with one delivery yields exactly one row", () => {
    // The original bug: each order showed twice (ORDER + DELIVERY).
    const entries: CommsLogEntry[] = [
      makeEntry({
        id: 1,
        type: "order",
        metadata_json: JSON.stringify({ order_id: 1 }),
      }),
      makeEntry({
        id: 2,
        type: "delivery",
        metadata_json: JSON.stringify({ order_id: 1 }),
      }),
    ];

    const rows = buildTimelineRows(entries);
    expect(rows.length).toBe(1);
  });
});
