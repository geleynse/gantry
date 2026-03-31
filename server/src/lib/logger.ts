/**
 * Lightweight logger utility with log level filtering.
 * Zero external dependencies, human-readable output format.
 */

import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

// Global logger state
let currentLogLevel: LogLevel = LogLevel.INFO;

/**
 * Parse a string log level (case-insensitive).
 * @throws Error if the string is not a valid log level
 */
export function parseLogLevel(str: string): LogLevel {
  const upper = str.toUpperCase();
  if (upper === "DEBUG") return LogLevel.DEBUG;
  if (upper === "INFO") return LogLevel.INFO;
  if (upper === "WARN") return LogLevel.WARN;
  if (upper === "ERROR") return LogLevel.ERROR;
  throw new Error(`Invalid log level: "${str}". Valid levels: DEBUG, INFO, WARN, ERROR`);
}

/**
 * Set the global log level.
 * @param level LogLevel enum value or string ("DEBUG", "INFO", "WARN", "ERROR")
 */
export function setLogLevel(level: LogLevel | string): void {
  if (typeof level === "string") {
    currentLogLevel = parseLogLevel(level);
  } else {
    currentLogLevel = level;
  }
}

/**
 * Get the current global log level.
 */
export function getLogLevel(): LogLevel {
  return currentLogLevel;
}

/**
 * Enable development mode (sets log level to DEBUG).
 */
export function setDevelopmentMode(enabled: boolean): void {
  currentLogLevel = enabled ? LogLevel.DEBUG : LogLevel.INFO;
}

/**
 * Format data object as a string.
 * Returns empty string if data is undefined or empty.
 */
function formatData(data?: Record<string, unknown>): string {
  if (!data) return "";
  const entries = Object.entries(data);
  if (entries.length === 0) return "";
  const pairs = entries.map(([key, value]) => {
    if (typeof value === "string" && !value.includes(" ")) {
      return `${key}: ${value}`;
    }
    return `${key}: ${JSON.stringify(value)}`;
  });
  return " | " + pairs.join(", ");
}

/**
 * Create a logger instance for a given category.
 */
export function createLogger(category: string): Logger {
  const log = (level: LogLevel, message: string, data?: Record<string, unknown>) => {
    // Check if this log level should be output
    if (level < currentLogLevel) {
      return;
    }

    const levelName = LogLevel[level] ?? "UNKNOWN";
    const dataStr = formatData(data);
    const timestamp = new Date().toISOString();
    const output = `[${timestamp}] [${levelName}] [${category}] ${message}${dataStr}`;

    // Suppress console output during tests to prevent polluting the test runner / CI logs,
    // unless explicitly enabled via TEST_LOGS=1
    if (process.env.NODE_ENV !== "test" || process.env.TEST_LOGS === "1") {
      // Use console.error for WARN and ERROR, console.log for INFO and DEBUG
      if (level >= LogLevel.WARN) {
        console.error(output);
      } else {
        console.log(output);
      }
    }

    // Also write to file if file logging is enabled
    writeToFile(output);
  };

  return {
    debug: (message, data) => log(LogLevel.DEBUG, message, data),
    info: (message, data) => log(LogLevel.INFO, message, data),
    warn: (message, data) => log(LogLevel.WARN, message, data),
    error: (message, data) => log(LogLevel.ERROR, message, data),
  };
}

// Initialize log level from environment variable on module load
const envLogLevel = process.env.LOG_LEVEL;
if (envLogLevel) {
  try {
    setLogLevel(envLogLevel);
  } catch (err) {
    console.warn(
      `Invalid LOG_LEVEL environment variable: ${envLogLevel}, using default INFO`
    );
  }
}

// Optional file logging
/**
 * Contained singleton for the log file write stream.
 * This is acceptable as a module-private singleton because it is not shared
 * mutable state that affects business logic, and only one log file is
 * active for the entire server process.
 */
let logFileStream: WriteStream | null = null;

/**
 * Enable logging to a file in addition to console.
 * Used by the server to capture logs for the web UI.
 */
export async function enableFileLogging(filePath: string): Promise<void> {
  try {
    // Ensure the directory exists
    await mkdir(dirname(filePath), { recursive: true });
    // Create write stream
    logFileStream = createWriteStream(filePath, { flags: "a" });
  } catch (err) {
    console.error("Failed to open log file:", err);
  }
}

/**
 * Write a formatted log line to file if file logging is enabled.
 */
function writeToFile(message: string): void {
  if (logFileStream) {
    logFileStream.write(message + "\n");
  }
}
