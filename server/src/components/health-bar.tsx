"use client";

import { cn } from "@/lib/utils";

interface HealthBarProps {
  value: number;
  max: number;
  label?: string;
  size?: "sm" | "md";
  /** Invert colors: green when low, red when high (e.g. cargo usage) */
  invert?: boolean;
}

export function HealthBar({ value, max, label, size = "md", invert = false }: HealthBarProps) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;

  const fillColor = invert
    ? pct > 80 ? "bg-error" : pct > 50 ? "bg-warning" : "bg-success"
    : pct > 60 ? "bg-success" : pct > 30 ? "bg-warning" : "bg-error";

  const trackHeight = size === "sm" ? "h-1.5" : "h-2.5";

  return (
    <div className="flex items-center gap-2 w-full">
      {label && (
        <span className="text-foreground text-[10px] uppercase tracking-wider w-10 shrink-0">
          {label}
        </span>
      )}
      <div className={cn("flex-1 bg-background overflow-hidden", trackHeight)}>
        <div
          className={cn("h-full transition-all duration-300", fillColor)}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] font-mono text-foreground tabular-nums w-16 text-right shrink-0">
        {value}/{max}
      </span>
    </div>
  );
}
