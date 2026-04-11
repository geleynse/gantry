"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import { useAgentNames } from "@/hooks/use-agent-names";
import { useFleetStatus } from "@/hooks/use-fleet-status";
import { relativeTime } from "@/lib/time";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Order {
  id: number;
  target_agent: string | null;
  message: string;
  priority: string;
  created_at: string;
  expires_at: string | null;
  deliveries: Array<{ agent: string; delivered_at: string }>;
}

interface CommsLogEntry {
  id: number;
  type: string; // "order" | "delivery" | "report"
  agent: string | null;
  message: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function priorityColor(priority: string): string {
  switch (priority) {
    case "critical":
      return "bg-error/10 text-error border border-error/50";
    case "high":
      return "bg-warning/10 text-warning border border-warning/50";
    case "normal":
      return "bg-foreground/10 text-foreground border border-foreground/30";
    default:
      return "bg-muted-foreground/10 text-muted-foreground border border-muted-foreground/30";
  }
}

function eventTypeColor(type: string): string {
  switch (type) {
    case "order":
      return "bg-info/10 text-info border border-info/50";
    case "delivery":
      return "bg-success/10 text-success border border-success/50";
    case "report":
      return "bg-primary/10 text-primary border border-primary/50";
    default:
      return "bg-muted-foreground/10 text-muted-foreground border border-muted-foreground/30";
  }
}

function truncate(text: string, maxLen = 80): string {
  if (text.length <= maxLen) return text;
  // Find last space at or before the limit
  const lastSpace = text.lastIndexOf(" ", maxLen);
  // If we found a space and the word after it looks like a number, include the full number
  if (lastSpace > 0) {
    const wordAfter = text.slice(lastSpace + 1).split(/\s/)[0];
    if (/^-?\d[\d,._]*$/.test(wordAfter)) {
      // The next token is a number — include it
      const endOfNumber = lastSpace + 1 + wordAfter.length;
      return text.slice(0, endOfNumber) + "…";
    }
    // Otherwise truncate at the word boundary
    return text.slice(0, lastSpace) + "…";
  }
  // No space found — fall back to hard truncation
  return text.slice(0, maxLen) + "…";
}

// ---------------------------------------------------------------------------
// Send Order Form
// ---------------------------------------------------------------------------

interface SendOrderFormProps {
  onOrderCreated: () => void;
  agentNames: string[];
}

function SendOrderForm({ onOrderCreated, agentNames }: SendOrderFormProps) {
  const [content, setContent] = useState("");
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set());
  const [fleetWide, setFleetWide] = useState(false);
  const [priority, setPriority] = useState("normal");
  const [expiresIn, setExpiresIn] = useState("24h");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleAgent = (agent: string) => {
    setSelectedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agent)) {
        next.delete(agent);
      } else {
        next.add(agent);
      }
      return next;
    });
  };

  const toggleFleetWide = () => {
    if (!fleetWide) {
      // Selecting fleet-wide: add all agents
      setSelectedAgents(new Set(agentNames));
      setFleetWide(true);
    } else {
      // Deselecting fleet-wide: clear all
      setSelectedAgents(new Set());
      setFleetWide(false);
    }
  };

  const calculateExpiry = (expiresIn: string): string | null => {
    if (expiresIn === "never") return null;
    const minutes = {
      "1h": 60,
      "6h": 360,
      "24h": 1440,
      "48h": 2880,
    }[expiresIn as string] ?? 1440;
    const expiresAt = new Date(Date.now() + minutes * 60 * 1000);
    return expiresAt.toISOString();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) {
      setError("Order content is required");
      return;
    }
    if (selectedAgents.size === 0 && !fleetWide) {
      setError("Select at least one agent or choose fleet-wide");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const expiresAt = calculateExpiry(expiresIn);

      // Submit one order per selected agent, or one fleet-wide order if no specific agents
      if (fleetWide || selectedAgents.size === 0) {
        // Fleet-wide order (target_agent = null)
        await apiFetch("/comms/orders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: content,
            target_agent: null,
            priority,
            expires_at: expiresAt,
          }),
        });
      } else {
        // Individual orders for each selected agent
        for (const agent of selectedAgents) {
          await apiFetch("/comms/orders", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: content,
              target_agent: agent,
              priority,
              expires_at: expiresAt,
            }),
          });
        }
      }

      // Reset form
      setContent("");
      setSelectedAgents(new Set());
      setFleetWide(false);
      setPriority("normal");
      setExpiresIn("24h");
      onOrderCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create order");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-card border border-border p-4 space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-primary">
        Send Order
      </h2>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Content textarea */}
        <div className="space-y-1.5">
          <label className="block text-xs uppercase tracking-wider text-muted-foreground">
            Order Content
          </label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Enter order message…"
            rows={4}
            className="bg-background border border-border text-foreground text-xs px-3 py-2 w-full focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>

        {/* Targets: Fleet-wide + agent checkboxes */}
        <div className="space-y-2">
          <label className="block text-xs uppercase tracking-wider text-muted-foreground">
            Targets
          </label>
          <div className="space-y-2">
            {/* Fleet-wide checkbox */}
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={fleetWide}
                onChange={toggleFleetWide}
                className="w-4 h-4 accent-primary"
              />
              <span className="text-xs text-foreground">Fleet-wide (all agents)</span>
            </label>

            {/* Individual agent checkboxes */}
            {agentNames.map((agent) => (
              <label key={agent} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedAgents.has(agent)}
                  onChange={() => toggleAgent(agent)}
                  disabled={fleetWide}
                  className="w-4 h-4 accent-primary disabled:opacity-50"
                />
                <span className={cn("text-xs", fleetWide ? "text-muted-foreground" : "text-foreground")}>
                  {agent}
                </span>
              </label>
            ))}
          </div>
        </div>

        {/* Priority */}
        <div className="space-y-2">
          <label className="block text-xs uppercase tracking-wider text-muted-foreground">
            Priority
          </label>
          <div className="space-y-1.5">
            {["low", "normal", "high", "critical"].map((p) => (
              <label key={p} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="priority"
                  value={p}
                  checked={priority === p}
                  onChange={(e) => setPriority(e.target.value)}
                  className="w-4 h-4 accent-primary"
                />
                <span className="text-xs text-foreground capitalize">{p}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Expiry */}
        <div className="space-y-1.5">
          <label className="block text-xs uppercase tracking-wider text-muted-foreground">
            Expiry
          </label>
          <select
            value={expiresIn}
            onChange={(e) => setExpiresIn(e.target.value)}
            className="bg-background border border-border text-foreground text-xs px-3 py-2 w-full focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="1h">1 hour</option>
            <option value="6h">6 hours</option>
            <option value="24h">24 hours</option>
            <option value="48h">48 hours</option>
            <option value="never">Never expire</option>
          </select>
        </div>

        {/* Error message */}
        {error && (
          <div className="text-xs text-error bg-error/10 border border-error/50 p-2">
            {error}
          </div>
        )}

        {/* Submit button */}
        <button
          type="submit"
          disabled={loading}
          className="w-full bg-primary text-primary-foreground px-4 py-2 text-xs uppercase tracking-wider hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          {loading ? "Creating…" : "Send Order"}
        </button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Orders List
// ---------------------------------------------------------------------------

interface OrdersListProps {
  orders: Order[];
  loading: boolean;
  onlineAgents: Set<string>;
}

function OrdersList({ orders, loading, onlineAgents }: OrdersListProps) {
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  function toggleExpand(id: number) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="bg-card border border-border p-4 space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-primary">
        Recent Orders
      </h2>

      {loading && (
        <div className="text-xs text-muted-foreground">Loading orders…</div>
      )}

      {!loading && orders.length === 0 && (
        <div className="text-xs text-muted-foreground">No orders yet</div>
      )}

      {!loading && orders.length > 0 && (
        <div className="space-y-2 max-h-96 overflow-y-auto">
          {orders.map((order) => {
            const isExpanded = expandedIds.has(order.id);
            const isLong = order.message.length > 100;
            return (
              <div
                key={order.id}
                className={cn(
                  "border border-border bg-background p-2.5 space-y-1.5",
                  isLong && "cursor-pointer hover:bg-secondary/30 transition-colors"
                )}
                onClick={isLong ? () => toggleExpand(order.id) : undefined}
              >
                {/* Header: ID, priority, target */}
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[10px] font-mono text-muted-foreground">
                      #{order.id}
                    </span>
                    <span
                      className={cn(
                        "text-[10px] px-1.5 py-0.5 font-mono",
                        priorityColor(order.priority)
                      )}
                    >
                      {order.priority.toUpperCase()}
                    </span>
                  </div>
                  {order.target_agent && (
                    <span className="text-[10px] text-primary shrink-0">
                      → {order.target_agent}
                    </span>
                  )}
                  {!order.target_agent && (
                    <span className="text-[10px] text-info shrink-0">FLEET-WIDE</span>
                  )}
                </div>

                {/* Message: full when expanded, truncated otherwise */}
                <p className="text-xs text-foreground leading-tight whitespace-pre-wrap">
                  {isExpanded ? order.message : truncate(order.message, 100)}
                </p>

                {/* Deliveries (shown when expanded) */}
                {isExpanded && order.deliveries.length > 0 && (
                  <div className="border-t border-border pt-1.5 mt-1.5 space-y-0.5">
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      Deliveries
                    </div>
                    {order.deliveries.map((d) => (
                      <div key={d.agent} className="text-[10px] text-success flex items-center justify-between">
                        <span>{d.agent}</span>
                        <span className="text-muted-foreground">{relativeTime(d.delivered_at)}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Footer: time + delivery status */}
                <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                  <span>{relativeTime(order.created_at)}</span>
                  <div className="flex items-center gap-2">
                    {order.deliveries.length > 0 && (
                      <span className="text-success">
                        Delivered to {order.deliveries.length} agent(s)
                      </span>
                    )}
                    {order.deliveries.length === 0 && (() => {
                      const targetOffline = order.target_agent && !onlineAgents.has(order.target_agent);
                      return (
                        <span className={targetOffline ? "text-muted-foreground" : "text-warning"}>
                          {targetOffline ? "⚠ Pending — agent offline" : "Pending delivery"}
                        </span>
                      );
                    })()}
                    {isLong && (
                      <span className="text-muted-foreground">
                        {isExpanded ? "[-]" : "[+]"}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Comms Timeline
// ---------------------------------------------------------------------------

interface CommsTimelineProps {
  entries: CommsLogEntry[];
  loading: boolean;
}

function CommsTimeline({ entries, loading }: CommsTimelineProps) {
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  function toggleExpand(id: number) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="bg-card border border-border p-4 space-y-3 flex flex-col h-full">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-primary shrink-0">
        Comms Timeline
      </h2>

      {loading && (
        <div className="text-xs text-muted-foreground">Loading timeline…</div>
      )}

      {!loading && entries.length === 0 && (
        <div className="text-xs text-muted-foreground">No activity yet</div>
      )}

      {!loading && entries.length > 0 && (
        <div className="space-y-2 overflow-y-auto flex-1 min-h-0">
          {entries.map((entry) => {
            const isLong = entry.message.length > 120;
            const isExpanded = expandedIds.has(entry.id);
            return (
              <div
                key={entry.id}
                className={cn(
                  "border border-border bg-background p-2.5 space-y-1.5",
                  isLong && "cursor-pointer hover:bg-secondary/30 transition-colors"
                )}
                onClick={isLong ? () => toggleExpand(entry.id) : undefined}
              >
                {/* Header: type badge, agent, time */}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={cn(
                        "text-[10px] px-1.5 py-0.5 font-mono",
                        eventTypeColor(entry.type)
                      )}
                    >
                      {entry.type.toUpperCase()}
                    </span>
                    {entry.agent && (
                      <span className="text-[10px] text-primary truncate">
                        {entry.agent}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {isLong && (
                      <span className="text-[10px] text-muted-foreground">
                        {isExpanded ? "[-]" : "[+]"}
                      </span>
                    )}
                    <span className="text-[10px] text-muted-foreground">
                      {relativeTime(entry.created_at)}
                    </span>
                  </div>
                </div>

                {/* Message: full when expanded, truncated otherwise */}
                <p className="text-xs text-foreground leading-tight whitespace-pre-wrap">
                  {isExpanded ? entry.message : truncate(entry.message, 120)}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function CommsPage() {
  const { isAdmin } = useAuth();
  const agentNames = useAgentNames();
  const { data: fleetStatus } = useFleetStatus();
  const onlineAgents = useMemo(() => {
    const set = new Set<string>();
    for (const a of fleetStatus?.agents ?? []) {
      if (a.llmRunning) set.add(a.name);
    }
    return set;
  }, [fleetStatus]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [timeline, setTimeline] = useState<CommsLogEntry[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [timelineLoading, setTimelineLoading] = useState(true);

  const fetchOrders = useCallback(async () => {
    try {
      setOrdersLoading(true);
      const data = await apiFetch<{ orders: Order[] }>("/comms/orders");
      setOrders(data.orders);
    } catch (err) {
      console.error("Failed to fetch orders:", err);
    } finally {
      setOrdersLoading(false);
    }
  }, []);

  const fetchTimeline = useCallback(async () => {
    try {
      setTimelineLoading(true);
      const data = await apiFetch<{ entries: CommsLogEntry[] }>("/comms/log");
      setTimeline(data.entries);
    } catch (err) {
      console.error("Failed to fetch timeline:", err);
    } finally {
      setTimelineLoading(false);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchOrders();
    fetchTimeline();
  }, [fetchOrders, fetchTimeline]);

  // Auto-refresh timeline every 30 seconds
  useEffect(() => {
    const interval = setInterval(fetchTimeline, 30_000);
    return () => clearInterval(interval);
  }, [fetchTimeline]);

  return (
    <div className="space-y-6">
      {/* Page heading */}
      <div className="border-b border-primary/20 pb-4">
        <h1 className="text-lg font-semibold text-primary uppercase tracking-wider">
          Fleet Comms
        </h1>
      </div>

      {/* Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-[calc(100vh-240px)]">
        {/* Left column: form + orders list */}
        <div className="lg:col-span-1 flex flex-col gap-6 min-h-0 overflow-y-auto">
          {isAdmin && <SendOrderForm onOrderCreated={fetchOrders} agentNames={agentNames} />}
          <OrdersList orders={orders} loading={ordersLoading} onlineAgents={onlineAgents} />
        </div>

        {/* Right column: timeline */}
        <div className="lg:col-span-2 min-h-0 overflow-hidden">
          <CommsTimeline entries={timeline} loading={timelineLoading} />
        </div>
      </div>
    </div>
  );
}
