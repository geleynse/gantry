import { describe, test, expect, beforeEach, afterEach } from "bun:test";

// Enable logs explicitly for this test suite
process.env.TEST_LOGS = "1";

import {
  LogLevel,
  createLogger,
  setLogLevel,
  getLogLevel,
  parseLogLevel,
  setDevelopmentMode,
} from "./logger";

describe("logger utility", () => {
  // Store original console methods to restore after tests
  let consoleLogOutput: string[] = [];
  let consoleErrorOutput: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  beforeEach(() => {
    // Reset to default log level
    setLogLevel(LogLevel.INFO);
    consoleLogOutput = [];
    consoleErrorOutput = [];

    // Mock console methods
    console.log = (...args: unknown[]) => {
      consoleLogOutput.push(args.join(" "));
    };
    console.error = (...args: unknown[]) => {
      consoleErrorOutput.push(args.join(" "));
    };
  });

  afterEach(() => {
    // Restore console methods
    console.log = originalLog;
    console.error = originalError;
  });

  describe("createLogger", () => {
    test("returns a valid Logger object", () => {
      const logger = createLogger("test");
      expect(typeof logger.debug).toBe("function");
      expect(typeof logger.info).toBe("function");
      expect(typeof logger.warn).toBe("function");
      expect(typeof logger.error).toBe("function");
    });

    test("includes category in output", () => {
      const logger = createLogger("auth");
      logger.info("test message");
      expect(consoleLogOutput[0]).toContain("[auth]");
    });

    test("includes message in output", () => {
      const logger = createLogger("test");
      logger.info("hello world");
      expect(consoleLogOutput[0]).toContain("hello world");
    });

    test("includes level name in output", () => {
      const logger = createLogger("test");
      logger.info("test");
      expect(consoleLogOutput[0]).toContain("[INFO]");
    });
  });

  describe("log levels - output", () => {
    test("debug logs to console.log", () => {
      setLogLevel(LogLevel.DEBUG);
      const logger = createLogger("test");
      logger.debug("debug message");
      expect(consoleLogOutput).toHaveLength(1);
      expect(consoleLogOutput[0]).toContain("[DEBUG]");
    });

    test("info logs to console.log", () => {
      const logger = createLogger("test");
      logger.info("info message");
      expect(consoleLogOutput).toHaveLength(1);
      expect(consoleLogOutput[0]).toContain("[INFO]");
    });

    test("warn logs to console.error", () => {
      const logger = createLogger("test");
      logger.warn("warn message");
      expect(consoleErrorOutput).toHaveLength(1);
      expect(consoleErrorOutput[0]).toContain("[WARN]");
      expect(consoleLogOutput).toHaveLength(0);
    });

    test("error logs to console.error", () => {
      const logger = createLogger("test");
      logger.error("error message");
      expect(consoleErrorOutput).toHaveLength(1);
      expect(consoleErrorOutput[0]).toContain("[ERROR]");
      expect(consoleLogOutput).toHaveLength(0);
    });
  });

  describe("log level filtering", () => {
    test("DEBUG level shows all logs", () => {
      setLogLevel(LogLevel.DEBUG);
      const logger = createLogger("test");
      logger.debug("debug");
      logger.info("info");
      logger.warn("warn");
      logger.error("error");
      expect(consoleLogOutput).toHaveLength(2); // debug, info
      expect(consoleErrorOutput).toHaveLength(2); // warn, error
    });

    test("INFO level hides DEBUG", () => {
      setLogLevel(LogLevel.INFO);
      const logger = createLogger("test");
      logger.debug("debug");
      logger.info("info");
      logger.warn("warn");
      logger.error("error");
      expect(consoleLogOutput).toHaveLength(1); // info only
      expect(consoleErrorOutput).toHaveLength(2); // warn, error
    });

    test("WARN level hides DEBUG and INFO", () => {
      setLogLevel(LogLevel.WARN);
      const logger = createLogger("test");
      logger.debug("debug");
      logger.info("info");
      logger.warn("warn");
      logger.error("error");
      expect(consoleLogOutput).toHaveLength(0);
      expect(consoleErrorOutput).toHaveLength(2); // warn, error
    });

    test("ERROR level hides DEBUG, INFO, and WARN", () => {
      setLogLevel(LogLevel.ERROR);
      const logger = createLogger("test");
      logger.debug("debug");
      logger.info("info");
      logger.warn("warn");
      logger.error("error");
      expect(consoleLogOutput).toHaveLength(0);
      expect(consoleErrorOutput).toHaveLength(1); // error only
    });
  });

  describe("log level management", () => {
    test("setLogLevel accepts LogLevel enum", () => {
      setLogLevel(LogLevel.DEBUG);
      expect(getLogLevel()).toBe(LogLevel.DEBUG);
    });

    test("setLogLevel accepts string (lowercase)", () => {
      setLogLevel("warn");
      expect(getLogLevel()).toBe(LogLevel.WARN);
    });

    test("setLogLevel accepts string (uppercase)", () => {
      setLogLevel("ERROR");
      expect(getLogLevel()).toBe(LogLevel.ERROR);
    });

    test("setLogLevel accepts string (mixed case)", () => {
      setLogLevel("InFo");
      expect(getLogLevel()).toBe(LogLevel.INFO);
    });

    test("getLogLevel returns current level", () => {
      setLogLevel(LogLevel.DEBUG);
      expect(getLogLevel()).toBe(LogLevel.DEBUG);
      setLogLevel(LogLevel.WARN);
      expect(getLogLevel()).toBe(LogLevel.WARN);
    });
  });

  describe("parseLogLevel", () => {
    test("parses 'DEBUG' string", () => {
      expect(parseLogLevel("DEBUG")).toBe(LogLevel.DEBUG);
    });

    test("parses 'INFO' string", () => {
      expect(parseLogLevel("INFO")).toBe(LogLevel.INFO);
    });

    test("parses 'WARN' string", () => {
      expect(parseLogLevel("WARN")).toBe(LogLevel.WARN);
    });

    test("parses 'ERROR' string", () => {
      expect(parseLogLevel("ERROR")).toBe(LogLevel.ERROR);
    });

    test("is case-insensitive", () => {
      expect(parseLogLevel("debug")).toBe(LogLevel.DEBUG);
      expect(parseLogLevel("Info")).toBe(LogLevel.INFO);
      expect(parseLogLevel("WARN")).toBe(LogLevel.WARN);
    });

    test("throws error for invalid level", () => {
      expect(() => parseLogLevel("INVALID")).toThrow();
      expect(() => parseLogLevel("TRACE")).toThrow();
      expect(() => parseLogLevel("")).toThrow();
    });

    test("error message is helpful", () => {
      try {
        parseLogLevel("INVALID");
        expect.unreachable();
      } catch (err) {
        const message = err instanceof Error ? err.message : "";
        expect(message).toContain("Invalid log level");
        expect(message).toContain("INVALID");
      }
    });
  });

  describe("development mode", () => {
    test("setDevelopmentMode(true) sets level to DEBUG", () => {
      setLogLevel(LogLevel.ERROR);
      setDevelopmentMode(true);
      expect(getLogLevel()).toBe(LogLevel.DEBUG);
    });

    test("setDevelopmentMode(false) resets to INFO", () => {
      setLogLevel(LogLevel.WARN);
      setDevelopmentMode(false);
      expect(getLogLevel()).toBe(LogLevel.INFO);
    });
  });

  describe("data formatting", () => {
    test("logs without data", () => {
      const logger = createLogger("test");
      logger.info("message");
      expect(consoleLogOutput[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z\] \[INFO\] \[test\] message$/);
    });

    test("logs with simple string values", () => {
      const logger = createLogger("test");
      logger.info("message", { key: "value" });
      expect(consoleLogOutput[0]).toContain("[INFO] [test] message");
      expect(consoleLogOutput[0]).toContain("key: value");
    });

    test("logs with number values", () => {
      const logger = createLogger("test");
      logger.info("message", { count: 42 });
      expect(consoleLogOutput[0]).toContain("count: 42");
    });

    test("logs with boolean values", () => {
      const logger = createLogger("test");
      logger.info("message", { active: true });
      expect(consoleLogOutput[0]).toContain("active: true");
    });

    test("logs with multiple data fields", () => {
      const logger = createLogger("test");
      logger.info("message", { agent: "sable-thorn", sessionId: "8f9c" });
      expect(consoleLogOutput[0]).toContain("agent: sable-thorn");
      expect(consoleLogOutput[0]).toContain("sessionId: 8f9c");
    });

    test("logs with complex objects", () => {
      const logger = createLogger("test");
      logger.info("message", { details: { nested: "value" } });
      expect(consoleLogOutput[0]).toContain("details:");
    });

    test("ignores empty data object", () => {
      const logger = createLogger("test");
      logger.info("message", {});
      expect(consoleLogOutput[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z\] \[INFO\] \[test\] message$/);
    });

    test("quotes values with spaces", () => {
      const logger = createLogger("test");
      logger.info("message", { reason: "connection timeout" });
      expect(consoleLogOutput[0]).toContain('"connection timeout"');
    });
  });

  describe("multiple logger instances", () => {
    test("different categories show independently", () => {
      const authLogger = createLogger("auth");
      const gameLogger = createLogger("game-client");
      authLogger.info("login success");
      gameLogger.warn("connection failed");
      expect(consoleLogOutput[0]).toContain("[auth]");
      expect(consoleErrorOutput[0]).toContain("[game-client]");
    });

    test("all instances respect global log level", () => {
      setLogLevel(LogLevel.ERROR);
      const logger1 = createLogger("module1");
      const logger2 = createLogger("module2");
      logger1.info("should hide");
      logger2.error("should show");
      expect(consoleLogOutput).toHaveLength(0);
      expect(consoleErrorOutput).toHaveLength(1);
    });
  });

  describe("output format", () => {
    test("follows expected format [LEVEL] [category] message", () => {
      const logger = createLogger("schema");
      logger.warn("drift detected");
      expect(consoleErrorOutput[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z\] \[WARN\] \[schema\] drift detected$/);
    });

    test("format with data includes pipe separator", () => {
      setLogLevel(LogLevel.DEBUG);
      const logger = createLogger("cache");
      logger.debug("hit", { age: "45ms" });
      expect(consoleLogOutput[0]).toContain(" | ");
    });
  });
});
