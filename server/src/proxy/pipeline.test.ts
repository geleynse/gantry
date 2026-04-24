/**
 * Tests for shared proxy pipeline functions (pipeline.ts).
 *
 * Uses in-memory Maps and simple mock configs — no database or network access.
 * The serverMetrics singleton starts healthy (no errors recorded), so instability
 * checks pass through by default in all guardrail tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  getAgentForSession,
  getTracker,
  resetTracker,
  getAgentFormat,
  callSignatureV1,
  callSignatureV2,
  decontaminateLog,
  validateCaptainsLogFormat,
  countSentenceBoundaries,
  checkGuardrailsV1,
  checkGuardrailsV2,
  withInjections,
  isProxySessionActive,
  type PipelineContext,
  type FleetOrder,
  type BattleState,
} from "./pipeline.js";
import { isCombatAgent, shouldAutoTriggerCombat, shouldAutoFlee, getAutoTriggerAction } from "./combat-auto-trigger.js";
import type { AgentCallTracker } from "./server.js";
import { EventBuffer } from "./event-buffer.js";
import type { GantryConfig } from "../config.js";
import { createDatabase, closeDb } from "../services/database.js";
import { MetricsWindow } from "./instability-metrics.js";
import { InjectionRegistry, createDefaultInjections } from "./injection-registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Mock SessionStore for testing
class MockSessionStore {
  private validSessions: Set<string> = new Set();
  private iterations: Map<string, number> = new Map();
  private turnStartedAt: Map<string, string> = new Map();

  createSession(id: string): void {
    this.validSessions.add(id);
    this.iterations.set(id, 0);
    this.turnStartedAt.set(id, new Date().toISOString());
  }

  expireSession(id: string): void {
    this.validSessions.delete(id);
  }

  isValidSession(id: string): boolean {
    return this.validSessions.has(id);
  }

  incrementIterationCount(id: string): number {
    const count = (this.iterations.get(id) ?? 0) + 1;
    this.iterations.set(id, count);
    return count;
  }

  getTurnStartedAt(id: string): string | null {
    return this.turnStartedAt.get(id) ?? null;
  }

  getSession(id: string): any {
    if (!this.isValidSession(id)) return null;
    return {
      id,
      lastSeenAt: new Date().toISOString(),
      agent: "test-agent"
    };
  }

  expireAgentSessions(agent: string): void {
    this.validSessions.clear(); // Simple mock behavior
  }
}

function makeConfig(overrides: Partial<GantryConfig> = {}): GantryConfig {
  return {
    agents: [
      { name: "alpha", toolResultFormat: "yaml" },
      { name: "bravo" }, // no toolResultFormat — defaults to json
    ],
    gameUrl: "http://localhost:9999",
    gameApiUrl: "http://localhost:9999/api",
    gameMcpUrl: "http://localhost:9999",
    agentDeniedTools: {},
    callLimits: {},
    turnSleepMs: 0,
    staggerDelay: 0,
    ...overrides,
  };
}

function makeDefaultRegistry(): InjectionRegistry {
  const registry = new InjectionRegistry();
  for (const injection of createDefaultInjections()) {
    registry.register(injection);
  }
  return registry;
}

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const injectionRegistry = overrides.injectionRegistry ?? makeDefaultRegistry();
  return {
    config: makeConfig(),
    sessionAgentMap: new Map(),
    callTrackers: new Map(),
    eventBuffers: new Map(),
    battleCache: new Map(),
    callLimits: {},
    serverMetrics: new MetricsWindow(),
    getFleetPendingOrders: () => [],
    markOrderDelivered: () => {},
    reformatResponse: (text) => text, // identity — tests check structure not format
    ...overrides,
    injectionRegistry, // always set (overrides.injectionRegistry ?? default)
  };
}

function makeResponse(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

// ---------------------------------------------------------------------------
// isCombatAgent
// ---------------------------------------------------------------------------

describe("isCombatAgent", () => {
  it("returns true for agents with 'combat' in their role", () => {
    const config = makeConfig({
      agents: [
        { name: "combat-agent", role: "Combat/Mining" },
        { name: "pure-combat", role: "Combat" },
        { name: "combat-specialist", role: "combat" }, // lowercase
      ],
    });
    expect(isCombatAgent(config, "combat-agent")).toBe(true);
    expect(isCombatAgent(config, "pure-combat")).toBe(true);
    expect(isCombatAgent(config, "combat-specialist")).toBe(true);
  });

  it("returns false for agents without 'combat' in their role", () => {
    const config = makeConfig({
      agents: [
        { name: "explorer", role: "Explorer/Mining" },
        { name: "trader", role: "Trader" },
      ],
    });
    expect(isCombatAgent(config, "explorer")).toBe(false);
    expect(isCombatAgent(config, "trader")).toBe(false);
  });

  it("returns false for agents with no role", () => {
    const config = makeConfig({
      agents: [{ name: "no-role" }],
    });
    expect(isCombatAgent(config, "no-role")).toBe(false);
  });

  it("returns false for unknown agents", () => {
    const config = makeConfig();
    expect(isCombatAgent(config, "unknown")).toBe(false);
  });

  it("is case-insensitive for role matching", () => {
    const config = makeConfig({
      agents: [
        { name: "mixed-case", role: "COMBAT/Mining" },
      ],
    });
    expect(isCombatAgent(config, "mixed-case")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// shouldAutoTriggerCombat
// ---------------------------------------------------------------------------

describe("shouldAutoTriggerCombat", () => {
  it("returns false when agent is combat-role and has pirate_combat event (NPC auto-combat, not PvP)", () => {
    const config = makeConfig({
      agents: [{ name: "sable-thorn", role: "Combat/Mining" }],
    });
    const buffer = new EventBuffer();
    buffer.push({
      type: "pirate_combat",
      payload: { zone: "mid", enemies: 2 },
      receivedAt: Date.now(),
    });
    const ctx = makeCtx({
      config,
      eventBuffers: new Map([["sable-thorn", buffer]]),
    });

    expect(shouldAutoTriggerCombat(ctx.config, ctx.eventBuffers, "sable-thorn")).toBe(false);
  });

  it("returns false when agent is not combat-role", () => {
    const config = makeConfig({
      agents: [{ name: "explorer", role: "Explorer/Mining" }],
    });
    const buffer = new EventBuffer();
    buffer.push({
      type: "pirate_combat",
      payload: { zone: "mid", enemies: 2 },
      receivedAt: Date.now(),
    });
    const ctx = makeCtx({
      config,
      eventBuffers: new Map([["explorer", buffer]]),
    });

    expect(shouldAutoTriggerCombat(ctx.config, ctx.eventBuffers, "explorer")).toBe(false);
  });

  it("returns false when combat-role agent has no events", () => {
    const config = makeConfig({
      agents: [{ name: "sable-thorn", role: "Combat/Mining" }],
    });
    const ctx = makeCtx({
      config,
      eventBuffers: new Map([["sable-thorn", new EventBuffer()]]),
    });

    expect(shouldAutoTriggerCombat(ctx.config, ctx.eventBuffers, "sable-thorn")).toBe(false);
  });

  it("returns false when combat-role agent has events but no pirate_combat", () => {
    const config = makeConfig({
      agents: [{ name: "sable-thorn", role: "Combat/Mining" }],
    });
    const buffer = new EventBuffer();
    buffer.push({
      type: "player_died",
      payload: { respawn_available: true },
      receivedAt: Date.now(),
    });
    const ctx = makeCtx({
      config,
      eventBuffers: new Map([["sable-thorn", buffer]]),
    });

    expect(shouldAutoTriggerCombat(ctx.config, ctx.eventBuffers, "sable-thorn")).toBe(false);
  });

  it("returns false when agent has no event buffer", () => {
    const config = makeConfig({
      agents: [{ name: "sable-thorn", role: "Combat/Mining" }],
    });
    const ctx = makeCtx({
      config,
      eventBuffers: new Map(), // empty
    });

    expect(shouldAutoTriggerCombat(ctx.config, ctx.eventBuffers, "sable-thorn")).toBe(false);
  });

  it("does not drain the pirate_combat event (leaves it for later injection)", () => {
    const config = makeConfig({
      agents: [{ name: "sable-thorn", role: "Combat/Mining" }],
    });
    const buffer = new EventBuffer();
    buffer.push({
      type: "pirate_combat",
      payload: { zone: "mid", enemies: 2 },
      receivedAt: Date.now(),
    });
    const ctx = makeCtx({
      config,
      eventBuffers: new Map([["sable-thorn", buffer]]),
    });

    shouldAutoTriggerCombat(ctx.config, ctx.eventBuffers, "sable-thorn");
    // Event should still be in buffer (not drained)
    const remaining = buffer.drain(["pirate_combat"]);
    expect(remaining.length).toBe(1);
    expect(remaining[0].type).toBe("pirate_combat");
  });

  it("returns true when agent is combat-role and has player_combat event", () => {
    const config = makeConfig({
      agents: [{ name: "sable-thorn", role: "Combat/Mining" }],
    });
    const buffer = new EventBuffer();
    buffer.push({
      type: "player_combat",
      payload: { zone: "mid", enemies: 1 },
      receivedAt: Date.now(),
    });
    const ctx = makeCtx({
      config,
      eventBuffers: new Map([["sable-thorn", buffer]]),
    });

    expect(shouldAutoTriggerCombat(ctx.config, ctx.eventBuffers, "sable-thorn")).toBe(true);
  });

  it("returns false when agent is not combat-role with player_combat event", () => {
    const config = makeConfig({
      agents: [{ name: "explorer", role: "Explorer/Mining" }],
    });
    const buffer = new EventBuffer();
    buffer.push({
      type: "player_combat",
      payload: { zone: "mid", enemies: 1 },
      receivedAt: Date.now(),
    });
    const ctx = makeCtx({
      config,
      eventBuffers: new Map([["explorer", buffer]]),
    });

    expect(shouldAutoTriggerCombat(ctx.config, ctx.eventBuffers, "explorer")).toBe(false);
  });

  it("returns false when combat-role agent has pirate_warning event (NPC pre-combat notice, no action)", () => {
    const config = makeConfig({
      agents: [{ name: "sable-thorn", role: "Combat/Mining" }],
    });
    const buffer = new EventBuffer();
    buffer.push({
      type: "pirate_warning",
      payload: { delay_ticks: 2, is_boss: false, message: "Enforcer incoming", pirate_id: "p1", pirate_name: "Enforcer", pirate_tier: "tier2" },
      receivedAt: Date.now(),
    });
    const ctx = makeCtx({
      config,
      eventBuffers: new Map([["sable-thorn", buffer]]),
    });

    expect(shouldAutoTriggerCombat(ctx.config, ctx.eventBuffers, "sable-thorn")).toBe(false);
  });

  it("returns false when non-combat agent has pirate_warning event (will flee instead)", () => {
    const config = makeConfig({
      agents: [{ name: "explorer", role: "Explorer/Mining" }],
    });
    const buffer = new EventBuffer();
    buffer.push({
      type: "pirate_warning",
      payload: { delay_ticks: 1, is_boss: false, message: "Enforcer incoming", pirate_id: "p1", pirate_name: "Enforcer", pirate_tier: "tier2" },
      receivedAt: Date.now(),
    });
    const ctx = makeCtx({
      config,
      eventBuffers: new Map([["explorer", buffer]]),
    });

    expect(shouldAutoTriggerCombat(ctx.config, ctx.eventBuffers, "explorer")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldAutoFlee
// ---------------------------------------------------------------------------

describe("shouldAutoFlee", () => {
  it("returns true for non-combat agent with pirate_combat event", () => {
    const config = makeConfig({
      agents: [{ name: "trader", role: "Trader/Mining" }],
    });
    const buffer = new EventBuffer();
    buffer.push({
      type: "pirate_combat",
      payload: { zone: "mid", enemies: 1 },
      receivedAt: Date.now(),
    });
    const ctx = makeCtx({
      config,
      eventBuffers: new Map([["trader", buffer]]),
    });
    expect(shouldAutoFlee(ctx.config, ctx.eventBuffers, "trader")).toBe(true);
  });

  it("returns false for combat agent (uses scan_and_attack instead)", () => {
    const config = makeConfig({
      agents: [{ name: "sable-thorn", role: "Combat/Mining" }],
    });
    const buffer = new EventBuffer();
    buffer.push({
      type: "pirate_combat",
      payload: { zone: "mid", enemies: 1 },
      receivedAt: Date.now(),
    });
    const ctx = makeCtx({
      config,
      eventBuffers: new Map([["sable-thorn", buffer]]),
    });
    expect(shouldAutoFlee(ctx.config, ctx.eventBuffers, "sable-thorn")).toBe(false);
  });

  it("returns false for non-combat agent with no pirate_combat event", () => {
    const config = makeConfig({
      agents: [{ name: "trader", role: "Trader/Mining" }],
    });
    const ctx = makeCtx({
      config,
      eventBuffers: new Map([["trader", new EventBuffer()]]),
    });
    expect(shouldAutoFlee(ctx.config, ctx.eventBuffers, "trader")).toBe(false);
  });

  it("returns false when agent has no event buffer", () => {
    const config = makeConfig({
      agents: [{ name: "explorer", role: "Explorer" }],
    });
    const ctx = makeCtx({ config, eventBuffers: new Map() });
    expect(shouldAutoFlee(ctx.config, ctx.eventBuffers, "explorer")).toBe(false);
  });

  it("returns true for non-combat agent with player_combat event", () => {
    const config = makeConfig({
      agents: [{ name: "trader", role: "Trader/Mining" }],
    });
    const buffer = new EventBuffer();
    buffer.push({
      type: "player_combat",
      payload: { zone: "mid", enemies: 1 },
      receivedAt: Date.now(),
    });
    const ctx = makeCtx({
      config,
      eventBuffers: new Map([["trader", buffer]]),
    });
    expect(shouldAutoFlee(ctx.config, ctx.eventBuffers, "trader")).toBe(true);
  });

  it("returns false for combat agent with player_combat (uses scan_and_attack instead)", () => {
    const config = makeConfig({
      agents: [{ name: "sable-thorn", role: "Combat/Mining" }],
    });
    const buffer = new EventBuffer();
    buffer.push({
      type: "player_combat",
      payload: { zone: "mid", enemies: 1 },
      receivedAt: Date.now(),
    });
    const ctx = makeCtx({
      config,
      eventBuffers: new Map([["sable-thorn", buffer]]),
    });
    expect(shouldAutoFlee(ctx.config, ctx.eventBuffers, "sable-thorn")).toBe(false);
  });

  it("returns false for non-combat agent with pirate_warning (warning only, wait for pirate_combat)", () => {
    const config = makeConfig({
      agents: [{ name: "trader", role: "Trader/Mining" }],
    });
    const buffer = new EventBuffer();
    buffer.push({
      type: "pirate_warning",
      payload: { delay_ticks: 2, is_boss: false, message: "Enforcer incoming", pirate_id: "p1", pirate_name: "Enforcer", pirate_tier: "tier2" },
      receivedAt: Date.now(),
    });
    const ctx = makeCtx({
      config,
      eventBuffers: new Map([["trader", buffer]]),
    });
    expect(shouldAutoFlee(ctx.config, ctx.eventBuffers, "trader")).toBe(false);
  });

  it("returns false for combat agent with pirate_warning (uses scan_and_attack instead)", () => {
    const config = makeConfig({
      agents: [{ name: "sable-thorn", role: "Combat/Mining" }],
    });
    const buffer = new EventBuffer();
    buffer.push({
      type: "pirate_warning",
      payload: { delay_ticks: 1, is_boss: false, message: "Enforcer incoming", pirate_id: "p1", pirate_name: "Enforcer", pirate_tier: "tier2" },
      receivedAt: Date.now(),
    });
    const ctx = makeCtx({
      config,
      eventBuffers: new Map([["sable-thorn", buffer]]),
    });
    expect(shouldAutoFlee(ctx.config, ctx.eventBuffers, "sable-thorn")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getAutoTriggerAction
// ---------------------------------------------------------------------------

describe("getAutoTriggerAction", () => {
  it("returns 'scan_and_attack' when auto-trigger is triggered", () => {
    const config = makeConfig({
      agents: [{ name: "sable-thorn", role: "Combat/Mining" }],
    });
    const buffer = new EventBuffer();
    buffer.push({
      type: "player_combat",
      payload: { zone: "mid", enemies: 2 },
      receivedAt: Date.now(),
    });
    const ctx = makeCtx({
      config,
      eventBuffers: new Map([["sable-thorn", buffer]]),
    });

    expect(getAutoTriggerAction(ctx.config, ctx.eventBuffers, "sable-thorn", "jump_route")).toBe("scan_and_attack");
    expect(getAutoTriggerAction(ctx.config, ctx.eventBuffers, "sable-thorn", "travel_to")).toBe("scan_and_attack");
    expect(getAutoTriggerAction(ctx.config, ctx.eventBuffers, "sable-thorn", "multi_sell")).toBe("scan_and_attack");
  });

  it("returns original action when auto-trigger is not triggered", () => {
    const config = makeConfig({
      agents: [{ name: "explorer", role: "Explorer/Mining" }],
    });
    const ctx = makeCtx({
      config,
      eventBuffers: new Map([["explorer", new EventBuffer()]]),
    });

    expect(getAutoTriggerAction(ctx.config, ctx.eventBuffers, "explorer", "jump_route")).toBe("jump_route");
    expect(getAutoTriggerAction(ctx.config, ctx.eventBuffers, "explorer", "travel_to")).toBe("travel_to");
  });

  it("returns 'flee' for non-combat agents with pirate_combat event", () => {
    const config = makeConfig({
      agents: [{ name: "trader", role: "Trader/Mining" }],
    });
    const buffer = new EventBuffer();
    buffer.push({
      type: "pirate_combat",
      payload: { zone: "mid", enemies: 2 },
      receivedAt: Date.now(),
    });
    const ctx = makeCtx({
      config,
      eventBuffers: new Map([["trader", buffer]]),
    });

    expect(getAutoTriggerAction(ctx.config, ctx.eventBuffers, "trader", "jump_route")).toBe("flee");
    expect(getAutoTriggerAction(ctx.config, ctx.eventBuffers, "trader", "travel_to")).toBe("flee");
    expect(getAutoTriggerAction(ctx.config, ctx.eventBuffers, "trader", "batch_mine")).toBe("flee");
  });

  it("returns original action for non-combat agents with no pirate_combat event", () => {
    const config = makeConfig({
      agents: [{ name: "trader", role: "Trader/Mining" }],
    });
    const ctx = makeCtx({
      config,
      eventBuffers: new Map([["trader", new EventBuffer()]]),
    });

    expect(getAutoTriggerAction(ctx.config, ctx.eventBuffers, "trader", "jump_route")).toBe("jump_route");
  });

  it("handles rapid consecutive checks without side effects (player_combat triggers scan_and_attack)", () => {
    const config = makeConfig({
      agents: [{ name: "sable-thorn", role: "Combat/Mining" }],
    });
    const buffer = new EventBuffer();
    buffer.push({
      type: "player_combat", // PvP event — triggers scan_and_attack for combat agents
      payload: { zone: "mid", enemies: 2 },
      receivedAt: Date.now(),
    });
    const ctx = makeCtx({
      config,
      eventBuffers: new Map([["sable-thorn", buffer]]),
    });

    // Multiple checks should all return scan_and_attack (event not drained)
    expect(getAutoTriggerAction(ctx.config, ctx.eventBuffers, "sable-thorn", "jump_route")).toBe("scan_and_attack");
    expect(getAutoTriggerAction(ctx.config, ctx.eventBuffers, "sable-thorn", "travel_to")).toBe("scan_and_attack");
    expect(getAutoTriggerAction(ctx.config, ctx.eventBuffers, "sable-thorn", "batch_mine")).toBe("scan_and_attack");
  });

  it("returns 'scan_and_attack' for combat agents with player_combat event", () => {
    const config = makeConfig({
      agents: [{ name: "sable-thorn", role: "Combat/Mining" }],
    });
    const buffer = new EventBuffer();
    buffer.push({
      type: "player_combat",
      payload: { zone: "mid", enemies: 1 },
      receivedAt: Date.now(),
    });
    const ctx = makeCtx({
      config,
      eventBuffers: new Map([["sable-thorn", buffer]]),
    });

    expect(getAutoTriggerAction(ctx.config, ctx.eventBuffers, "sable-thorn", "jump_route")).toBe("scan_and_attack");
    expect(getAutoTriggerAction(ctx.config, ctx.eventBuffers, "sable-thorn", "travel_to")).toBe("scan_and_attack");
  });

  it("returns 'flee' for non-combat agents with player_combat event", () => {
    const config = makeConfig({
      agents: [{ name: "trader", role: "Trader/Mining" }],
    });
    const buffer = new EventBuffer();
    buffer.push({
      type: "player_combat",
      payload: { zone: "mid", enemies: 1 },
      receivedAt: Date.now(),
    });
    const ctx = makeCtx({
      config,
      eventBuffers: new Map([["trader", buffer]]),
    });

    expect(getAutoTriggerAction(ctx.config, ctx.eventBuffers, "trader", "jump_route")).toBe("flee");
    expect(getAutoTriggerAction(ctx.config, ctx.eventBuffers, "trader", "travel_to")).toBe("flee");
  });
});

// ---------------------------------------------------------------------------
// getAutoTriggerAction
// ---------------------------------------------------------------------------

describe("getAutoTriggerAction", () => {
  it("returns original action for combat agent with pirate_combat (NPC auto-combat, not PvP)", () => {
    const config = makeConfig({
      agents: [{ name: "sable-thorn", role: "Combat/Mining" }],
    });
    const buffer = new EventBuffer();
    buffer.push({
      type: "pirate_combat",
      payload: { zone: "mid", enemies: 2 },
      receivedAt: Date.now(),
    });
    const eventBuffers = new Map([["sable-thorn", buffer]]);

    expect(getAutoTriggerAction(config, eventBuffers, "sable-thorn", "jump_route")).toBe("jump_route");
  });

  it("returns 'flee' for non-combat agent with pirate_combat", () => {
    const config = makeConfig({
      agents: [{ name: "trader", role: "Trader/Mining" }],
    });
    const buffer = new EventBuffer();
    buffer.push({
      type: "pirate_combat",
      payload: { zone: "mid", enemies: 1 },
      receivedAt: Date.now(),
    });
    const eventBuffers = new Map([["trader", buffer]]);

    expect(getAutoTriggerAction(config, eventBuffers, "trader", "jump_route")).toBe("flee");
  });

  it("returns 'scan_and_attack' for combat agent with player_combat", () => {
    const config = makeConfig({
      agents: [{ name: "sable-thorn", role: "Combat/Mining" }],
    });
    const buffer = new EventBuffer();
    buffer.push({
      type: "player_combat",
      payload: { zone: "mid", enemies: 1 },
      receivedAt: Date.now(),
    });
    const eventBuffers = new Map([["sable-thorn", buffer]]);

    expect(getAutoTriggerAction(config, eventBuffers, "sable-thorn", "jump_route")).toBe("scan_and_attack");
  });

  it("returns 'flee' for non-combat agent with player_combat", () => {
    const config = makeConfig({
      agents: [{ name: "trader", role: "Trader/Mining" }],
    });
    const buffer = new EventBuffer();
    buffer.push({
      type: "player_combat",
      payload: { zone: "mid", enemies: 1 },
      receivedAt: Date.now(),
    });
    const eventBuffers = new Map([["trader", buffer]]);

    expect(getAutoTriggerAction(config, eventBuffers, "trader", "jump_route")).toBe("flee");
  });

  it("returns 'flee' for non-combat agent with pirate_combat and low hull (<50%)", () => {
    const config = makeConfig({
      agents: [{ name: "trader", role: "Trader/Mining" }],
    });
    const buffer = new EventBuffer();
    buffer.push({
      type: "pirate_combat",
      payload: { zone: "mid", enemies: 1 },
      receivedAt: Date.now(),
    });
    const eventBuffers = new Map([["trader", buffer]]);

    // Status cache with low hull (40%)
    const statusCache = new Map([
      ["trader", { 
        data: { ship: { hull: 40, max_hull: 100 } },
        fetchedAt: Date.now()
      }]
    ]);

    expect(getAutoTriggerAction(config, eventBuffers, "trader", "jump_route", 40)).toBe("flee");
  });

  it("returns original action for non-combat agent with pirate_combat but healthy hull (>=50%)", () => {
    const config = makeConfig({
      agents: [{ name: "trader", role: "Trader/Mining" }],
    });
    const buffer = new EventBuffer();
    buffer.push({
      type: "pirate_combat",
      payload: { zone: "mid", enemies: 1 },
      receivedAt: Date.now(),
    });
    const eventBuffers = new Map([["trader", buffer]]);

    // Status cache with healthy hull (60%)
    const statusCache = new Map([
      ["trader", { 
        data: { ship: { hull: 60, max_hull: 100 } },
        fetchedAt: Date.now()
      }]
    ]);

    expect(getAutoTriggerAction(config, eventBuffers, "trader", "jump_route", 60)).toBe("jump_route");
  });

  it("returns original action when no combat events present", () => {
    const config = makeConfig({
      agents: [{ name: "sable-thorn", role: "Combat/Mining" }],
    });
    const eventBuffers = new Map([["sable-thorn", new EventBuffer()]]);

    expect(getAutoTriggerAction(config, eventBuffers, "sable-thorn", "jump_route")).toBe("jump_route");
  });

  it("returns original action when no event buffer exists", () => {
    const config = makeConfig({
      agents: [{ name: "sable-thorn", role: "Combat/Mining" }],
    });
    const eventBuffers = new Map<string, EventBuffer>();

    expect(getAutoTriggerAction(config, eventBuffers, "sable-thorn", "travel_to")).toBe("travel_to");
  });

  it("returns original action for combat agent with pirate_warning (NPC pre-combat notice)", () => {
    const config = makeConfig({
      agents: [{ name: "sable-thorn", role: "Combat/Mining" }],
    });
    const buffer = new EventBuffer();
    buffer.push({
      type: "pirate_warning",
      payload: { delay_ticks: 2, is_boss: false, message: "Enforcer incoming", pirate_id: "p1", pirate_name: "Enforcer", pirate_tier: "tier2" },
      receivedAt: Date.now(),
    });
    const eventBuffers = new Map([["sable-thorn", buffer]]);

    expect(getAutoTriggerAction(config, eventBuffers, "sable-thorn", "jump_route")).toBe("jump_route");
  });

  it("returns original action for non-combat agent with pirate_warning (wait for pirate_combat)", () => {
    const config = makeConfig({
      agents: [{ name: "trader", role: "Trader/Mining" }],
    });
    const buffer = new EventBuffer();
    buffer.push({
      type: "pirate_warning",
      payload: { delay_ticks: 1, is_boss: false, message: "Enforcer incoming", pirate_id: "p1", pirate_name: "Enforcer", pirate_tier: "tier2" },
      receivedAt: Date.now(),
    });
    const eventBuffers = new Map([["trader", buffer]]);

    expect(getAutoTriggerAction(config, eventBuffers, "trader", "travel_to")).toBe("travel_to");
  });

  it("does not double-trigger when both pirate_warning and pirate_combat are present (non-combat)", () => {
    const config = makeConfig({
      agents: [{ name: "trader", role: "Trader/Mining" }],
    });
    const buffer = new EventBuffer();
    buffer.push({
      type: "pirate_warning",
      payload: { delay_ticks: 1, is_boss: false, message: "Enforcer incoming", pirate_id: "p1", pirate_name: "Enforcer", pirate_tier: "tier2" },
      receivedAt: Date.now(),
    });
    buffer.push({
      type: "pirate_combat",
      payload: { zone: "mid", enemies: 1 },
      receivedAt: Date.now(),
    });
    const eventBuffers = new Map([["trader", buffer]]);

    // Should still return flee (not throw or behave unexpectedly)
    expect(getAutoTriggerAction(config, eventBuffers, "trader", "travel_to")).toBe("flee");
  });

  it("triggers scan_and_attack when both player_combat and pirate_warning are present (combat)", () => {
    const config = makeConfig({
      agents: [{ name: "sable-thorn", role: "Combat/Mining" }],
    });
    const buffer = new EventBuffer();
    buffer.push({
      type: "pirate_warning",
      payload: { delay_ticks: 1, is_boss: false, message: "Enforcer incoming", pirate_id: "p1", pirate_name: "Enforcer", pirate_tier: "tier2" },
      receivedAt: Date.now(),
    });
    buffer.push({
      type: "player_combat",
      payload: { zone: "mid", enemies: 1 },
      receivedAt: Date.now(),
    });
    const eventBuffers = new Map([["sable-thorn", buffer]]);

    expect(getAutoTriggerAction(config, eventBuffers, "sable-thorn", "jump_route")).toBe("scan_and_attack");
  });
});

// ---------------------------------------------------------------------------
// decontaminateLog
// ---------------------------------------------------------------------------

const CONTAMINATION_WORDS = ["infrastructure", "broken", "queue lock"];

describe("decontaminateLog", () => {
  it("returns non-object values unchanged", () => {
    expect(decontaminateLog(null, CONTAMINATION_WORDS)).toBeNull();
    expect(decontaminateLog("raw string", CONTAMINATION_WORDS)).toBe("raw string");
    expect(decontaminateLog(42, CONTAMINATION_WORDS)).toBe(42);
  });

  it("preserves clean entries in entries array", () => {
    const result = decontaminateLog(
      { entries: ["Docked at station", "Sold 10 ore"] },
      CONTAMINATION_WORDS,
    ) as { entries: string[] };
    expect(result.entries).toEqual(["Docked at station", "Sold 10 ore"]);
  });

  it("filters out contaminated string entries in entries array", () => {
    const result = decontaminateLog(
      { entries: ["infrastructure failure detected", "all good here"] },
      CONTAMINATION_WORDS,
    ) as { entries: string[] };
    expect(result.entries).toEqual(["all good here"]);
  });

  it("filters out contaminated object entries in entries array", () => {
    const result = decontaminateLog(
      {
        entries: [
          { index: 0, entry: "queue lock on server", created_at: "now" },
          { index: 1, entry: "mined 5 ore", created_at: "now" },
        ],
      },
      CONTAMINATION_WORDS,
    ) as { entries: Array<{ entry: string }> };
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].entry).toBe("mined 5 ore");
  });

  it("redacts contaminated single entry object", () => {
    const result = decontaminateLog(
      { entry: { index: 0, entry: "backend broken", created_at: "now" } },
      CONTAMINATION_WORDS,
    ) as { entry: { entry: string; redacted: boolean } };
    expect(result.entry.entry).toContain("REDACTED");
    expect(result.entry.redacted).toBe(true);
  });

  it("preserves clean single entry object", () => {
    const result = decontaminateLog(
      { entry: { index: 0, entry: "arrived at Nova Terra", created_at: "now" } },
      CONTAMINATION_WORDS,
    ) as { entry: { entry: string } };
    expect(result.entry.entry).toBe("arrived at Nova Terra");
  });

  it("redacts contaminated single entry string field", () => {
    const result = decontaminateLog(
      { entry: "infrastructure meltdown" },
      CONTAMINATION_WORDS,
    ) as { entry: string };
    expect(result.entry).toContain("REDACTED");
  });

  it("is case-insensitive for contamination words", () => {
    const result = decontaminateLog(
      { entries: ["INFRASTRUCTURE failure", "clean entry"] },
      CONTAMINATION_WORDS,
    ) as { entries: string[] };
    expect(result.entries).toEqual(["clean entry"]);
  });

  it("does not redact if word only partially in word boundary but still matches substring", () => {
    // The check is includes(), so "broken" matches "brokenly" — that's by design
    const result = decontaminateLog(
      { entries: ["Everything is fine"] },
      CONTAMINATION_WORDS,
    ) as { entries: string[] };
    expect(result.entries[0]).toBe("Everything is fine");
  });
});

// ---------------------------------------------------------------------------
// getAgentForSession
// ---------------------------------------------------------------------------

describe("getAgentForSession", () => {
  it("returns undefined when sessionId is undefined", () => {
    const ctx = makeCtx();
    expect(getAgentForSession(ctx, undefined)).toBeUndefined();
  });

  it("returns undefined for unknown session", () => {
    const ctx = makeCtx();
    expect(getAgentForSession(ctx, "unknown-session-id")).toBeUndefined();
  });

  it("returns agent name for known session", () => {
    const ctx = makeCtx();
    ctx.sessionAgentMap.set("session-abc", "alpha");
    expect(getAgentForSession(ctx, "session-abc")).toBe("alpha");
  });

  it("handles multiple sessions mapping to different agents", () => {
    const ctx = makeCtx();
    ctx.sessionAgentMap.set("s1", "alpha");
    ctx.sessionAgentMap.set("s2", "bravo");
    expect(getAgentForSession(ctx, "s1")).toBe("alpha");
    expect(getAgentForSession(ctx, "s2")).toBe("bravo");
  });
});

// ---------------------------------------------------------------------------
// getTracker
// ---------------------------------------------------------------------------

describe("getTracker", () => {
  it("creates a fresh tracker for an unknown agent", () => {
    const ctx = makeCtx();
    const tracker = getTracker(ctx, "alpha");
    expect(tracker).toEqual({
      counts: {},
      lastCallSig: null,
      calledTools: new Set(),
    });
  });

  it("stores the created tracker in the map", () => {
    const ctx = makeCtx();
    getTracker(ctx, "alpha");
    expect(ctx.callTrackers.has("alpha")).toBe(true);
  });

  it("returns the same tracker on subsequent calls", () => {
    const ctx = makeCtx();
    const t1 = getTracker(ctx, "alpha");
    t1.lastCallSig = "mine:{}";
    const t2 = getTracker(ctx, "alpha");
    expect(t2.lastCallSig).toBe("mine:{}");
    expect(t1).toBe(t2); // same reference
  });

  it("returns existing tracker if already in map", () => {
    const ctx = makeCtx();
    const existing: AgentCallTracker = {
      counts: { mine: 3 },
      lastCallSig: "mine:{}",
      calledTools: new Set(["mine"]),
    };
    ctx.callTrackers.set("alpha", existing);
    const result = getTracker(ctx, "alpha");
    expect(result).toBe(existing);
    expect(result.counts.mine).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// resetTracker
// ---------------------------------------------------------------------------

describe("resetTracker", () => {
  it("replaces existing tracker with a fresh one", () => {
    const ctx = makeCtx();
    const old: AgentCallTracker = {
      counts: { mine: 5 },
      lastCallSig: "mine:{}",
      calledTools: new Set(["mine"]),
    };
    ctx.callTrackers.set("alpha", old);
    resetTracker(ctx, "alpha");
    const fresh = ctx.callTrackers.get("alpha")!;
    expect(fresh.counts).toEqual({});
    expect(fresh.lastCallSig).toBeNull();
    expect(fresh.calledTools.size).toBe(0);
  });

  it("creates a tracker even if none existed before", () => {
    const ctx = makeCtx();
    resetTracker(ctx, "newAgent");
    expect(ctx.callTrackers.has("newAgent")).toBe(true);
    const tracker = ctx.callTrackers.get("newAgent")!;
    expect(tracker.counts).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// getAgentFormat
// ---------------------------------------------------------------------------

describe("getAgentFormat", () => {
  it("returns yaml for agent configured with yaml", () => {
    const config = makeConfig();
    expect(getAgentFormat(config, "alpha")).toBe("yaml");
  });

  it("returns json for agent with no toolResultFormat configured", () => {
    const config = makeConfig();
    expect(getAgentFormat(config, "bravo")).toBe("json");
  });

  it("returns json for unknown agent", () => {
    const config = makeConfig();
    expect(getAgentFormat(config, "unknown-agent")).toBe("json");
  });
});

// ---------------------------------------------------------------------------
// callSignatureV1
// ---------------------------------------------------------------------------

describe("callSignatureV1", () => {
  it("produces toolName: with no args", () => {
    expect(callSignatureV1("mine")).toBe("mine:");
    expect(callSignatureV1("mine", {})).toBe("mine:");
  });

  it("produces toolName:argsJSON with args", () => {
    const sig = callSignatureV1("sell", { item_id: "iron_ore", quantity: 5 });
    expect(sig).toContain("sell:");
    expect(sig).toContain("iron_ore");
    expect(sig).toContain("5");
  });

  it("sorts arg keys for stable signatures", () => {
    const s1 = callSignatureV1("sell", { quantity: 5, item_id: "iron_ore" });
    const s2 = callSignatureV1("sell", { item_id: "iron_ore", quantity: 5 });
    expect(s1).toBe(s2);
  });

  it("does not include action in the signature", () => {
    // v1 has no action concept — all args are treated equally
    const sig = callSignatureV1("spacemolt", { action: "mine" });
    expect(sig).toContain("action");
  });
});

// ---------------------------------------------------------------------------
// callSignatureV2
// ---------------------------------------------------------------------------

describe("callSignatureV2", () => {
  it("produces toolName: with no args", () => {
    expect(callSignatureV2("spacemolt")).toBe("spacemolt:");
    expect(callSignatureV2("spacemolt", {})).toBe("spacemolt:");
  });

  it("includes action in the signature prefix", () => {
    const sig = callSignatureV2("spacemolt", { action: "mine" });
    expect(sig).toBe("spacemolt:mine:");
  });

  it("excludes action from the arg JSON portion", () => {
    const sig = callSignatureV2("spacemolt", { action: "sell", item_id: "iron_ore" });
    // action should appear in prefix, not in the arg JSON
    expect(sig).toContain("spacemolt:sell:");
    expect(sig).toContain("iron_ore");
    // The action key should NOT appear in the args portion
    const argPart = sig.split("spacemolt:sell:")[1];
    expect(argPart).not.toContain('"action"');
  });

  it("sorts remaining arg keys for stable signatures", () => {
    const s1 = callSignatureV2("spacemolt", { action: "sell", quantity: 5, item_id: "iron_ore" });
    const s2 = callSignatureV2("spacemolt", { action: "sell", item_id: "iron_ore", quantity: 5 });
    expect(s1).toBe(s2);
  });

  it("distinguishes different actions", () => {
    const s1 = callSignatureV2("spacemolt", { action: "mine" });
    const s2 = callSignatureV2("spacemolt", { action: "sell" });
    expect(s1).not.toBe(s2);
  });
});

// ---------------------------------------------------------------------------
// checkGuardrailsV1
// ---------------------------------------------------------------------------

describe("checkGuardrailsV1", () => {
  let ctx: PipelineContext;

  beforeEach(() => {
    createDatabase(":memory:");
    ctx = makeCtx();
  });

  afterEach(() => {
    closeDb();
  });

  it("returns null for a valid call with no restrictions", () => {
    const result = checkGuardrailsV1(ctx, "alpha", "mine");
    expect(result).toBeNull();
  });

  it("blocks a globally denied tool", () => {
    ctx = makeCtx({
      config: makeConfig({
        agentDeniedTools: { "*": { jettison: "use sell instead" } },
      }),
    });
    const result = checkGuardrailsV1(ctx, "alpha", "jettison");
    expect(result).toContain("not available");
    expect(result).toContain("sell instead");
  });

  it("blocks an agent-specific denied tool", () => {
    ctx = makeCtx({
      config: makeConfig({
        agentDeniedTools: { alpha: { attack: "alpha is a miner" } },
      }),
    });
    const result = checkGuardrailsV1(ctx, "alpha", "attack");
    expect(result).toContain("not available for you");
    expect(result).toContain("alpha is a miner");
  });

  it("does not block a denied tool for a different agent", () => {
    ctx = makeCtx({
      config: makeConfig({
        agentDeniedTools: { bravo: { attack: "bravo is restricted" } },
      }),
    });
    // alpha is NOT restricted
    const result = checkGuardrailsV1(ctx, "alpha", "attack");
    expect(result).toBeNull();
  });

  it("blocks duplicate consecutive calls", () => {
    checkGuardrailsV1(ctx, "alpha", "mine", { poi: "belt-1" });
    const result = checkGuardrailsV1(ctx, "alpha", "mine", { poi: "belt-1" });
    expect(result).toContain("Duplicate call blocked");
    expect(result).toContain("mine");
  });

  it("allows the same call if args differ", () => {
    checkGuardrailsV1(ctx, "alpha", "mine", { poi: "belt-1" });
    const result = checkGuardrailsV1(ctx, "alpha", "mine", { poi: "belt-2" });
    expect(result).toBeNull();
  });

  it("allows the same call after a different call in between", () => {
    checkGuardrailsV1(ctx, "alpha", "mine");
    checkGuardrailsV1(ctx, "alpha", "get_status");
    const result = checkGuardrailsV1(ctx, "alpha", "mine");
    expect(result).toBeNull();
  });

  it("enforces call limits from ctx.callLimits", () => {
    ctx = makeCtx({ callLimits: { mine: 2 } });
    expect(checkGuardrailsV1(ctx, "alpha", "mine")).toBeNull();
    // Second call — different sig (no args on first, different tracking state)
    // Need to use distinct args to avoid duplicate detection
    expect(checkGuardrailsV1(ctx, "alpha", "mine", { x: 1 })).toBeNull();
    const result = checkGuardrailsV1(ctx, "alpha", "mine", { x: 2 });
    expect(result).toContain("Limit reached");
    expect(result).toContain("mine");
  });

  it("tracks called tools in the tracker", () => {
    checkGuardrailsV1(ctx, "alpha", "mine");
    const tracker = ctx.callTrackers.get("alpha")!;
    expect(tracker.calledTools.has("mine")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkGuardrailsV2
// ---------------------------------------------------------------------------

describe("checkGuardrailsV2", () => {
  let ctx: PipelineContext;
  const TEST_SESSION_ID = "test-session-123"; // Dummy sessionId for tests (offline check bypassed when no sessionStore)

  beforeEach(() => {
    createDatabase(":memory:");
    ctx = makeCtx(); // No sessionStore — offline check will be skipped
  });

  afterEach(() => {
    closeDb();
  });

  it("returns null for a valid call with no restrictions", () => {
    const result = checkGuardrailsV2(ctx, "alpha", "spacemolt", "mine", undefined, TEST_SESSION_ID);
    expect(result).toBeNull();
  });

  it("blocks a globally denied tool:action composite key", () => {
    ctx = makeCtx({
      config: makeConfig({
        agentDeniedTools: { "*": { "spacemolt:jettison": "not allowed" } },
      }),
    });
    const result = checkGuardrailsV2(ctx, "alpha", "spacemolt", "jettison", undefined, TEST_SESSION_ID);
    expect(result).toContain("not available");
    expect(result).toContain("not allowed");
  });

  it("blocks via v1-compat action name in global denied tools", () => {
    ctx = makeCtx({
      config: makeConfig({
        agentDeniedTools: { "*": { sell: "market saturated" } },
      }),
    });
    const result = checkGuardrailsV2(ctx, "alpha", "spacemolt", "sell", undefined, TEST_SESSION_ID);
    expect(result).toContain("market saturated");
  });

  it("blocks a v2 schema-level denied action (DENIED_ACTIONS_V2)", () => {
    // "trade_offer" is in DENIED_ACTIONS_V2 for "spacemolt"
    const result = checkGuardrailsV2(ctx, "alpha", "spacemolt", "trade_offer", undefined, TEST_SESSION_ID);
    expect(result).toContain("not available on spacemolt");
  });

  it("blocks an agent-specific tool:action key", () => {
    ctx = makeCtx({
      config: makeConfig({
        agentDeniedTools: { alpha: { "spacemolt:attack": "alpha does not fight" } },
      }),
    });
    const result = checkGuardrailsV2(ctx, "alpha", "spacemolt", "attack", undefined, TEST_SESSION_ID);
    expect(result).toContain("not available for you");
    expect(result).toContain("alpha does not fight");
  });

  it("blocks duplicate consecutive calls (action-aware signature)", () => {
    checkGuardrailsV2(ctx, "alpha", "spacemolt", "mine", { poi: "belt-1" }, TEST_SESSION_ID);
    const result = checkGuardrailsV2(ctx, "alpha", "spacemolt", "mine", { poi: "belt-1" }, TEST_SESSION_ID);
    expect(result).toContain("Duplicate call blocked");
  });

  it("allows duplicate tool name with different actions", () => {
    checkGuardrailsV2(ctx, "alpha", "spacemolt", "mine", undefined, TEST_SESSION_ID);
    // Different action — should not be a duplicate
    const result = checkGuardrailsV2(ctx, "alpha", "spacemolt", "sell", undefined, TEST_SESSION_ID);
    expect(result).toBeNull();
  });

  it("enforces call limits for tool:action key", () => {
    ctx = makeCtx({ callLimits: { "spacemolt:mine": 1 } });
    expect(checkGuardrailsV2(ctx, "alpha", "spacemolt", "mine", { a: 1 }, TEST_SESSION_ID)).toBeNull();
    const result = checkGuardrailsV2(ctx, "alpha", "spacemolt", "mine", { a: 2 }, TEST_SESSION_ID);
    expect(result).toContain("Limit reached");
    expect(result).toContain("spacemolt:mine");
  });

  it("tracks both tool:action and bare action in calledTools", () => {
    checkGuardrailsV2(ctx, "alpha", "spacemolt", "mine", undefined, TEST_SESSION_ID);
    const tracker = ctx.callTrackers.get("alpha")!;
    expect(tracker.calledTools.has("spacemolt:mine")).toBe(true);
    expect(tracker.calledTools.has("mine")).toBe(true);
  });

  it("handles undefined action gracefully (tool-only key)", () => {
    const result = checkGuardrailsV2(ctx, "alpha", "spacemolt", undefined, undefined, TEST_SESSION_ID);
    expect(result).toBeNull();
    const tracker = ctx.callTrackers.get("alpha")!;
    expect(tracker.calledTools.has("spacemolt")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// withInjections
// ---------------------------------------------------------------------------

describe("withInjections", () => {
  let ctx: PipelineContext;

  beforeEach(() => {
    ctx = makeCtx();
  });

  it("returns response unchanged when nothing to inject and format is json", async () => {
    const response = makeResponse(JSON.stringify({ result: "ok" }));
    const result = await withInjections(ctx, "bravo", response);
    expect(result.content[0].text).toBe(JSON.stringify({ result: "ok" }));
  });

  it("calls reformatResponse when agent prefers yaml (no injections)", async () => {
    const reformatCalls: Array<{ text: string; format: string }> = [];
    ctx = makeCtx({
      reformatResponse: (text, format) => {
        reformatCalls.push({ text, format });
        return `yaml:${text}`;
      },
    });
    const response = makeResponse(JSON.stringify({ result: "ok" }));
    const result = await withInjections(ctx, "alpha", response);
    expect(reformatCalls.length).toBeGreaterThan(0);
    expect(reformatCalls[0].format).toBe("yaml");
    expect(result.content[0].text).toContain("yaml:");
  });

  it("injects critical events from the event buffer", async () => {
    const buf = new EventBuffer();
    buf.push({ type: "combat_update", payload: { hull: 50 }, receivedAt: Date.now() });
    ctx = makeCtx({ eventBuffers: new Map([["alpha", buf]]) });

    const response = makeResponse(JSON.stringify({ result: "ok" }));
    const result = await withInjections(ctx, "alpha", response);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.events).toBeDefined();
    expect(parsed.events[0].type).toBe("combat_update");
    expect(parsed.events[0].data.hull).toBe(50);
  });

  it("drains events from buffer after injection", async () => {
    const buf = new EventBuffer();
    buf.push({ type: "combat_update", payload: { hull: 50 }, receivedAt: Date.now() });
    ctx = makeCtx({ eventBuffers: new Map([["alpha", buf]]) });

    await withInjections(ctx, "alpha", makeResponse(JSON.stringify({ result: "ok" })));
    // Buffer should be drained — second call gets no events
    const buf2 = ctx.eventBuffers.get("alpha")!;
    expect(buf2.drainCritical().length).toBe(0);
  });

  it("injects fleet orders and marks them delivered", async () => {
    const deliveredIds: number[] = [];
    const orders: FleetOrder[] = [
      { id: 1, message: "Report to Nova Terra", priority: "high" },
      { id: 2, message: "Sell ore at Proxima", priority: "normal" },
    ];
    ctx = makeCtx({
      getFleetPendingOrders: () => orders,
      markOrderDelivered: (id) => deliveredIds.push(id),
    });

    const response = makeResponse(JSON.stringify({ result: "ok" }));
    const result = await withInjections(ctx, "alpha", response);
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.fleet_orders).toBeDefined();
    expect(parsed.fleet_orders).toHaveLength(2);
    expect(parsed.fleet_orders[0].id).toBe(1);
    expect(parsed.fleet_orders[0].message).toBe("Report to Nova Terra");
    expect(parsed.fleet_orders[1].priority).toBe("normal");

    // All orders should be marked delivered
    expect(deliveredIds).toEqual([1, 2]);
  });

  it("returns response as-is if content text is not valid JSON", async () => {
    // Inject an event so the injection path is taken
    const buf = new EventBuffer();
    buf.push({ type: "combat_update", payload: {}, receivedAt: Date.now() });
    ctx = makeCtx({ eventBuffers: new Map([["alpha", buf]]) });

    const response = makeResponse("not valid json at all");
    const result = await withInjections(ctx, "alpha", response);
    expect(result.content[0].text).toBe("not valid json at all");
  });

  it("injects events into a primitive/scalar JSON response via result wrapping", async () => {
    // Inject an event to trigger injection path
    const buf = new EventBuffer();
    buf.push({ type: "combat_update", payload: { hull: 80 }, receivedAt: Date.now() });
    ctx = makeCtx({ eventBuffers: new Map([["bravo", buf]]) });

    // Response text is a plain string scalar — not an object
    const response = makeResponse(JSON.stringify("some-result-string"));
    const result = await withInjections(ctx, "bravo", response);
    const parsed = JSON.parse(result.content[0].text);
    // Primitive values get wrapped in { result: <value> }
    expect(parsed.result).toBe("some-result-string");
    expect(parsed.events).toBeDefined();
    expect(parsed.events[0].type).toBe("combat_update");
  });

  it("passes versionLabel to log prefix (smoke test — no error)", async () => {
    // Non-JSON response with event injected — triggers the catch branch with versionLabel
    const buf = new EventBuffer();
    buf.push({ type: "combat_update", payload: {}, receivedAt: Date.now() });
    ctx = makeCtx({ eventBuffers: new Map([["alpha", buf]]) });

    const response = makeResponse("bad json");
    // Should not throw; versionLabel just affects the log message
    await expect(withInjections(ctx, "alpha", response, "v2")).resolves.toBeDefined();
  });

  it("reformats injected output when agent prefers yaml", async () => {
    const buf = new EventBuffer();
    buf.push({ type: "combat_update", payload: { hull: 70 }, receivedAt: Date.now() });

    const reformatCalls: Array<{ text: string; format: string; label: string }> = [];
    ctx = makeCtx({
      eventBuffers: new Map([["alpha", buf]]),
      reformatResponse: (text, format, label) => {
        reformatCalls.push({ text, format, label });
        return `yaml:${text}`;
      },
    });

    const result = await withInjections(ctx, "alpha", makeResponse(JSON.stringify({ ok: true })));
    // Should have called reformatResponse with the injected payload
    const injectCall = reformatCalls.find((c) => c.label === "response+injections");
    expect(injectCall).toBeDefined();
    expect(injectCall!.format).toBe("yaml");
    expect(result.content[0].text).toContain("yaml:");
  });

  // --- Battle state injection tests ---

  it("injects battle state when agent is in active combat", async () => {
    const battleState = {
      battle_id: "battle-123",
      zone: "mid",
      stance: "aggressive",
      hull: 45,
      shields: 30,
      target: { id: "pirate-456" },
      status: "active",
      updatedAt: Date.now(),
    };
    const battleCache = new Map([["alpha", battleState]]);
    ctx = makeCtx({ battleCache });

    const response = makeResponse(JSON.stringify({ result: "ok" }));
    const result = await withInjections(ctx, "alpha", response);
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed._battle_status).toBeDefined();
    expect(parsed._battle_status.in_battle).toBe(true);
    expect(parsed._battle_status.status).toBe("active");
    expect(parsed._battle_status.zone).toBe("mid");
    expect(parsed._battle_status.hull).toBe(45);
    expect(parsed._battle_status.stance).toBe("aggressive");
    expect(parsed._battle_status.battle_id).toBe("battle-123");
  });

  it("does not inject battle state when agent is not in cache", async () => {
    const battleCache = new Map();
    ctx = makeCtx({ battleCache });

    const response = makeResponse(JSON.stringify({ result: "ok" }));
    const result = await withInjections(ctx, "alpha", response);
    // No injections means response is unchanged
    expect(result.content[0].text).toBe(JSON.stringify({ result: "ok" }));
  });

  it("does not inject battle state when cached battle is null (ended)", async () => {
    const battleCache = new Map([["alpha", null]]);
    ctx = makeCtx({ battleCache });

    const response = makeResponse(JSON.stringify({ result: "ok" }));
    const result = await withInjections(ctx, "alpha", response);
    // No injections means response is unchanged
    expect(result.content[0].text).toBe(JSON.stringify({ result: "ok" }));
  });

  it("does not inject battle state when battle status is ended", async () => {
    const battleState = {
      battle_id: "battle-123",
      zone: "mid",
      stance: "defensive",
      hull: 10,
      shields: 0,
      target: { id: "pirate-456" },
      status: "ended",
      updatedAt: Date.now(),
    };
    const battleCache = new Map([["alpha", battleState]]);
    ctx = makeCtx({ battleCache });

    const response = makeResponse(JSON.stringify({ result: "ok" }));
    const result = await withInjections(ctx, "alpha", response);
    // No injections means response is unchanged
    expect(result.content[0].text).toBe(JSON.stringify({ result: "ok" }));
  });

  it("does not inject battle state when battle status is victory", async () => {
    const battleState = {
      battle_id: "battle-123",
      zone: "mid",
      stance: "aggressive",
      hull: 75,
      shields: 100,
      target: { id: "pirate-456" },
      status: "victory",
      updatedAt: Date.now(),
    };
    const battleCache = new Map([["alpha", battleState]]);
    ctx = makeCtx({ battleCache });

    const response = makeResponse(JSON.stringify({ result: "ok" }));
    const result = await withInjections(ctx, "alpha", response);
    // No injections means response is unchanged
    expect(result.content[0].text).toBe(JSON.stringify({ result: "ok" }));
  });

  it("does not inject battle state when battle status is defeat", async () => {
    const battleState = {
      battle_id: "battle-123",
      zone: "mid",
      stance: "defensive",
      hull: 5,
      shields: 0,
      target: { id: "pirate-456" },
      status: "defeat",
      updatedAt: Date.now(),
    };
    const battleCache = new Map([["alpha", battleState]]);
    ctx = makeCtx({ battleCache });

    const response = makeResponse(JSON.stringify({ result: "ok" }));
    const result = await withInjections(ctx, "alpha", response);
    // No injections means response is unchanged
    expect(result.content[0].text).toBe(JSON.stringify({ result: "ok" }));
  });

  it("does not inject battle state when battle status is fled", async () => {
    const battleState = {
      battle_id: "battle-123",
      zone: "mid",
      stance: "flee",
      hull: 20,
      shields: 10,
      target: { id: "pirate-456" },
      status: "fled",
      updatedAt: Date.now(),
    };
    const battleCache = new Map([["alpha", battleState]]);
    ctx = makeCtx({ battleCache });

    const response = makeResponse(JSON.stringify({ result: "ok" }));
    const result = await withInjections(ctx, "alpha", response);
    // No injections means response is unchanged
    expect(result.content[0].text).toBe(JSON.stringify({ result: "ok" }));
  });

  it("injects battle state alongside critical events", async () => {
    const battleState = {
      battle_id: "battle-123",
      zone: "mid",
      stance: "aggressive",
      hull: 45,
      shields: 30,
      target: { id: "pirate-456" },
      status: "active",
      updatedAt: Date.now(),
    };
    const buf = new EventBuffer();
    buf.push({ type: "combat_update", payload: { enemy_hull: 60 }, receivedAt: Date.now() });

    const battleCache = new Map([["alpha", battleState]]);
    ctx = makeCtx({ battleCache, eventBuffers: new Map([["alpha", buf]]) });

    const response = makeResponse(JSON.stringify({ result: "ok" }));
    const result = await withInjections(ctx, "alpha", response);
    const parsed = JSON.parse(result.content[0].text);

    // Both events and battle status should be present
    expect(parsed.events).toBeDefined();
    expect(parsed.events.length).toBeGreaterThan(0);
    expect(parsed.events[0].type).toBe("combat_update");
    expect(parsed._battle_status).toBeDefined();
    expect(parsed._battle_status.in_battle).toBe(true);
  });

  it("injects battle state alongside fleet orders", async () => {
    const battleState = {
      battle_id: "battle-123",
      zone: "mid",
      stance: "aggressive",
      hull: 50,
      shields: 50,
      target: { id: "pirate-456" },
      status: "active",
      updatedAt: Date.now(),
    };
    const orders: FleetOrder[] = [
      { id: 1, message: "Hold position", priority: "high" },
    ];
    const battleCache = new Map([["alpha", battleState]]);
    ctx = makeCtx({
      battleCache,
      getFleetPendingOrders: () => orders,
      markOrderDelivered: () => {},
    });

    const response = makeResponse(JSON.stringify({ result: "ok" }));
    const result = await withInjections(ctx, "alpha", response);
    const parsed = JSON.parse(result.content[0].text);

    // Both fleet orders and battle status should be present
    expect(parsed.fleet_orders).toBeDefined();
    expect(parsed.fleet_orders[0].id).toBe(1);
    expect(parsed._battle_status).toBeDefined();
    expect(parsed._battle_status.in_battle).toBe(true);
  });

  it("preserves existing response structure when injecting battle state", async () => {
    const battleState = {
      battle_id: "battle-123",
      zone: "mid",
      stance: "aggressive",
      hull: 45,
      shields: 30,
      target: { id: "pirate-456" },
      status: "active",
      updatedAt: Date.now(),
    };
    const battleCache = new Map([["alpha", battleState]]);
    ctx = makeCtx({ battleCache });

    const response = makeResponse(JSON.stringify({ status: "completed", result: { action: "mine", ore: 5 } }));
    const result = await withInjections(ctx, "alpha", response);
    const parsed = JSON.parse(result.content[0].text);

    // Original fields should still exist
    expect(parsed.status).toBe("completed");
    expect(parsed.result.action).toBe("mine");
    expect(parsed.result.ore).toBe(5);
    // Battle state injected alongside
    expect(parsed._battle_status).toBeDefined();
    expect(parsed._battle_status.in_battle).toBe(true);
  });

  // --- Directive injection tests ---

  it("injects standing_orders when directives are present", async () => {
    const directives = [
      { id: 1, agent_name: "alpha", directive: "Stay in Sol", priority: "high" as const, active: 1, created_at: "", expires_at: null, created_by: "admin" },
    ];
    ctx = makeCtx({ getActiveDirectives: () => directives });

    const result = await withInjections(ctx, "alpha", makeResponse(JSON.stringify({ ok: true })));
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.standing_orders).toBeDefined();
    expect(parsed.standing_orders).toContain("STANDING ORDERS:");
    expect(parsed.standing_orders).toContain("[high] Stay in Sol");
  });

  it("injects critical directives on every call", async () => {
    const directives = [
      { id: 1, agent_name: "alpha", directive: "Never attack civilians", priority: "critical" as const, active: 1, created_at: "", expires_at: null, created_by: "admin" },
    ];
    const counters = new Map<string, number>();
    ctx = makeCtx({ getActiveDirectives: () => directives, directivesCallCounters: counters });

    // Call 1 — should inject
    let result = await withInjections(ctx, "alpha", makeResponse(JSON.stringify({ ok: true })));
    expect(JSON.parse(result.content[0].text).standing_orders).toBeDefined();

    // Call 2 — critical should still inject even on non-5th call
    result = await withInjections(ctx, "alpha", makeResponse(JSON.stringify({ ok: true })));
    expect(JSON.parse(result.content[0].text).standing_orders).toBeDefined();
  });

  it("throttles non-critical directives to every 5 calls", async () => {
    const directives = [
      { id: 1, agent_name: "alpha", directive: "Mine iron ore", priority: "normal" as const, active: 1, created_at: "", expires_at: null, created_by: "admin" },
    ];
    const counters = new Map<string, number>();
    ctx = makeCtx({ getActiveDirectives: () => directives, directivesCallCounters: counters });

    // Call 1 (count=1, 1%5===1) — injects
    let result = await withInjections(ctx, "alpha", makeResponse(JSON.stringify({ ok: true })));
    expect(JSON.parse(result.content[0].text).standing_orders).toBeDefined();

    // Calls 2-5 (count 2-5) — should NOT inject non-critical
    for (let i = 0; i < 4; i++) {
      result = await withInjections(ctx, "alpha", makeResponse(JSON.stringify({ ok: true })));
      expect(JSON.parse(result.content[0].text).standing_orders).toBeUndefined();
    }

    // Call 6 (count=6, 6%5===1) — injects again
    result = await withInjections(ctx, "alpha", makeResponse(JSON.stringify({ ok: true })));
    expect(JSON.parse(result.content[0].text).standing_orders).toBeDefined();
  });

  it("does not inject standing_orders when no directives", async () => {
    ctx = makeCtx({ getActiveDirectives: () => [] });

    const result = await withInjections(ctx, "alpha", makeResponse(JSON.stringify({ ok: true })));
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.standing_orders).toBeUndefined();
  });

  it("skips directive injection when getActiveDirectives is not set", async () => {
    ctx = makeCtx(); // no getActiveDirectives

    const result = await withInjections(ctx, "alpha", makeResponse(JSON.stringify({ ok: true })));
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.standing_orders).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// validateCaptainsLogFormat
// ---------------------------------------------------------------------------

describe("validateCaptainsLogFormat", () => {
  describe("valid formats", () => {
    it("accepts a minimal but correct captain's log", () => {
      const log = `LOC: Sol sol_belt_1 undocked
CR: 1500 | FUEL: 45/100 | CARGO: 80/120
DID: Mined 500 ore from the belt.
NEXT: Jump to Kepler, mine belt_2, return.`;
      const result = validateCaptainsLogFormat(log);
      expect(result.valid).toBe(true);
    });

    it("accepts log with different system names and POI IDs", () => {
      const log = `LOC: Proxima proxima_station docked
CR: 5000 | FUEL: 100/100 | CARGO: 0/120
DID: Sold all cargo, restocked supplies.
NEXT: Travel to kepler_belt, mine ore, refuel.`;
      const result = validateCaptainsLogFormat(log);
      expect(result.valid).toBe(true);
    });

    it("accepts log with large numbers", () => {
      const log = `LOC: Alpha alpha_mine undocked
CR: 999999 | FUEL: 50/200 | CARGO: 119/120
DID: Found treasure cache, looted valuable items.
NEXT: Jump to Beta system, explore ruins.`;
      const result = validateCaptainsLogFormat(log);
      expect(result.valid).toBe(true);
    });

    it("accepts complex FUEL notation with fractions", () => {
      const log = `LOC: TestSys test_poi docked
CR: 2000 | FUEL: 99/100 | CARGO: 5/120
DID: Refueled completely at the station.
NEXT: Undock and jump to Sirius.`;
      const result = validateCaptainsLogFormat(log);
      expect(result.valid).toBe(true);
    });

    it("accepts single-word system and POI names", () => {
      const log = `LOC: X x undocked
CR: 0 | FUEL: 1/10 | CARGO: 0/1
DID: Started.
NEXT: Mine.`;
      const result = validateCaptainsLogFormat(log);
      expect(result.valid).toBe(true);
    });
  });

  describe("invalid line count", () => {
    it("rejects a 3-line entry", () => {
      const log = `LOC: Sol sol_belt_1 undocked
CR: 1500 | FUEL: 45/100 | CARGO: 80/120
DID: Mined ore.`;
      const result = validateCaptainsLogFormat(log);
      expect(result.valid).toBe(false);
      expect((result as {valid: false; error: string}).error).toContain("EXACTLY 4 lines");
      expect((result as {valid: false; error: string}).error).toContain("3");
    });

    it("rejects a 5-line entry", () => {
      const log = `LOC: Sol sol_belt_1 undocked
CR: 1500 | FUEL: 45/100 | CARGO: 80/120
DID: Mined ore.
NEXT: Jump to Kepler.
EXTRA: This shouldn't be here.`;
      const result = validateCaptainsLogFormat(log);
      expect(result.valid).toBe(false);
      expect((result as {valid: false; error: string}).error).toContain("EXACTLY 4 lines");
      expect((result as {valid: false; error: string}).error).toContain("5");
    });

    it("rejects entry with extra blank lines", () => {
      const log = `LOC: Sol sol_belt_1 undocked
CR: 1500 | FUEL: 45/100 | CARGO: 80/120

DID: Mined ore.
NEXT: Jump next.`;
      const result = validateCaptainsLogFormat(log);
      expect(result.valid).toBe(false);
      expect((result as {valid: false; error: string}).error).toContain("EXACTLY 4 lines");
    });
  });

  describe("invalid line labels", () => {
    it("rejects missing LOC label", () => {
      const log = `Sol sol_belt_1 undocked
CR: 1500 | FUEL: 45/100 | CARGO: 80/120
DID: Mined ore.
NEXT: Jump.`;
      const result = validateCaptainsLogFormat(log);
      expect(result.valid).toBe(false);
      expect((result as {valid: false; error: string}).error).toContain("LOC:");
    });

    it("rejects missing CR label", () => {
      const log = `LOC: Sol sol_belt_1 undocked
1500 | FUEL: 45/100 | CARGO: 80/120
DID: Mined ore.
NEXT: Jump.`;
      const result = validateCaptainsLogFormat(log);
      expect(result.valid).toBe(false);
      expect((result as {valid: false; error: string}).error).toContain("CR:");
    });

    it("rejects missing DID label", () => {
      const log = `LOC: Sol sol_belt_1 undocked
CR: 1500 | FUEL: 45/100 | CARGO: 80/120
Mined ore.
NEXT: Jump.`;
      const result = validateCaptainsLogFormat(log);
      expect(result.valid).toBe(false);
      expect((result as {valid: false; error: string}).error).toContain("DID:");
    });

    it("rejects missing NEXT label", () => {
      const log = `LOC: Sol sol_belt_1 undocked
CR: 1500 | FUEL: 45/100 | CARGO: 80/120
DID: Mined ore.
Jump to Kepler.`;
      const result = validateCaptainsLogFormat(log);
      expect(result.valid).toBe(false);
      expect((result as {valid: false; error: string}).error).toContain("NEXT:");
    });
  });

  describe("invalid CR line format", () => {
    it("rejects missing pipe separator", () => {
      const log = `LOC: Sol sol_belt_1 undocked
CR: 1500 FUEL: 45/100 | CARGO: 80/120
DID: Mined ore.
NEXT: Jump.`;
      const result = validateCaptainsLogFormat(log);
      expect(result.valid).toBe(false);
      expect((result as {valid: false; error: string}).error).toContain("FUEL:");
    });

    it("rejects missing FUEL field", () => {
      const log = `LOC: Sol sol_belt_1 undocked
CR: 1500 | CARGO: 80/120
DID: Mined ore.
NEXT: Jump.`;
      const result = validateCaptainsLogFormat(log);
      expect(result.valid).toBe(false);
      expect((result as {valid: false; error: string}).error).toContain("FUEL:");
    });

    it("rejects missing CARGO field", () => {
      const log = `LOC: Sol sol_belt_1 undocked
CR: 1500 | FUEL: 45/100
DID: Mined ore.
NEXT: Jump.`;
      const result = validateCaptainsLogFormat(log);
      expect(result.valid).toBe(false);
      expect((result as {valid: false; error: string}).error).toContain("CARGO:");
    });
  });

  describe("invalid LOC line format", () => {
    it("rejects LOC with missing POI", () => {
      const log = `LOC: Sol undocked
CR: 1500 | FUEL: 45/100 | CARGO: 80/120
DID: Mined ore.
NEXT: Jump.`;
      const result = validateCaptainsLogFormat(log);
      expect(result.valid).toBe(false);
      expect((result as {valid: false; error: string}).error).toContain("system, POI ID, and dock status");
    });

    it("rejects empty LOC content", () => {
      const log = `LOC:
CR: 1500 | FUEL: 45/100 | CARGO: 80/120
DID: Mined ore.
NEXT: Jump.`;
      const result = validateCaptainsLogFormat(log);
      expect(result.valid).toBe(false);
      expect((result as {valid: false; error: string}).error).toContain("system, POI ID, and dock status");
    });
  });

  describe("multiple sentences (now allowed for DID and NEXT)", () => {
    it("accepts DID with multiple sentences (periods)", () => {
      const log = `LOC: Sol sol_belt_1 undocked
CR: 1500 | FUEL: 45/100 | CARGO: 80/120
DID: Mined ore. Traded at station. Refueled.
NEXT: Jump.`;
      const result = validateCaptainsLogFormat(log);
      expect(result.valid).toBe(true);
    });

    it("accepts NEXT with multiple sentences", () => {
      const log = `LOC: Sol sol_belt_1 undocked
CR: 1500 | FUEL: 45/100 | CARGO: 80/120
DID: Mined ore.
NEXT: Jump to Kepler. Mine belt. Refuel.`;
      const result = validateCaptainsLogFormat(log);
      expect(result.valid).toBe(true);
    });

    it("accepts DID with semicolon-separated sentences", () => {
      const log = `LOC: Sol sol_belt_1 undocked
CR: 1500 | FUEL: 45/100 | CARGO: 80/120
DID: Mined ore; then sold.
NEXT: Jump.`;
      const result = validateCaptainsLogFormat(log);
      expect(result.valid).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("rejects empty string", () => {
      const result = validateCaptainsLogFormat("");
      expect(result.valid).toBe(false);
    });

    it("rejects null/undefined (type guard)", () => {
      const result = validateCaptainsLogFormat(null as unknown as string);
      expect(result.valid).toBe(false);
    });

    it("rejects empty DID content", () => {
      const log = `LOC: Sol sol_belt_1 undocked
CR: 1500 | FUEL: 45/100 | CARGO: 80/120
DID:
NEXT: Jump.`;
      const result = validateCaptainsLogFormat(log);
      expect(result.valid).toBe(false);
      expect((result as {valid: false; error: string}).error).toContain("DID");
    });

    it("rejects empty NEXT content", () => {
      const log = `LOC: Sol sol_belt_1 undocked
CR: 1500 | FUEL: 45/100 | CARGO: 80/120
DID: Mined ore.
NEXT:`;
      const result = validateCaptainsLogFormat(log);
      expect(result.valid).toBe(false);
      expect((result as {valid: false; error: string}).error).toContain("NEXT");
    });

    it("accepts entry with trailing newline (trimmed automatically)", () => {
      const log = `LOC: Sol sol_belt_1 undocked
CR: 1500 | FUEL: 45/100 | CARGO: 80/120
DID: Mined ore.
NEXT: Jump to Kepler.
`;
      const result = validateCaptainsLogFormat(log);
      expect(result.valid).toBe(true);
    });

    it("accepts entry with leading whitespace (trimmed automatically)", () => {
      const log = `  LOC: Sol sol_belt_1 undocked
CR: 1500 | FUEL: 45/100 | CARGO: 80/120
DID: Mined ore.
NEXT: Jump.`;
      const result = validateCaptainsLogFormat(log);
      expect(result.valid).toBe(true);
    });

    it("accepts DID with decimal numbers (13.6% error rate)", () => {
      const log = `LOC: Sol sol_belt_1 undocked
CR: 1500 | FUEL: 45/100 | CARGO: 80/120
DID: Logged in during 13.6% error rate and mined ore.
NEXT: Jump to Kepler.`;
      const result = validateCaptainsLogFormat(log);
      expect(result.valid).toBe(true);
    });

    it("accepts DID with version strings (v0.187.0)", () => {
      const log = `LOC: Sol sol_belt_1 undocked
CR: 1500 | FUEL: 45/100 | CARGO: 80/120
DID: Mined ore at v0.187.0 belt.
NEXT: Jump to Kepler.`;
      const result = validateCaptainsLogFormat(log);
      expect(result.valid).toBe(true);
    });

    it("accepts NEXT with decimal numbers", () => {
      const log = `LOC: Sol sol_belt_1 undocked
CR: 1500 | FUEL: 45/100 | CARGO: 80/120
DID: Mined ore.
NEXT: Sell 2.5k credits worth of ore at station.`;
      const result = validateCaptainsLogFormat(log);
      expect(result.valid).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// countSentenceBoundaries
// ---------------------------------------------------------------------------

describe("countSentenceBoundaries", () => {
  it("counts 1 for a simple sentence", () => {
    expect(countSentenceBoundaries("Mined ore.")).toBe(1);
  });

  it("counts 1 for sentence without trailing period", () => {
    expect(countSentenceBoundaries("Mined ore")).toBe(1);
  });

  it("counts multiple real sentences", () => {
    expect(countSentenceBoundaries("Mined ore. Traded at station. Refueled.")).toBe(3);
  });

  it("ignores periods in decimals like 13.6%", () => {
    expect(countSentenceBoundaries("Logged in during 13.6% error rate and mined ore.")).toBe(1);
  });

  it("ignores periods in version strings like v0.187.0", () => {
    expect(countSentenceBoundaries("Mined ore at v0.187.0 belt.")).toBe(1);
  });

  it("counts semicolons as boundaries", () => {
    expect(countSentenceBoundaries("Mined ore; then sold.")).toBe(2);
  });

  it("counts exclamation marks as boundaries", () => {
    expect(countSentenceBoundaries("Found treasure! Looted it.")).toBe(2);
  });

  it("counts question marks as boundaries", () => {
    expect(countSentenceBoundaries("Where is it? Found it.")).toBe(2);
  });

  it("ignores periods in prices like 1.5k", () => {
    expect(countSentenceBoundaries("Sold 1.5k worth of ore.")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// isProxySessionActive and offline proxy blocking
// ---------------------------------------------------------------------------

describe("isProxySessionActive", () => {
  it("returns true when session is active", () => {
    const store = new MockSessionStore();
    store.createSession("session-123");
    const ctx = makeCtx({ sessionStore: store as any });
    expect(isProxySessionActive(ctx, "session-123")).toBe(true);
  });

  it("returns false when session is expired", () => {
    const store = new MockSessionStore();
    store.createSession("session-123");
    store.expireSession("session-123");
    const ctx = makeCtx({ sessionStore: store as any });
    expect(isProxySessionActive(ctx, "session-123")).toBe(false);
  });

  it("returns false when session does not exist", () => {
    const store = new MockSessionStore();
    const ctx = makeCtx({ sessionStore: store as any });
    expect(isProxySessionActive(ctx, "session-nonexistent")).toBe(false);
  });

  it("returns false when sessionId is undefined", () => {
    const store = new MockSessionStore();
    const ctx = makeCtx({ sessionStore: store as any });
    expect(isProxySessionActive(ctx, undefined)).toBe(false);
  });

  it("returns false when sessionStore is not provided", () => {
    const ctx = makeCtx({ sessionStore: undefined });
    expect(isProxySessionActive(ctx, "session-123")).toBe(false);
  });

  it("returns false when both sessionId and store are missing", () => {
    const ctx = makeCtx({ sessionStore: undefined });
    expect(isProxySessionActive(ctx, undefined)).toBe(false);
  });
});

describe("checkGuardrailsV2 — offline proxy blocking", () => {
  beforeEach(() => {
    createDatabase(":memory:");
  });

  afterEach(() => {
    closeDb();
  });

  it("blocks tool calls when proxy session is offline (expired)", () => {
    const store = new MockSessionStore();
    store.createSession("session-123");
    store.expireSession("session-123"); // Session expired
    const ctx = makeCtx({ sessionStore: store as any });
    ctx.sessionAgentMap.set("session-123", "alpha");

    const result = checkGuardrailsV2(ctx, "alpha", "spacemolt", "mine", {}, "session-123");
    expect(result).not.toBeNull();
    expect(result).toContain("expired");
  });

  it("blocks tool calls when proxy session does not exist", () => {
    const store = new MockSessionStore();
    const ctx = makeCtx({ sessionStore: store as any });

    const result = checkGuardrailsV2(ctx, "alpha", "spacemolt", "mine", {}, "session-nonexistent");
    expect(result).not.toBeNull();
    expect(result).toContain("expired");
  });

  it("allows tool calls when proxy session is active", () => {
    const store = new MockSessionStore();
    store.createSession("session-123");
    const ctx = makeCtx({ sessionStore: store as any });
    ctx.sessionAgentMap.set("session-123", "alpha");

    const result = checkGuardrailsV2(ctx, "alpha", "spacemolt", "mine", {}, "session-123");
    // Should not be blocked by offline check (may have other blocks)
    // Verify the error is NOT about offline session
    if (result) {
      expect(result).not.toContain("expired");
      expect(result).not.toContain("offline");
    }
  });

  it("blocks tool calls when sessionId is not provided and store exists", () => {
    const store = new MockSessionStore();
    const ctx = makeCtx({ sessionStore: store as any });
    ctx.sessionAgentMap.set("session-123", "alpha");

    // Without sessionId provided, offline check should fail early
    const result = checkGuardrailsV2(ctx, "alpha", "spacemolt", "mine", {}, undefined);
    expect(result).not.toBeNull();
    expect(result).toContain("expired");
  });

  it("allows multiple tool calls from same active session", () => {
    const store = new MockSessionStore();
    store.createSession("session-123");
    const ctx = makeCtx({ sessionStore: store as any });
    ctx.sessionAgentMap.set("session-123", "alpha");

    const result1 = checkGuardrailsV2(ctx, "alpha", "spacemolt", "mine", {}, "session-123");
    const result2 = checkGuardrailsV2(ctx, "alpha", "spacemolt", "scan", {}, "session-123");

    // Both should not be blocked by offline check
    if (result1) expect(result1).not.toContain("expired");
    if (result2) expect(result2).not.toContain("expired");
  });

  it("blocks tool call immediately after session expires", () => {
    const store = new MockSessionStore();
    store.createSession("session-123");
    const ctx = makeCtx({ sessionStore: store as any });
    ctx.sessionAgentMap.set("session-123", "alpha");

    // First call succeeds (session is active)
    const result1 = checkGuardrailsV2(ctx, "alpha", "spacemolt", "mine", {}, "session-123");
    if (result1) expect(result1).not.toContain("expired");

    // Expire the session
    store.expireSession("session-123");

    // Second call blocked (session now expired)
    const result2 = checkGuardrailsV2(ctx, "alpha", "spacemolt", "scan", {}, "session-123");
    expect(result2).not.toBeNull();
    expect(result2).toContain("expired");
  });

  it("prevents phantom tool calls from offline proxy sessions", () => {
    const store = new MockSessionStore();
    store.createSession("session-alpha");
    store.createSession("session-bravo");

    // Expire alpha's session to simulate disconnection
    store.expireSession("session-alpha");

    const ctx = makeCtx({ sessionStore: store as any });
    ctx.sessionAgentMap.set("session-alpha", "alpha");
    ctx.sessionAgentMap.set("session-bravo", "bravo");

    // Alpha cannot execute tools (offline)
    const alphaMine = checkGuardrailsV2(ctx, "alpha", "spacemolt", "mine", {}, "session-alpha");
    expect(alphaMine).not.toBeNull();
    expect(alphaMine).toContain("expired");

    // Bravo can still execute tools (online)
    const braveMine = checkGuardrailsV2(ctx, "bravo", "spacemolt", "mine", {}, "session-bravo");
    if (braveMine) expect(braveMine).not.toContain("expired");
  });
});
