import { getDb, queryAll, queryRun, queryInsert } from "./database.js";

interface CreateOrderInput {
  message: string;
  target_agent?: string;
  priority?: "normal" | "urgent";
  expires_at?: string;
}

interface Order {
  id: number;
  target_agent: string | null;
  message: string;
  priority: string;
  created_at: string;
  expires_at: string | null;
}

interface CommsLogEntry {
  id: number;
  type: string;
  agent: string | null;
  message: string;
  metadata_json: string | null;
  created_at: string;
}

export function createOrder(input: CreateOrderInput): number {
  const db = getDb();
  let orderId = 0;
  db.transaction(() => {
    orderId = queryInsert(
      `INSERT INTO fleet_orders (message, target_agent, priority, expires_at) VALUES (?, ?, ?, ?)`,
      input.message,
      input.target_agent ?? null,
      input.priority ?? "normal",
      input.expires_at ?? null,
    );
    queryRun(
      `INSERT INTO fleet_comms_log (type, agent, message, metadata_json) VALUES (?, ?, ?, ?)`,
      "order", input.target_agent ?? null, input.message, JSON.stringify({ order_id: orderId })
    );
  })();
  return orderId;
}

export function listOrders(limit = 50): (Order & { deliveries: { agent: string; delivered_at: string }[] })[] {
  const orders = queryAll<Order>(
    `SELECT * FROM fleet_orders ORDER BY created_at DESC LIMIT ?`,
    limit
  );

  if (orders.length === 0) return [];

  // Batch-fetch all deliveries for the returned orders (avoids N+1)
  const orderIds = orders.map((o) => o.id);
  const placeholders = orderIds.map(() => '?').join(',');
  // Dynamic SQL IN clause - will result in multiple cache entries based on order count
  const allDeliveries = queryAll<{ order_id: number; agent: string; delivered_at: string }>(
    `SELECT order_id, agent, delivered_at FROM fleet_order_deliveries WHERE order_id IN (${placeholders})`,
    ...orderIds
  );

  const deliveriesByOrder = new Map<number, { agent: string; delivered_at: string }[]>();
  for (const d of allDeliveries) {
    let arr = deliveriesByOrder.get(d.order_id);
    if (!arr) { arr = []; deliveriesByOrder.set(d.order_id, arr); }
    arr.push({ agent: d.agent, delivered_at: d.delivered_at });
  }

  return orders.map((order) => ({
    ...order,
    deliveries: deliveriesByOrder.get(order.id) ?? [],
  }));
}

export function getPendingOrders(agentName: string): Order[] {
  return queryAll<Order>(`
    SELECT o.* FROM fleet_orders o
    WHERE (o.target_agent IS NULL OR o.target_agent = ?)
      AND (o.expires_at IS NULL OR o.expires_at > datetime('now'))
      AND o.id NOT IN (
        SELECT order_id FROM fleet_order_deliveries WHERE agent = ?
      )
    ORDER BY
      CASE o.priority WHEN 'urgent' THEN 0 ELSE 1 END,
      o.created_at ASC
  `, agentName, agentName);
}

export function getAllPendingOrders(): Order[] {
  return queryAll<Order>(`
    SELECT * FROM fleet_orders
    WHERE (expires_at IS NULL OR expires_at > datetime('now'))
    ORDER BY
      CASE priority WHEN 'urgent' THEN 0 ELSE 1 END,
      created_at ASC
  `);
}

export function markDelivered(orderId: number, agentName: string): void {
  const db = getDb();
  db.transaction(() => {
    queryRun(
      `INSERT OR IGNORE INTO fleet_order_deliveries (order_id, agent) VALUES (?, ?)`,
      orderId, agentName
    );
    queryRun(
      `INSERT INTO fleet_comms_log (type, agent, message, metadata_json) VALUES (?, ?, ?, ?)`,
      "delivery", agentName, `Order #${orderId} delivered`, JSON.stringify({ order_id: orderId })
    );
  })();
}

export function createReport(agentName: string, message: string): void {
  queryRun(
    `INSERT INTO fleet_comms_log (type, agent, message) VALUES (?, ?, ?)`,
    "report", agentName, message
  );
}

export function getCommsLog(limit = 100): CommsLogEntry[] {
  // Enrich delivery entries with the actual order message via LEFT JOIN
  const rows = queryAll<(CommsLogEntry & { order_message?: string; order_priority?: string; order_target?: string | null })>(`
    SELECT l.*,
           o.message AS order_message,
           o.priority AS order_priority,
           o.target_agent AS order_target
    FROM fleet_comms_log l
    LEFT JOIN fleet_orders o
      ON l.type = 'delivery'
      AND o.id = CAST(json_extract(l.metadata_json, '$.order_id') AS INTEGER)
    ORDER BY l.created_at DESC
    LIMIT ?
  `, limit);

  // Merge order content into delivery messages
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    agent: row.agent,
    message: (row.type === 'delivery' && row.order_message) ? row.order_message : row.message,
    metadata_json: row.metadata_json,
    created_at: row.created_at,
  }));
}
