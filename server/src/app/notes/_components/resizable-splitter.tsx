"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A vertical drag-handle separator for resizing two horizontally-adjacent
 * panels. Reports new widths to the parent through `onWidthsChange`.
 *
 * The parent owns the widths (px) and grid layout; this component is a thin
 * pointer-event handler. No deps, no external libs — just pointermove +
 * pointerup on the window.
 *
 * Persistence is handled by `useColumnWidths` (below) — the splitter itself
 * is presentation-only.
 */
export function ResizableSplitter({
  /** Pixel width of the left panel at the start of a drag. */
  getLeftWidth,
  /** Apply a new pixel width to the left panel. */
  setLeftWidth,
  /** Minimum allowed width for the left panel (defaults to 120). */
  min = 120,
  /** Maximum allowed width for the left panel (defaults to 600). */
  max = 600,
  className,
  ariaLabel,
}: {
  getLeftWidth: () => number;
  setLeftWidth: (px: number) => void;
  min?: number;
  max?: number;
  className?: string;
  ariaLabel?: string;
}) {
  const [dragging, setDragging] = useState(false);
  const startRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Capture the pointer so subsequent move/up events route here even
      // when the pointer leaves the splitter strip.
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      startRef.current = { startX: e.clientX, startWidth: getLeftWidth() };
      setDragging(true);
    },
    [getLeftWidth],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging || !startRef.current) return;
      const delta = e.clientX - startRef.current.startX;
      const next = Math.max(min, Math.min(max, startRef.current.startWidth + delta));
      setLeftWidth(next);
    },
    [dragging, max, min, setLeftWidth],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging) return;
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // Best-effort — pointer may already have released.
      }
      startRef.current = null;
      setDragging(false);
    },
    [dragging],
  );

  // Keyboard a11y — left/right arrows nudge by 16px.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const delta = e.key === "ArrowLeft" ? -16 : 16;
        const next = Math.max(min, Math.min(max, getLeftWidth() + delta));
        setLeftWidth(next);
      }
    },
    [getLeftWidth, max, min, setLeftWidth],
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel ?? "Resize panel"}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onKeyDown={handleKeyDown}
      className={cn(
        "shrink-0 cursor-col-resize select-none touch-none",
        "w-1 hover:bg-primary/40 active:bg-primary/60 transition-colors",
        dragging && "bg-primary/60",
        className,
      )}
      style={{ width: dragging ? 4 : undefined }}
    />
  );
}

/**
 * Persist + manage two column widths in localStorage. Returns `null` on
 * server-side render so the parent can skip rendering grid styles until
 * the client has hydrated and read storage.
 */
export function useColumnWidths(
  storageKey: string,
  defaults: { left: number; right: number },
): {
  widths: { left: number; right: number } | null;
  setLeft: (px: number) => void;
  setRight: (px: number) => void;
  reset: () => void;
} {
  const [widths, setWidths] = useState<{ left: number; right: number } | null>(null);

  // Read from localStorage on mount. Doing this in an effect (instead of
  // useState's lazy initializer) avoids hydration mismatches.
  useEffect(() => {
    if (typeof window === "undefined") {
      setWidths(defaults);
      return;
    }
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<{ left: number; right: number }>;
        setWidths({
          left: typeof parsed.left === "number" ? parsed.left : defaults.left,
          right: typeof parsed.right === "number" ? parsed.right : defaults.right,
        });
        return;
      }
    } catch {
      // Fall through to defaults.
    }
    setWidths(defaults);
    // We deliberately do not include `defaults` in the dependency list — the
    // initial defaults are owned by the caller and shouldn't trigger a
    // re-read after the first mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  // Persist whenever widths change (skip the null pre-hydration state).
  useEffect(() => {
    if (!widths || typeof window === "undefined") return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(widths));
    } catch {
      // Quota / disabled — silently ignore.
    }
  }, [storageKey, widths]);

  const setLeft = useCallback(
    (px: number) => setWidths((cur) => (cur ? { ...cur, left: px } : { left: px, right: defaults.right })),
    [defaults.right],
  );
  const setRight = useCallback(
    (px: number) => setWidths((cur) => (cur ? { ...cur, right: px } : { left: defaults.left, right: px })),
    [defaults.left],
  );
  const reset = useCallback(() => setWidths(defaults), [defaults]);

  return { widths, setLeft, setRight, reset };
}
