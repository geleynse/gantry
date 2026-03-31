import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createDatabase, closeDb } from "./database.js";
import { logEnrollmentEvent, getAuditLog } from "./enrollment-audit.js";

describe("enrollment-audit", () => {
  beforeEach(() => {
    createDatabase(":memory:");
  });

  afterEach(() => {
    closeDb();
  });

  it("stores and retrieves enrollment events", () => {
    logEnrollmentEvent("test-agent", "enrolled", "admin", { foo: "bar" });
    
    const logs = getAuditLog("test-agent");
    expect(logs).toHaveLength(1);
    expect(logs[0].agent_name).toBe("test-agent");
    expect(logs[0].action).toBe("enrolled");
    expect(logs[0].actor).toBe("admin");
    expect(JSON.parse(logs[0].details!)).toEqual({ foo: "bar" });
  });

  it("filters audit log by agent", () => {
    logEnrollmentEvent("agent-1", "enrolled");
    logEnrollmentEvent("agent-2", "enrolled");
    
    expect(getAuditLog("agent-1")).toHaveLength(1);
    expect(getAuditLog("agent-2")).toHaveLength(1);
    expect(getAuditLog()).toHaveLength(2);
  });

  it("limits audit log results", () => {
    for (let i = 0; i < 10; i++) {
      logEnrollmentEvent("agent", "enrolled");
    }
    
    expect(getAuditLog(undefined, 5)).toHaveLength(5);
  });
});
