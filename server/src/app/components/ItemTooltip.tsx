"use client";

/**
 * ItemTooltip — hover tooltip showing item stats and module compatibility.
 *
 * Usage (progressive enhancement):
 *   <ItemTooltip itemId="iron_ore">
 *     <span>Iron Ore</span>
 *   </ItemTooltip>
 *
 * Or attach via data attribute and render at a higher level:
 *   <td data-item-id="iron_ore">Iron Ore</td>
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ItemData {
  id: string;
  name: string;
  type?: string;
  mass?: number;
  value?: number;
  legality?: string;
  base_price?: number;
  is_module?: boolean;
  compatible_slots?: string[];
  updated_at?: string;
}

// ---------------------------------------------------------------------------
// Item fetch cache — avoids re-fetching the same item repeatedly
// ---------------------------------------------------------------------------

const itemCache = new Map<string, ItemData | null>();
const itemInflight = new Map<string, Promise<ItemData | null>>();

async function fetchItemData(itemId: string): Promise<ItemData | null> {
  if (itemCache.has(itemId)) return itemCache.get(itemId) ?? null;
  if (itemInflight.has(itemId)) return itemInflight.get(itemId)!;

  const promise = fetch(`/api/catalog?type=item&id=${encodeURIComponent(itemId)}`)
    .then(async (res) => {
      if (!res.ok) return null;
      const body = await res.json() as { items?: ItemData[] };
      const item = body.items?.[0] ?? null;
      itemCache.set(itemId, item);
      return item;
    })
    .catch(() => {
      itemCache.set(itemId, null);
      return null;
    })
    .finally(() => {
      itemInflight.delete(itemId);
    });

  itemInflight.set(itemId, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// Tooltip content
// ---------------------------------------------------------------------------

function TooltipContent({ item }: { item: ItemData }) {
  const LEGALITY_COLORS: Record<string, string> = {
    legal: "text-success",
    illegal: "text-destructive",
    restricted: "text-warning",
  };

  return (
    <div className="space-y-2">
      {/* Header */}
      <div>
        <div className="text-sm font-semibold text-foreground">{item.name}</div>
        {item.type && (
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {item.type}
          </div>
        )}
      </div>

      {/* Stats */}
      <div className="space-y-0.5 text-[11px]">
        {item.base_price != null && (
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Base price</span>
            <span className="text-foreground font-mono">{item.base_price.toLocaleString()} cr</span>
          </div>
        )}
        {item.value != null && (
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Value</span>
            <span className="text-foreground font-mono">{item.value.toLocaleString()}</span>
          </div>
        )}
        {item.mass != null && (
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Mass</span>
            <span className="text-foreground font-mono">{item.mass}</span>
          </div>
        )}
        {item.legality && (
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Legality</span>
            <span className={cn("font-medium capitalize", LEGALITY_COLORS[item.legality] ?? "text-foreground")}>
              {item.legality}
            </span>
          </div>
        )}
      </div>

      {/* Module compatibility */}
      {item.is_module && item.compatible_slots && item.compatible_slots.length > 0 && (
        <div className="border-t border-border/30 pt-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
            Module Slots
          </div>
          <div className="flex flex-wrap gap-1">
            {item.compatible_slots.map((slot) => (
              <span
                key={slot}
                className={cn(
                  "text-[10px] px-1.5 py-0.5 uppercase tracking-wider",
                  slot === "weapon" && "bg-error/20 text-error",
                  slot === "defense" && "bg-info/20 text-info",
                  slot === "utility" && "bg-warning/20 text-warning",
                )}
              >
                {slot}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ItemTooltip component
// ---------------------------------------------------------------------------

export interface ItemTooltipProps {
  itemId: string;
  children: React.ReactNode;
  className?: string;
}

export function ItemTooltip({ itemId, children, className }: ItemTooltipProps) {
  const [item, setItem] = useState<ItemData | null>(null);
  const [loading, setLoading] = useState(false);
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const tooltipRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback(async (e: React.MouseEvent) => {
    setPos({ x: e.clientX, y: e.clientY });
    // Small delay to avoid flash on quick hover-through
    timerRef.current = setTimeout(async () => {
      setVisible(true);
      if (!item && !loading) {
        setLoading(true);
        const data = await fetchItemData(itemId);
        setItem(data);
        setLoading(false);
      }
    }, 300);
  }, [item, loading, itemId]);

  const hide = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setVisible(false);
  }, []);

  const move = useCallback((e: React.MouseEvent) => {
    setPos({ x: e.clientX, y: e.clientY });
  }, []);

  // Cleanup timer on unmount
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  return (
    <>
      <span
        className={cn("cursor-help", className)}
        onMouseEnter={show}
        onMouseLeave={hide}
        onMouseMove={move}
        data-item-id={itemId}
      >
        {children}
      </span>

      {visible && (
        <div
          ref={tooltipRef}
          className="fixed z-50 pointer-events-none"
          style={{
            left: pos.x + 12,
            top: pos.y + 12,
            maxWidth: 260,
          }}
        >
          <div className="bg-card border border-border shadow-xl p-3 text-sm">
            {loading && (
              <div className="text-muted-foreground text-[11px]">Loading…</div>
            )}
            {!loading && !item && (
              <div className="text-muted-foreground text-[11px]">{itemId}</div>
            )}
            {!loading && item && <TooltipContent item={item} />}
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// ItemName — convenience: renders item name with tooltip attached
// ---------------------------------------------------------------------------

export function ItemName({ itemId, fallback }: { itemId: string; fallback?: string }) {
  const [name, setName] = useState<string>(fallback ?? itemId);

  useEffect(() => {
    fetchItemData(itemId).then((item) => {
      if (item?.name) setName(item.name);
    });
  }, [itemId]);

  return (
    <ItemTooltip itemId={itemId}>
      <span>{name}</span>
    </ItemTooltip>
  );
}
