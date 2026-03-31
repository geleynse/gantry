"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface LogEvent {
  lines: string[];
  offset: number;
}

interface StatusEvent {
  message: string;
}

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const MAX_LINES = 500;
const LOG_LEVELS: LogLevel[] = ["DEBUG", "INFO", "WARN", "ERROR"];

export function ServerLogStream() {
  const [lines, setLines] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enabledLevels, setEnabledLevels] = useState<Set<LogLevel>>(new Set(LOG_LEVELS));
  const containerRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);
  const linesRef = useRef<string[]>([]);
  const closedRef = useRef(false);

  useEffect(() => {
    closedRef.current = false;
    linesRef.current = [];

    const url = `/api/server/logs/stream`;
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
  }, []);

  // Auto-scroll to bottom when new lines arrive
  useEffect(() => {
    if (containerRef.current) {
      setTimeout(() => {
        containerRef.current?.scrollTo(0, containerRef.current.scrollHeight);
      }, 0);
    }
  }, [lines]);

  function getLogLevel(line: string): LogLevel | null {
    if (line.includes("[ERROR]")) return "ERROR";
    if (line.includes("[WARN]")) return "WARN";
    if (line.includes("[INFO]")) return "INFO";
    if (line.includes("[DEBUG]")) return "DEBUG";
    return null;
  }

  function colorizeLogLine(line: string): {
    color: "inherit" | "error" | "warning" | "success" | "info";
    className: string;
  } {
    if (line.includes("[ERROR]")) {
      return { color: "error", className: "text-error bg-error/10" };
    }
    if (line.includes("[WARN]")) {
      return { color: "warning", className: "text-yellow-400 bg-yellow-400/10" };
    }
    if (line.includes("[INFO]")) {
      return { color: "success", className: "text-success" };
    }
    if (line.includes("[DEBUG]")) {
      return { color: "info", className: "text-cyan-400" };
    }
    return { color: "inherit", className: "" };
  }

  function toggleLogLevel(level: LogLevel) {
    setEnabledLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) {
        next.delete(level);
      } else {
        next.add(level);
      }
      return next;
    });
  }

  const filteredLines = lines.filter((line) => {
    const level = getLogLevel(line);
    if (!level) return true; // Show lines with no level tag
    return enabledLevels.has(level);
  });

  return (
    <div className="bg-card border border-border p-3 h-full flex flex-col">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Server Logs (Structured)
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

      <div className="flex gap-1 mb-2 flex-wrap">
        {LOG_LEVELS.map((level) => (
          <button
            key={level}
            onClick={() => toggleLogLevel(level)}
            className={cn(
              "text-[10px] px-2 py-1 rounded border transition-colors",
              enabledLevels.has(level)
                ? level === "ERROR"
                  ? "bg-error/20 border-error/50 text-error"
                  : level === "WARN"
                  ? "bg-yellow-400/20 border-yellow-400/50 text-yellow-400"
                  : level === "INFO"
                  ? "bg-success/20 border-success/50 text-success"
                  : "bg-cyan-400/20 border-cyan-400/50 text-cyan-400"
                : "bg-muted/30 border-border/30 text-muted-foreground hover:bg-muted/50"
            )}
          >
            {level}
          </button>
        ))}
      </div>

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
        {filteredLines.length === 0 && lines.length > 0 && (
          <div className="text-muted-foreground italic text-[10px] py-2">
            No logs matching current filter
          </div>
        )}
        {filteredLines.map((line, idx) => {
          const { className } = colorizeLogLine(line);
          return (
            <div key={idx} className={cn(
              "whitespace-pre-wrap break-words px-1 -mx-1",
              className
            )}>
              {line}
            </div>
          );
        })}
      </div>
    </div>
  );
}
