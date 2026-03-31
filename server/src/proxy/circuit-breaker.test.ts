import { describe, it, expect, beforeEach, spyOn, setSystemTime } from "bun:test";
import { CircuitBreaker, BreakerRegistry, type CircuitState } from "./circuit-breaker.js";

describe("CircuitBreaker", () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker();
    spyOn(console, "log").mockImplementation(() => {});
    spyOn(console, "error").mockImplementation(() => {});
    setSystemTime(); // restore real time before each test
  });

  describe("initial state", () => {
    it("starts closed", () => {
      expect(breaker.getStatus().state).toBe("closed");
      expect(breaker.getStatus().failures).toBe(0);
    });

    it("allows connections when closed", () => {
      expect(breaker.allowConnection()).toBe(true);
    });

    it("getState returns 'closed'", () => {
      expect(breaker.getState()).toBe("closed");
    });
  });

  describe("closed → open transition", () => {
    it("stays closed below failure threshold", () => {
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getStatus().state).toBe("closed");
      expect(breaker.allowConnection()).toBe(true);
    });

    it("opens after 3 consecutive failures", () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getStatus().state).toBe("open");
      expect(breaker.allowConnection()).toBe(false);
    });

    it("rejects connections when open", () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.allowConnection()).toBe(false);
      expect(breaker.allowConnection()).toBe(false);
    });
  });

  describe("open → half-open transition", () => {
    it("transitions to half-open after cooldown expires", () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      // Simulate cooldown by advancing system time 60 seconds
      setSystemTime(new Date(Date.now() + 60_000));

      expect(breaker.allowConnection()).toBe(true); // probe allowed
      expect(breaker.getStatus().state).toBe("half-open");

      setSystemTime(); // restore
    });

    it("allows connections in half-open for probing", () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      setSystemTime(new Date(Date.now() + 60_000));

      expect(breaker.allowConnection()).toBe(true); // first probe
      expect(breaker.allowConnection()).toBe(true); // also allowed (probing mode)

      setSystemTime();
    });
  });

  describe("half-open → closed (success threshold)", () => {
    it("requires 2 successes to close from half-open", () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      setSystemTime(new Date(Date.now() + 60_000));
      breaker.allowConnection(); // transition to half-open

      breaker.recordSuccess();
      expect(breaker.getStatus().state).toBe("half-open"); // still half-open after 1

      breaker.recordSuccess();
      expect(breaker.getStatus().state).toBe("closed"); // closed after 2
      expect(breaker.getStatus().failures).toBe(0);

      setSystemTime();
    });

    it("resets consecutive successes on failure in half-open", () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      setSystemTime(new Date(Date.now() + 60_000));
      breaker.allowConnection();

      breaker.recordSuccess(); // 1 success
      breaker.recordFailure(); // back to open

      expect(breaker.getStatus().state).toBe("open");

      setSystemTime();
    });
  });

  describe("half-open → open (failure)", () => {
    it("reopens with fresh cooldown on probe failure", () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      setSystemTime(new Date(Date.now() + 60_000));
      breaker.allowConnection(); // half-open

      breaker.recordFailure(); // probe failed
      expect(breaker.getStatus().state).toBe("open");
      expect(breaker.allowConnection()).toBe(false); // fresh cooldown

      setSystemTime();
    });
  });

  describe("configurable thresholds", () => {
    it("respects custom failure threshold", () => {
      const custom = new CircuitBreaker({ failureThreshold: 5 });
      for (let i = 0; i < 4; i++) custom.recordFailure();
      expect(custom.getState()).toBe("closed");

      custom.recordFailure();
      expect(custom.getState()).toBe("open");
    });

    it("respects custom success threshold", () => {
      const custom = new CircuitBreaker({ successThreshold: 3 });
      spyOn(console, "log").mockImplementation(() => {});

      for (let i = 0; i < 3; i++) custom.recordFailure();
      setSystemTime(new Date(Date.now() + 60_000));
      custom.allowConnection();

      custom.recordSuccess();
      custom.recordSuccess();
      expect(custom.getState()).toBe("half-open"); // still half-open

      custom.recordSuccess();
      expect(custom.getState()).toBe("closed"); // closed after 3

      setSystemTime();
    });

    it("respects custom cooldown", () => {
      const custom = new CircuitBreaker({ cooldownMs: 5_000 });
      spyOn(console, "log").mockImplementation(() => {});

      for (let i = 0; i < 3; i++) custom.recordFailure();

      setSystemTime(new Date(Date.now() + 4_000));
      expect(custom.allowConnection()).toBe(false); // still cooling

      setSystemTime(new Date(Date.now() + 5_000));
      expect(custom.allowConnection()).toBe(true); // cooldown done

      setSystemTime();
    });
  });

  describe("state change listeners", () => {
    it("fires listener on state transition", () => {
      const transitions: Array<{ from: CircuitState; to: CircuitState }> = [];
      breaker.onStateChange((from, to) => transitions.push({ from, to }));

      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure(); // closed → open

      expect(transitions).toHaveLength(1);
      expect(transitions[0]).toEqual({ from: "closed", to: "open" });
    });

    it("fires on multiple transitions", () => {
      const transitions: Array<{ from: CircuitState; to: CircuitState }> = [];
      breaker.onStateChange((from, to) => transitions.push({ from, to }));

      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure(); // → open

      setSystemTime(new Date(Date.now() + 60_000));
      breaker.allowConnection(); // → half-open

      breaker.recordSuccess();
      breaker.recordSuccess(); // → closed

      expect(transitions).toHaveLength(3);
      expect(transitions.map((t) => t.to)).toEqual(["open", "half-open", "closed"]);

      setSystemTime();
    });

    it("handles listener errors gracefully", () => {
      breaker.onStateChange(() => { throw new Error("boom"); });

      // Should not throw
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState()).toBe("open");
    });
  });

  describe("getStatus", () => {
    it("includes cooldown_remaining_ms when open", () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();
      const status = breaker.getStatus();
      expect(status.cooldown_remaining_ms).toBeDefined();
      expect(status.cooldown_remaining_ms).toBeGreaterThan(0);
      expect(status.cooldown_remaining_ms).toBeLessThanOrEqual(60_000);
    });

    it("omits cooldown_remaining_ms when closed", () => {
      expect(breaker.getStatus().cooldown_remaining_ms).toBeUndefined();
    });

    it("omits cooldown_remaining_ms when half-open", () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      setSystemTime(new Date(Date.now() + 60_000));
      breaker.allowConnection(); // half-open

      expect(breaker.getStatus().state).toBe("half-open");
      expect(breaker.getStatus().cooldown_remaining_ms).toBeUndefined();

      setSystemTime();
    });

    it("tracks total transitions", () => {
      expect(breaker.getStatus().totalTransitions).toBe(0);
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getStatus().totalTransitions).toBe(1);
    });

    it("tracks lastStateChange time", () => {
      const before = Date.now();
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getStatus().lastStateChange).toBeGreaterThanOrEqual(before);
    });
  });

  describe("recordSuccess resets from any state", () => {
    it("resets failure count when called from closed state", () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordSuccess();
      expect(breaker.getStatus().failures).toBe(0);
      expect(breaker.getStatus().state).toBe("closed");
    });
  });
});

describe("BreakerRegistry", () => {
  let registry: BreakerRegistry;

  beforeEach(() => {
    registry = new BreakerRegistry();
    spyOn(console, "log").mockImplementation(() => {});
    spyOn(console, "error").mockImplementation(() => {});
    setSystemTime();
  });

  it("getOrCreate returns same instance for same key", () => {
    const a = registry.getOrCreate("agent-a");
    const b = registry.getOrCreate("agent-a");
    expect(a).toBe(b);
  });

  it("getOrCreate returns different instances for different keys", () => {
    const a = registry.getOrCreate("agent-a");
    const b = registry.getOrCreate("agent-b");
    expect(a).not.toBe(b);
  });

  it("register adds an external breaker", () => {
    const breaker = new CircuitBreaker();
    registry.register("custom", breaker);
    expect(registry.getAll().get("custom")).toBe(breaker);
  });

  it("remove cleans up a breaker", () => {
    registry.getOrCreate("agent-a");
    expect(registry.getAll().size).toBe(1);
    registry.remove("agent-a");
    expect(registry.getAll().size).toBe(0);
  });

  it("getAll returns all registered breakers", () => {
    registry.getOrCreate("a");
    registry.getOrCreate("b");
    registry.getOrCreate("c");
    expect(registry.getAll().size).toBe(3);
  });

  describe("getAggregateStatus", () => {
    it("returns closed when all breakers closed", () => {
      registry.getOrCreate("a");
      registry.getOrCreate("b");
      const agg = registry.getAggregateStatus();
      expect(agg.state).toBe("closed");
      expect(agg.failures).toBe(0);
    });

    it("returns open when any breaker is open", () => {
      const a = registry.getOrCreate("a");
      registry.getOrCreate("b");
      // Trip breaker a
      a.recordFailure();
      a.recordFailure();
      a.recordFailure();
      const agg = registry.getAggregateStatus();
      expect(agg.state).toBe("open");
      expect(agg.failures).toBe(3);
    });

    it("returns half-open when any breaker is half-open and none open", () => {
      const a = registry.getOrCreate("a");
      registry.getOrCreate("b");
      a.recordFailure();
      a.recordFailure();
      a.recordFailure();
      setSystemTime(new Date(Date.now() + 60_000));
      a.allowConnection(); // → half-open
      const agg = registry.getAggregateStatus();
      expect(agg.state).toBe("half-open");
      setSystemTime();
    });

    it("open beats half-open in aggregate", () => {
      const a = registry.getOrCreate("a");
      const b = registry.getOrCreate("b");
      // a → half-open
      a.recordFailure(); a.recordFailure(); a.recordFailure();
      setSystemTime(new Date(Date.now() + 60_000));
      a.allowConnection();
      // b → open (fresh)
      setSystemTime();
      b.recordFailure(); b.recordFailure(); b.recordFailure();
      const agg = registry.getAggregateStatus();
      expect(agg.state).toBe("open");
    });

    it("includes cooldown from open breakers", () => {
      const a = registry.getOrCreate("a");
      a.recordFailure(); a.recordFailure(); a.recordFailure();
      const agg = registry.getAggregateStatus();
      expect(agg.cooldown_remaining_ms).toBeDefined();
      expect(agg.cooldown_remaining_ms).toBeGreaterThan(0);
    });

    it("returns sensible defaults with no breakers", () => {
      const agg = registry.getAggregateStatus();
      expect(agg.state).toBe("closed");
      expect(agg.failures).toBe(0);
    });
  });

  describe("getPerAgentStatus", () => {
    it("returns per-agent breakdown", () => {
      const a = registry.getOrCreate("sable");
      const b = registry.getOrCreate("cinder");
      a.recordFailure();
      const result = registry.getPerAgentStatus();
      expect(result["sable"].failures).toBe(1);
      expect(result["cinder"].failures).toBe(0);
    });
  });
});
