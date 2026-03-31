"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { formatTime } from "@/lib/time";

interface LogStreamProps {
  agentName: string;
}

interface LogEvent {
  lines: string[];
  offset: number;
}

interface StatusEvent {
  message: string;
}

const MAX_LINES = 500;

export function LogStream({ agentName }: LogStreamProps) {
  const [lines, setLines] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);
  const linesRef = useRef<string[]>([]);
  const closedRef = useRef(false);

  useEffect(() => {
    closedRef.current = false;
    linesRef.current = [];
    setLines([]);
    setConnected(false);
    setError(null);

    const url = `/api/agents/${agentName}/logs/stream`;
    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener("open", () => {
      setConnected(true);
      setError(null);
    });

    es.addEventListener("log", (e: MessageEvent) => {
      try {
        const event = JSON.parse(e.data) as LogEvent;
        linesRef.current.push(...event.lines);
        // Keep only the last MAX_LINES
        if (linesRef.current.length > MAX_LINES) {
          linesRef.current = linesRef.current.slice(-MAX_LINES);
        }
        setLines([...linesRef.current]);
      } catch {
        // Silently ignore parse errors
      }
    });

    es.addEventListener("status", (e: MessageEvent) => {
      try {
        const event = JSON.parse(e.data) as StatusEvent;
        linesRef.current.push(`[STATUS] ${event.message}`);
        if (linesRef.current.length > MAX_LINES) {
          linesRef.current = linesRef.current.slice(-MAX_LINES);
        }
        setLines([...linesRef.current]);
      } catch {
        // Silently ignore parse errors
      }
    });

    es.onerror = () => {
      es.close();
      esRef.current = null;
      setConnected(false);
      setError("Connection lost");
    };

    return () => {
      closedRef.current = true;
      es.close();
      esRef.current = null;
    };
  }, [agentName]);

  // Auto-scroll to bottom when new lines arrive
  useEffect(() => {
    if (containerRef.current) {
      setTimeout(() => {
        containerRef.current?.scrollTo(0, containerRef.current.scrollHeight);
      }, 0);
    }
  }, [lines]);

  /**
   * Replace ISO 8601 and space-separated UTC timestamps in a log line with
   * local time (HH:MM:SS), so users see their local timezone (#511).
   */
  function localizeTimestamps(line: string): string {
    return line.replace(
      /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g,
      (match) => formatTime(match)
    );
  }

  function colorizeLogLine(line: string): {
    color: "inherit" | "error" | "warning";
    className: string;
  } {
    if (line.includes("ERROR") || line.includes("error")) {
      return { color: "error", className: "text-error" };
    }
    if (
      line.includes("Turn") ||
      line.includes("turn") ||
      line.includes("TURN")
    ) {
      return { color: "warning", className: "text-cyan-400" };
    }
    return { color: "inherit", className: "" };
  }

  return (
    <div className="bg-card border border-border p-3 h-full flex flex-col">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Live Logs
        </h3>

        <div className="flex items-center gap-2 text-[10px]">
          {connected && (
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
          )}
          <span
            className={cn(
              "text-muted-foreground",
              connected ? "text-success" : "text-error"
            )}
          >
            {connected ? "Connected" : "Disconnected"}
          </span>
        </div>
      </div>

      {error && (
        <div className="text-[10px] text-error mb-2 py-1 px-2 bg-error/10 border border-error/20">
          {error}
        </div>
      )}

      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto bg-black/20 border border-border/50 p-2 font-mono text-xs leading-5 text-foreground space-y-0"
        style={{
          maxHeight: "calc(100vh - 350px)",
        }}
      >
        {lines.length === 0 && (
          <div className="text-muted-foreground italic text-[10px] py-2">
            Waiting for logs…
          </div>
        )}
        {lines.map((line, idx) => {
          const { className } = colorizeLogLine(line);
          return (
            <div key={idx} className={cn(
              "whitespace-pre-wrap break-words px-1 -mx-1",
              className,
              className === "text-error" && "bg-error/10"
            )}>
              {localizeTimestamps(line)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
