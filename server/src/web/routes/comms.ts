import { Router } from "express";
import { validateAgentName } from "../config.js";
import { createLogger } from "../../lib/logger.js";
import {
  createOrder,
  listOrders,
  getPendingOrders,
  markDelivered,
  createReport,
  getCommsLog,
} from "../../services/comms-db.js";
import { createHandoff, getUnconsumedHandoff, consumeHandoff } from "../../services/handoff.js";
import { parseReport } from "../../services/report-parser.js";

const logger = createLogger("comms");
const router: Router = Router();

// List recent orders with delivery status
router.get("/orders", (req, res) => {
  const orders = listOrders();
  res.json({ orders });
});

// Create a new order
router.post("/orders", (req, res) => {
  const body = req.body;
  const { message, target_agent, priority, expires_at } = body;
  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "message is required" });
    return;
  }
  if (target_agent && !validateAgentName(target_agent)) {
    res.status(404).json({ error: "Unknown agent" });
    return;
  }
  const id = createOrder({ message, target_agent, priority, expires_at });
  res.json({ ok: true, id });
});

// Get pending (undelivered) orders for a specific agent
router.get("/orders/pending/:agent", (req, res) => {
  const agent = req.params.agent;
  if (!validateAgentName(agent)) {
    res.status(404).json({ error: "Unknown agent" });
    return;
  }
  const orders = getPendingOrders(agent);
  res.json({ orders });
});

// Mark an order as delivered to an agent
router.post("/orders/:id/delivered", (req, res) => {
  const orderId = Number(req.params.id);
  if (isNaN(orderId)) {
    res.status(400).json({ error: "Invalid order ID" });
    return;
  }
  const body = req.body;
  const { agent } = body;
  if (!agent || !validateAgentName(agent)) {
    res.status(400).json({ error: "Valid agent name required" });
    return;
  }
  markDelivered(orderId, agent);
  res.json({ ok: true });
});

// Get comms log timeline
router.get("/log", (req, res) => {
  const log = getCommsLog();
  res.json({ entries: log });
});

// Store agent report
router.post("/report", (req, res) => {
  const body = req.body;
  const { agent, message } = body;
  if (!agent || !validateAgentName(agent)) {
    res.status(400).json({ error: "Valid agent name required" });
    return;
  }
  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "message is required" });
    return;
  }
  createReport(agent, message);

  // Auto-generate fleet orders from report content
  const parsed = parseReport(agent, message);
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  for (const order of parsed) {
    createOrder({
      message: order.message,
      target_agent: order.target_agent ?? undefined,
      priority: order.priority,
      expires_at: expiresAt,
    });
    logger.info(`[report-pipeline] Auto-created ${order.priority} order from ${agent}: ${order.type}`);
  }

  res.json({ ok: true });
});

router.get("/", (req, res) => {
  const orders = listOrders(10);
  const log = getCommsLog(20);
  res.json({ orders, timeline: log });
});

router.get("/timeline", (req, res) => {
  const log = getCommsLog();
  res.json({ entries: log });
});

// Session handoff routes
router.post("/handoff", (req, res) => {
  const body = req.body;
  const { agent, ...rest } = body;
  if (!agent || !validateAgentName(agent)) {
    res.status(400).json({ error: "Valid agent name required" });
    return;
  }
  const id = createHandoff({ agent, ...rest });
  res.json({ ok: true, id });
});

router.get("/handoff/:agent", (req, res) => {
  const agent = req.params.agent;
  if (!validateAgentName(agent)) {
    res.status(404).json({ error: "Unknown agent" });
    return;
  }
  const handoff = getUnconsumedHandoff(agent);
  res.json({ handoff });
});

router.post("/handoff/:id/consume", (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid ID" });
    return;
  }
  consumeHandoff(id);
  res.json({ ok: true });
});

export default router;
