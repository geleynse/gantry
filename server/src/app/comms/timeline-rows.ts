/**
 * Comms timeline grouping logic.
 *
 * The fleet_comms_log table records each order as two rows: one `order` row
 * when an operator queues it, and one `delivery` row per agent that picks it
 * up. Both rows share an `order_id` in their `metadata_json`. The original
 * timeline rendered them as two separate cards, which the operator
 * justifiably called "duplicate listings".
 *
 * `buildTimelineRows` collapses each ORDER + matching DELIVERIES into a
 * single grouped row. Reports and orphan deliveries (e.g. an order entry
 * that aged out of the visible window) stay as standalone rows.
 *
 * Lives in its own module so the page.tsx file only exports `default`,
 * which Next.js requires for client page modules.
 */

export interface CommsLogEntry {
  id: number;
  type: string; // "order" | "delivery" | "report"
  agent: string | null;
  message: string;
  metadata_json: string | null;
  created_at: string;
}

export type TimelineRow =
  | { kind: "single"; entry: CommsLogEntry }
  | {
      kind: "order_group";
      order: CommsLogEntry;
      deliveries: CommsLogEntry[];
      /** Newest event in the group — used for descending sort. */
      latestAt: string;
    };

function parseMetadata(meta: string | null): Record<string, unknown> | null {
  if (!meta) return null;
  try {
    const parsed = JSON.parse(meta);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function getOrderId(entry: CommsLogEntry): number | null {
  const meta = parseMetadata(entry.metadata_json);
  if (!meta) return null;
  const id = meta.order_id;
  return typeof id === "number" ? id : null;
}

export function buildTimelineRows(entries: CommsLogEntry[]): TimelineRow[] {
  const ordersByOrderId = new Map<number, CommsLogEntry>();
  const deliveriesByOrderId = new Map<number, CommsLogEntry[]>();

  // First pass: index orders + deliveries by order_id.
  for (const entry of entries) {
    const orderId = getOrderId(entry);
    if (orderId == null) continue;
    if (entry.type === "order") {
      ordersByOrderId.set(orderId, entry);
    } else if (entry.type === "delivery") {
      const list = deliveriesByOrderId.get(orderId) ?? [];
      list.push(entry);
      deliveriesByOrderId.set(orderId, list);
    }
  }

  const consumed = new Set<number>();
  const rows: TimelineRow[] = [];

  // Second pass: emit grouped rows in input order. The first time we
  // encounter the order or any of its deliveries we render the whole
  // group, then skip the rest via `consumed`.
  for (const entry of entries) {
    if (consumed.has(entry.id)) continue;

    const orderId = getOrderId(entry);

    if (orderId != null) {
      const orderEntry = ordersByOrderId.get(orderId);
      const deliveries = deliveriesByOrderId.get(orderId) ?? [];

      if (orderEntry && (entry.id === orderEntry.id || deliveries.some((d) => d.id === entry.id))) {
        consumed.add(orderEntry.id);
        for (const d of deliveries) consumed.add(d.id);
        const latestAt = deliveries.reduce(
          (acc, d) => (d.created_at > acc ? d.created_at : acc),
          orderEntry.created_at,
        );
        rows.push({
          kind: "order_group",
          order: orderEntry,
          deliveries: [...deliveries].sort((a, b) =>
            a.created_at < b.created_at ? -1 : 1,
          ),
          latestAt,
        });
        continue;
      }
    }

    // Fallback: standalone row (reports, orphan deliveries, malformed metadata).
    consumed.add(entry.id);
    rows.push({ kind: "single", entry });
  }

  return rows;
}
