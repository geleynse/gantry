import { describe, it, expect } from "bun:test";
import { parseRoutineDirective, hasRoutineDirective, isRoutineModeEnabled, dispatchRoutine } from "./routine-dispatch.js";
import { _resetRegistryForTest } from "./routine-runner.js";

// Ensure registry is populated for all tests
_resetRegistryForTest();

describe("routine-dispatch", () => {
  describe("parseRoutineDirective", () => {
    it("parses inline JSON", () => {
      const d = parseRoutineDirective('ROUTINE:sell_cycle {"station":"sol_station"}');
      expect(d).not.toBeNull();
      expect(d!.name).toBe("sell_cycle");
      expect(d!.params).toEqual({ station: "sol_station" });
    });

    it("parses multiline", () => {
      const text = `I'll sell cargo now.\nROUTINE:sell_cycle\n{"station":"sol_station"}`;
      const d = parseRoutineDirective(text);
      expect(d).not.toBeNull();
      expect(d!.name).toBe("sell_cycle");
      expect(d!.params).toEqual({ station: "sol_station" });
    });

    it("parses without params (known routine at start of string)", () => {
      const d = parseRoutineDirective("ROUTINE:sell_cycle");
      expect(d).not.toBeNull();
      expect(d!.name).toBe("sell_cycle");
      expect(d!.params).toEqual({});
    });

    it("returns null for no directive", () => {
      expect(parseRoutineDirective("just regular text")).toBeNull();
    });

    it("handles invalid JSON gracefully", () => {
      const d = parseRoutineDirective("ROUTINE:sell_cycle {bad json}");
      expect(d).not.toBeNull();
      expect(d!.name).toBe("sell_cycle");
      expect(d!.params).toEqual({});
    });

    // Injection guard tests
    it("rejects ROUTINE: mid-sentence (injection guard)", () => {
      expect(parseRoutineDirective("I might trigger ROUTINE:sell_cycle here")).toBeNull();
    });

    it("rejects unknown routine names (whitelist guard)", () => {
      expect(parseRoutineDirective("ROUTINE:evil_routine")).toBeNull();
      expect(parseRoutineDirective("ROUTINE:nonexistent_routine")).toBeNull();
    });

    it("accepts ROUTINE: at start of line after newline", () => {
      const text = `Thinking about this...\nROUTINE:sell_cycle {"station":"sol_station"}`;
      const d = parseRoutineDirective(text);
      expect(d).not.toBeNull();
      expect(d!.name).toBe("sell_cycle");
    });
  });

  describe("hasRoutineDirective", () => {
    it("detects directives at start of string", () => {
      expect(hasRoutineDirective("ROUTINE:sell_cycle {}")).toBe(true);
    });

    it("detects directives at start of line", () => {
      expect(hasRoutineDirective("some text\nROUTINE:sell_cycle {}")).toBe(true);
    });

    it("rejects plain text", () => {
      expect(hasRoutineDirective("no routine here")).toBe(false);
    });

    it("rejects ROUTINE: mid-sentence (injection guard)", () => {
      expect(hasRoutineDirective("I could call ROUTINE:sell_cycle to sell things")).toBe(false);
    });

    it("rejects unknown routine names (whitelist guard)", () => {
      expect(hasRoutineDirective("ROUTINE:evil_routine")).toBe(false);
    });
  });

  describe("isRoutineModeEnabled", () => {
    const config = {
      agents: [
        { name: "rust-vane", routineMode: true },
        { name: "sable-thorn", routineMode: false },
        { name: "drifter-gale" },
      ],
    };

    it("returns true when enabled", () => {
      expect(isRoutineModeEnabled("rust-vane", config)).toBe(true);
    });

    it("returns false when disabled", () => {
      expect(isRoutineModeEnabled("sable-thorn", config)).toBe(false);
    });

    it("returns false when not set", () => {
      expect(isRoutineModeEnabled("drifter-gale", config)).toBe(false);
    });

    it("returns false for unknown agent", () => {
      expect(isRoutineModeEnabled("unknown", config)).toBe(false);
    });

    it("returns false with no config", () => {
      expect(isRoutineModeEnabled("any", {} as any)).toBe(false);
    });
  });

  describe("dispatchRoutine pirate event handling", () => {
    function mockEventBuffer(events: string[]) {
      return {
        hasEventOfType(types: string[]) {
          return types.some(t => events.includes(t));
        },
      };
    }

    function mockClient() {
      let callCount = 0;
      return {
        execute: async (_tool: string, _args?: any) => {
          callCount++;
          return { result: { ok: true } };
        },
        waitForTick: async () => {},
        get callCount() { return callCount; },
      };
    }

    it("aborts on pirate_warning before first sub-tool call", async () => {
      const client = mockClient();
      const eventBuffers = new Map([["test-agent", mockEventBuffer(["pirate_warning"])]]);
      const { result } = await dispatchRoutine(
        { name: "refuel_repair", params: { station: "sol_station" } },
        {
          client: client as any,
          agentName: "test-agent",
          statusCache: new Map(),
          eventBuffers,
        },
      );
      // Routine aborts — either handoff with pirate reason, or error containing pirate message
      expect(result.status).not.toBe("completed");
      const haspirate = result.summary.includes("pirate") || result.handoffReason?.includes("pirate");
      expect(haspirate).toBe(true);
      expect(client.callCount).toBe(0); // no game calls made
    });

    it("aborts on pirate_combat before first sub-tool call", async () => {
      const client = mockClient();
      const eventBuffers = new Map([["test-agent", mockEventBuffer(["pirate_combat"])]]);
      const { result } = await dispatchRoutine(
        { name: "refuel_repair", params: { station: "sol_station" } },
        {
          client: client as any,
          agentName: "test-agent",
          statusCache: new Map(),
          eventBuffers,
        },
      );
      expect(result.status).not.toBe("completed");
      expect(client.callCount).toBe(0);
    });

    it("does not abort when no pirate events", async () => {
      const client = mockClient();
      const eventBuffers = new Map([["test-agent", mockEventBuffer([])]]);
      const { result } = await dispatchRoutine(
        { name: "refuel_repair", params: { station: "sol_station" } },
        {
          client: client as any,
          agentName: "test-agent",
          statusCache: new Map(),
          eventBuffers,
        },
      );
      // Should attempt execution — client gets called
      expect(client.callCount).toBeGreaterThan(0);
    });
  });
});
