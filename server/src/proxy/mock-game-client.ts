/**
 * MockGameClient — drop-in replacement for GameClient in offline/mock mode.
 *
 * Used when gantry.json has mockMode: true (or mockMode.enabled: true).
 * Returns canned responses from mock-responses.json, with lightweight state
 * simulation so repeated calls show plausible results (credits decrease on
 * refuel, cargo fills on mine, etc.).
 *
 * No WebSocket required — pure in-memory simulation.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { GameResponse, GameTransport, ExecuteOpts, ConnectionHealthMetrics, GameEvent } from "./game-transport.js";
import type { MockModeConfig, MockInitialState } from "../config.js";
import { createLogger } from "../lib/logger.js";
import { CircuitBreaker } from "./circuit-breaker.js";

const log = createLogger("mock");

const __dirname = dirname(fileURLToPath(import.meta.url));

// Default responses file location: gantry/examples/mock-responses.json
// Resolved from this file's location (src/proxy/ → ../../.. → gantry root)
// Path: gantry-server/src/proxy/ → 3 levels up → gantry-server/../ → gantry/examples/
const DEFAULT_RESPONSES_FILE = join(__dirname, "../../../examples/mock-responses.json");

interface MockCargoItem {
  item_id: string;
  quantity: number;
}

/** Simulated agent state, mutated as tools are called. */
interface MockAgentState {
  credits: number;
  fuel: number;
  fuelCapacity: number;
  location: string;
  dockedAt: string | null;
  poi: string | null;
  cargo: MockCargoItem[];
  cargoCapacity: number;
  hull: number;
  shield: number;
  tick: number;
  authenticated: boolean;
}

function defaultState(initial?: MockInitialState): MockAgentState {
  // dockedAt: if explicitly null/undefined in initialState, treat as not docked.
  // If initialState itself is absent, default to docked at nexus_station.
  const hasInitial = initial !== undefined;
  const dockedAt = hasInitial
    ? (initial.dockedAt ?? null)
    : "nexus_station";

  return {
    credits: initial?.credits ?? 5000,
    fuel: initial?.fuel ?? 80,
    fuelCapacity: 100,
    location: initial?.location ?? "nexus_core",
    dockedAt,
    poi: dockedAt,
    cargo: (initial?.cargo ?? []).map((c) => ({ ...c })),
    cargoCapacity: 50,
    hull: 100,
    shield: 100,
    tick: 1,
    authenticated: false,
  };
}

function cargoUsed(cargo: MockCargoItem[]): number {
  return cargo.reduce((sum, c) => sum + c.quantity, 0);
}

function addCargo(state: MockAgentState, itemId: string, qty: number): number {
  const used = cargoUsed(state.cargo);
  const available = state.cargoCapacity - used;
  const actual = Math.min(qty, available);
  if (actual <= 0) return 0;
  const existing = state.cargo.find((c) => c.item_id === itemId);
  if (existing) {
    existing.quantity += actual;
  } else {
    state.cargo.push({ item_id: itemId, quantity: actual });
  }
  return actual;
}

function removeCargo(state: MockAgentState, itemId: string, qty: number): number {
  const item = state.cargo.find((c) => c.item_id === itemId);
  if (!item) return 0;
  const actual = Math.min(qty, item.quantity);
  item.quantity -= actual;
  state.cargo = state.cargo.filter((c) => c.quantity > 0);
  return actual;
}

/**
 * MockGameClient — same public interface as GameClient, no WebSocket.
 *
 * Implements the subset of GameClient used by session-manager and handlers:
 *   execute(), login(), logout(), waitForTick(), refreshStatus()
 *   getCredentials(), restoreCredentials(), close()
 *   hasSocksProxy, label, onEvent, onStateUpdate, onReconnect, lastArrivalTick
 */
export class MockGameClient implements GameTransport {
  readonly wsUrl: string = "mock://offline";
  label = "unknown";
  credentialsPath?: string;

  // Stub circuit breaker — always allows, never trips.
  readonly breaker: CircuitBreaker = new CircuitBreaker();

  /** Check if the game client has an active authenticated session. */
  isAuthenticated(): boolean {
    return this.state.authenticated;
  }

  /** Called for every non-internal push event (not used in mock — kept for interface compat). */
  onEvent: ((event: GameEvent) => void) | null = null;
  /** Called with fresh status data after waitForTick(). */
  onStateUpdate: ((data: Record<string, unknown>) => void) | null = null;
  /** Called after reconnect (no-op in mock). */
  onReconnect: (() => void) | null = null;
  /** Arrival tick for deferred nav (always null in mock — jumps complete instantly). */
  lastArrivalTick: number | null = null;
  /** Last seen game tick from any server message. */
  private lastSeenTick: number | null = 1;
  private arrivalListeners: Array<() => void> = [];
  private tickListeners: Array<(tick: number) => void> = [];

  get hasSocksProxy(): boolean {
    return false;
  }

  private credentials: { username: string; password: string } | null = null;
  private state: MockAgentState;
  private cannedResponses: Record<string, unknown>;
  private tickIntervalMs: number;

  constructor(private config: MockModeConfig) {
    this.state = defaultState(config.initialState);
    this.tickIntervalMs = config.tickIntervalMs ?? 500;
    this.cannedResponses = this.loadResponses();
  }

  private log(msg: string): void {
    log.info(`[${this.label}] [mock] ${msg}`);
  }

  private loadResponses(): Record<string, unknown> {
    const candidates: string[] = [];

    if (this.config.responsesFile) {
      candidates.push(this.config.responsesFile);
    }
    candidates.push(DEFAULT_RESPONSES_FILE);

    for (const path of candidates) {
      if (existsSync(path)) {
        try {
          return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
        } catch (err) {
          log.warn(`[mock] Failed to load responses from ${path}: ${err}`);
        }
      }
    }

    this.log("No mock-responses.json found — using built-in defaults only");
    return {};
  }

  private getCannedResponse(action: string): Record<string, unknown> | null {
    const raw = this.cannedResponses[action];
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
    return null;
  }

  private getDefaultResponse(): Record<string, unknown> {
    const d = this.getCannedResponse("default");
    return d ?? { status: "ok", message: "Mock response: action completed successfully." };
  }

  getCredentials(): { username: string; password: string } | null {
    return this.credentials;
  }

  restoreCredentials(credentials: { username: string; password: string }): void {
    this.credentials = credentials;
    this.state.authenticated = true;
    this.log(`restored credentials for ${credentials.username}`);
  }

  async login(username: string, password: string): Promise<GameResponse> {
    this.credentials = { username, password };
    this.state.authenticated = true;
    this.log(`login: ${username} (mock)`);

    const canned = this.getCannedResponse("login");
    const base = canned ?? {
      status: "ok",
      session_id: "mock-session-001",
      username,
      credits: this.state.credits,
      location: this.state.location,
      home_system: this.state.location,
      session_handoff: {
        location: this.state.location,
        credits: this.state.credits,
        fuel: this.state.fuel,
        cargo: this.state.cargo,
        cargo_used: cargoUsed(this.state.cargo),
        cargo_capacity: this.state.cargoCapacity,
      },
    };

    return { result: base };
  }

  async logout(): Promise<GameResponse> {
    this.log("logout (mock)");
    this.credentials = null;
    this.state.authenticated = false;

    const canned = this.getCannedResponse("logout");
    return { result: canned ?? { status: "ok", message: "Session ended." } };
  }

  /**
   * Execute a game command. Routes to the appropriate handler or falls back
   * to the canned default response.
   */
  async execute(command: string, payload?: Record<string, unknown>, _opts?: ExecuteOpts): Promise<GameResponse> {
    if (!this.state.authenticated) {
      return { error: { code: "not_authenticated", message: "Not authenticated. Call login first." } };
    }

    this.log(`execute: ${command}`);

    const result = this.dispatchCommand(command, payload ?? {});
    return { result };
  }

  /**
   * Refresh status — returns the current simulated state.
   * Mirrors the GameClient.refreshStatus() contract.
   */
  async refreshStatus(): Promise<Record<string, unknown> | null> {
    if (!this.state.authenticated) return null;
    return this.buildStatusSnapshot();
  }

  /**
   * Wait for a simulated game tick change.
   */
  async waitForTick(timeoutMs = 15000): Promise<void> {
    const beforeTick = this.lastSeenTick;
    
    // Simulate a tick change after a small delay
    setTimeout(() => {
      this.state.tick++;
      this.lastSeenTick = this.state.tick;
      for (const listener of this.tickListeners) listener(this.state.tick);
    }, this.tickIntervalMs);

    await this.waitForNextTick(beforeTick, timeoutMs);
    const data = this.buildStatusSnapshot();
    this.onStateUpdate?.(data);
  }

  /**
   * Wait for the game tick to increment.
   */
  async waitForNextTick(beforeTick: number | null, timeoutMs = 15000): Promise<boolean> {
    if (this.lastSeenTick !== null && beforeTick !== null && this.lastSeenTick > beforeTick) {
      return true;
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.tickListeners.indexOf(listener);
        if (idx >= 0) this.tickListeners.splice(idx, 1);
        resolve(false);
      }, timeoutMs);
      const listener = (newTick: number) => {
        if (beforeTick === null || newTick > beforeTick) {
          clearTimeout(timer);
          const idx = this.tickListeners.indexOf(listener);
          if (idx >= 0) this.tickListeners.splice(idx, 1);
          resolve(true);
        }
      };
      this.tickListeners.push(listener);
    });
  }

  /**
   * Wait until the game tick reaches or exceeds a target tick value.
   */
  async waitForTickToReach(targetTick: number, timeoutMs = 60000): Promise<boolean> {
    if (this.lastSeenTick !== null && this.lastSeenTick >= targetTick) return true;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.tickListeners.indexOf(listener);
        if (idx >= 0) this.tickListeners.splice(idx, 1);
        resolve(false);
      }, timeoutMs);
      const listener = (newTick: number) => {
        if (newTick >= targetTick) {
          clearTimeout(timer);
          const idx = this.tickListeners.indexOf(listener);
          if (idx >= 0) this.tickListeners.splice(idx, 1);
          resolve(true);
        }
      };
      this.tickListeners.push(listener);
    });
  }

  /**
   * Wait for the next arrival (deferred nav completion).
   */
  async waitForNextArrival(beforeTick: number | null, timeoutMs = 20000): Promise<boolean> {
    if (this.lastArrivalTick !== null && this.lastArrivalTick !== beforeTick) {
      return true;
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.arrivalListeners.indexOf(listener);
        if (idx >= 0) this.arrivalListeners.splice(idx, 1);
        resolve(false);
      }, timeoutMs);
      const listener = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.arrivalListeners.push(listener);
    });
  }

  /** Get connection health metrics (all zeroed for mock). */
  getConnectionHealth(): ConnectionHealthMetrics {
    return {
      rapidDisconnects: 0,
      reconnectsPerMinute: 0,
      totalReconnects: 0,
      lastConnectedAt: 0,
      connectionDurationMs: null,
    };
  }

  /** Close the mock client (no-op — nothing to tear down). */
  async close(): Promise<void> {
    this.state.authenticated = false;
    this.credentials = null;
  }

  // ---------------------------------------------------------------------------
  // Command dispatch
  // ---------------------------------------------------------------------------

  private dispatchCommand(command: string, payload: Record<string, unknown>): Record<string, unknown> {
    switch (command) {
      case "get_status":   return this.buildStatusSnapshot();
      case "get_credits":  return this.handleGetCredits();
      case "get_fuel":     return this.handleGetFuel();
      case "get_location": return this.handleGetLocation();
      case "get_cargo":    return this.handleGetCargo();
      case "get_cargo_summary": return this.handleGetCargoSummary();
      case "get_system":   return this.handleGetSystem(payload);
      case "travel_to":    return this.handleTravelTo(payload);
      case "mine":         return this.handleMine(payload);
      case "batch_mine":   return this.handleBatchMine(payload);
      case "scan":         return this.handleScan();
      case "analyze_market": return this.handleAnalyzeMarket();
      case "multi_sell":   return this.handleMultiSell(payload);
      case "refuel":       return this.handleRefuel(payload);
      case "craft":        return this.handleCraft(payload);
      case "get_missions": return this.handleGetMissions();
      case "captains_log_list":  return this.handleCaptainsLogList();
      case "captains_log_add":   return this.handleCaptainsLogAdd();
      case "read_doc":     return this.handleReadDoc();
      case "write_diary":  return this.handleWriteDiary();
      case "write_doc":    return this.handleWriteDoc();
      // Tier-2 stateful handlers (Batch 10)
      case "jump":              return this.handleJump(payload);
      case "dock":              return this.handleDock(payload);
      case "undock":            return this.handleUndock();
      case "sell":              return this.handleSell(payload);
      case "buy":               return this.handleBuy(payload);
      case "repair":            return this.handleRepair(payload);
      case "get_notifications": return this.handleGetNotifications();
      case "view_market":       return this.handleViewMarket();
      case "view_storage":      return this.handleViewStorage();
      default:             return this.handleDefault(command);
    }
  }

  // ---------------------------------------------------------------------------
  // Status handlers — reflect simulated state
  // ---------------------------------------------------------------------------

  private buildStatusSnapshot(): Record<string, unknown> {
    return {
      status: "ok",
      location: this.state.location,
      docked_at_base: this.state.dockedAt,
      credits: this.state.credits,
      fuel: this.state.fuel,
      fuel_capacity: this.state.fuelCapacity,
      hull: this.state.hull,
      shield: this.state.shield,
      cargo: [...this.state.cargo],
      cargo_used: cargoUsed(this.state.cargo),
      cargo_capacity: this.state.cargoCapacity,
    };
  }

  private handleGetCredits(): Record<string, unknown> {
    return { status: "ok", credits: this.state.credits };
  }

  private handleGetFuel(): Record<string, unknown> {
    return { status: "ok", fuel: this.state.fuel, fuel_capacity: this.state.fuelCapacity };
  }

  private handleGetLocation(): Record<string, unknown> {
    return {
      status: "ok",
      location: this.state.location,
      docked_at_base: this.state.dockedAt,
      poi: this.state.poi,
    };
  }

  private handleGetCargo(): Record<string, unknown> {
    return {
      status: "ok",
      cargo: [...this.state.cargo],
      cargo_used: cargoUsed(this.state.cargo),
      cargo_capacity: this.state.cargoCapacity,
    };
  }

  private handleGetCargoSummary(): Record<string, unknown> {
    return {
      status: "ok",
      cargo_used: cargoUsed(this.state.cargo),
      cargo_capacity: this.state.cargoCapacity,
      items: [...this.state.cargo],
    };
  }

  private handleGetSystem(payload: Record<string, unknown>): Record<string, unknown> {
    const systemId = (payload.target_system as string | undefined) ?? this.state.location;
    const canned = this.getCannedResponse("get_system");
    if (canned) {
      const result = { ...canned };
      // Patch system id when canned response has a different one
      if (typeof result.system === "object" && result.system !== null) {
        (result.system as Record<string, unknown>).id = systemId;
      }
      return result;
    }
    return {
      status: "ok",
      system: {
        id: systemId,
        name: systemId.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        faction: "solarian",
        description: `Mock system: ${systemId}`,
        pois: [
          { id: `${systemId}_station`, name: "Station", type: "station", description: "Trading hub." },
          { id: `${systemId}_belt`, name: "Belt", type: "harvester_belt", description: "Asteroid belt." },
        ],
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  private handleTravelTo(payload: Record<string, unknown>): Record<string, unknown> {
    const targetPoi = (payload.target_poi as string | undefined) ?? "nexus_belt_alpha";
    const isStation = targetPoi.includes("station") || targetPoi.includes("hub");

    this.state.fuel = Math.max(0, this.state.fuel - 8);
    this.state.poi = targetPoi;
    this.state.dockedAt = isStation ? targetPoi : null;
    this.state.tick++;

    const responseKey = isStation ? "travel_to_station" : "travel_to";
    const canned = this.getCannedResponse(responseKey);
    if (canned) {
      return {
        ...canned,
        poi: targetPoi,
        docked_at_base: this.state.dockedAt,
        fuel: this.state.fuel,
        tick: this.state.tick,
      };
    }

    return {
      status: "completed",
      location: this.state.location,
      poi: targetPoi,
      docked_at_base: this.state.dockedAt,
      fuel: this.state.fuel,
      tick: this.state.tick,
    };
  }

  // ---------------------------------------------------------------------------
  // Mining
  // ---------------------------------------------------------------------------

  private handleMine(_payload: Record<string, unknown>): Record<string, unknown> {
    const oreExtracted = Math.floor(Math.random() * 4) + 1; // 1-4
    const itemId = "iron_ore";
    const actual = addCargo(this.state, itemId, oreExtracted);

    if (actual === 0) {
      return { status: "error", error: { code: "cargo_full", message: "Cargo is full." } };
    }

    return {
      status: "ok",
      ore_extracted: actual,
      item_id: itemId,
      xp_gained: actual * 3,
      cargo_after: {
        cargo_used: cargoUsed(this.state.cargo),
        cargo_capacity: this.state.cargoCapacity,
      },
    };
  }

  private handleBatchMine(payload: Record<string, unknown>): Record<string, unknown> {
    const count = typeof payload.count === "number" ? payload.count : 20;
    const itemId = "iron_ore";
    let totalOre = 0;
    let minesCompleted = 0;
    let stoppedReason = "count_reached";

    for (let i = 0; i < count; i++) {
      const ore = Math.floor(Math.random() * 3) + 1;
      const actual = addCargo(this.state, itemId, ore);
      if (actual === 0) {
        stoppedReason = "cargo_full";
        break;
      }
      totalOre += actual;
      minesCompleted++;
    }

    return {
      status: "completed",
      mines_completed: minesCompleted,
      ore_extracted: totalOre,
      item_id: itemId,
      xp_gained: minesCompleted * 9,
      stopped_reason: stoppedReason,
      cargo_after: {
        cargo_used: cargoUsed(this.state.cargo),
        cargo_capacity: this.state.cargoCapacity,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Combat / scan
  // ---------------------------------------------------------------------------

  private handleScan(): Record<string, unknown> {
    const canned = this.getCannedResponse("scan");
    return canned ?? {
      status: "ok",
      targets: [
        { id: "npc-drone-001", name: "Rogue Drone", type: "npc", hull: 60, threat: "low", distance: "outer" },
      ],
    };
  }

  // ---------------------------------------------------------------------------
  // Market / economy
  // ---------------------------------------------------------------------------

  private handleAnalyzeMarket(): Record<string, unknown> {
    const canned = this.getCannedResponse("analyze_market");
    return canned ?? {
      status: "ok",
      recommendations: [
        { item_id: "iron_ore", action: "sell", reason: "Demand high at this station.", estimated_value: 12, quantity_demanded: 100 },
      ],
      station_id: this.state.dockedAt ?? "unknown",
      market_skill_level: 1,
    };
  }

  private handleMultiSell(payload: Record<string, unknown>): Record<string, unknown> {
    if (!this.state.dockedAt) {
      return { status: "error", error: { code: "not_docked", message: "Must be docked at a station to sell." } };
    }

    type SellItem = { item_id: string; quantity: number };
    const items = Array.isArray(payload.items) ? (payload.items as SellItem[]) : [];
    const PRICE_TABLE: Record<string, number> = { iron_ore: 12, steel_plate: 45, copper_ore: 10 };
    const DEFAULT_PRICE = 8;

    let totalCredits = 0;
    const sold: Array<{ item_id: string; quantity: number; price_per_unit: number; total_credits: number }> = [];

    for (const item of items) {
      const qty = removeCargo(this.state, item.item_id, item.quantity);
      if (qty > 0) {
        const price = PRICE_TABLE[item.item_id] ?? DEFAULT_PRICE;
        const earned = qty * price;
        totalCredits += earned;
        sold.push({ item_id: item.item_id, quantity: qty, price_per_unit: price, total_credits: earned });
      }
    }

    this.state.credits += totalCredits;
    this.state.tick++;

    return {
      status: "completed",
      sold,
      credits_after: this.state.credits,
      tick: this.state.tick,
    };
  }

  private handleRefuel(payload: Record<string, unknown>): Record<string, unknown> {
    if (!this.state.dockedAt) {
      return { status: "error", error: { code: "not_docked", message: "Must be docked at a station to refuel." } };
    }

    const fuelNeeded = this.state.fuelCapacity - this.state.fuel;
    const amount = typeof payload.amount === "number"
      ? Math.min(payload.amount, fuelNeeded)
      : fuelNeeded;
    const FUEL_PRICE_PER_UNIT = 2;
    const cost = Math.ceil(amount * FUEL_PRICE_PER_UNIT);

    const fuelBefore = this.state.fuel;
    this.state.fuel = Math.min(this.state.fuelCapacity, this.state.fuel + amount);
    this.state.credits = Math.max(0, this.state.credits - cost);

    return {
      status: "ok",
      fuel_before: fuelBefore,
      fuel_after: this.state.fuel,
      credits_spent: cost,
      credits_after: this.state.credits,
    };
  }

  // ---------------------------------------------------------------------------
  // Crafting
  // ---------------------------------------------------------------------------

  private handleCraft(payload: Record<string, unknown>): Record<string, unknown> {
    if (!this.state.dockedAt) {
      return { status: "error", error: { code: "not_docked", message: "Must be docked at a station to craft." } };
    }

    const recipeId = (payload.recipe_id as string | undefined) ?? "basic_crafting";
    const quantity = typeof payload.quantity === "number" ? payload.quantity : 1;

    // Simulate: crafting consumes iron_ore → steel_plate (2:1)
    const inputRemoved = removeCargo(this.state, "iron_ore", quantity * 2);
    if (inputRemoved === 0) {
      return { status: "error", error: { code: "missing_materials", message: "Not enough iron_ore to craft." } };
    }

    // Map recipe IDs to output items
    const RECIPE_OUTPUT: Record<string, string> = { basic_crafting: "steel_plate", refine_steel: "steel_plate" };
    const outputItem = RECIPE_OUTPUT[recipeId] ?? "steel_plate";
    const actualQty = Math.floor(inputRemoved / 2);
    addCargo(this.state, outputItem, actualQty);

    return {
      status: "ok",
      recipe_id: recipeId,
      quantity_crafted: actualQty,
      item_id: outputItem,
      cargo_after: {
        cargo_used: cargoUsed(this.state.cargo),
        cargo_capacity: this.state.cargoCapacity,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Missions / docs / diary — mostly canned or no-ops
  // ---------------------------------------------------------------------------

  private handleGetMissions(): Record<string, unknown> {
    return this.getCannedResponse("get_missions") ?? {
      status: "ok",
      missions: [],
    };
  }

  private handleCaptainsLogList(): Record<string, unknown> {
    return this.getCannedResponse("captains_log_list") ?? { status: "ok", entries: [] };
  }

  private handleCaptainsLogAdd(): Record<string, unknown> {
    return this.getCannedResponse("captains_log_add") ?? { status: "ok", id: `log-mock-${this.state.tick}` };
  }

  private handleReadDoc(): Record<string, unknown> {
    return this.getCannedResponse("read_doc") ?? { status: "ok", title: "strategy", content: "" };
  }

  private handleWriteDiary(): Record<string, unknown> {
    return this.getCannedResponse("write_diary") ?? { status: "ok", id: `diary-mock-${this.state.tick}` };
  }

  private handleWriteDoc(): Record<string, unknown> {
    return this.getCannedResponse("write_doc") ?? { status: "ok" };
  }

  // ---------------------------------------------------------------------------
  // Tier-2 stateful handlers (Batch 10)
  // ---------------------------------------------------------------------------

  /**
   * jump — move to a different star system.
   * Accepts any target_system without validating adjacency (no galaxy graph in Tier 2).
   * Deducts a fixed 10-unit fuel cost.
   */
  private handleJump(payload: Record<string, unknown>): Record<string, unknown> {
    const targetSystem = (payload.target_system as string | undefined) ?? "kepler_sector";
    const FUEL_COST = 10;

    if (this.state.fuel < FUEL_COST) {
      return { status: "error", error: { code: "insufficient_fuel", message: `Not enough fuel. Need ${FUEL_COST}, have ${this.state.fuel}.` } };
    }

    const prevSystem = this.state.location;
    this.state.location = targetSystem;
    this.state.fuel -= FUEL_COST;
    this.state.dockedAt = null;
    this.state.poi = null;
    this.state.tick++;

    this.log(`jump: ${prevSystem} → ${targetSystem} (fuel: ${this.state.fuel})`);
    return {
      status: "completed",
      system: targetSystem,
      fuel: this.state.fuel,
      tick: this.state.tick,
    };
  }

  /**
   * dock — dock at a station/POI in the current system.
   * Sets dockedAt and poi.
   */
  private handleDock(payload: Record<string, unknown>): Record<string, unknown> {
    const stationId = (payload.station_id as string | undefined) ?? `${this.state.location}_station`;

    this.state.dockedAt = stationId;
    this.state.poi = stationId;
    this.state.tick++;

    this.log(`dock: ${stationId}`);
    return {
      status: "docked",
      station_id: stationId,
      tick: this.state.tick,
    };
  }

  /**
   * undock — leave the current station.
   * Clears dockedAt; agent is now in space within the system.
   */
  private handleUndock(): Record<string, unknown> {
    const prevStation = this.state.dockedAt;
    this.state.dockedAt = null;
    this.state.tick++;

    this.log(`undock: left ${prevStation}`);
    return {
      status: "undocked",
      location: this.state.location,
      tick: this.state.tick,
    };
  }

  /**
   * sell — single-item sell (complement to multi_sell).
   * Deducts from cargo and adds credits at canned price.
   */
  private handleSell(payload: Record<string, unknown>): Record<string, unknown> {
    if (!this.state.dockedAt) {
      return { status: "error", error: { code: "not_docked", message: "Must be docked at a station to sell." } };
    }

    const itemId = (payload.item_id as string | undefined) ?? "";
    const qty = typeof payload.quantity === "number" ? payload.quantity : 1;

    if (!itemId) {
      return { status: "error", error: { code: "missing_item_id", message: "item_id is required." } };
    }

    const PRICE_TABLE: Record<string, number> = { iron_ore: 12, steel_plate: 45, copper_ore: 10 };
    const price = PRICE_TABLE[itemId] ?? 8;
    const actual = removeCargo(this.state, itemId, qty);

    if (actual === 0) {
      return { status: "error", error: { code: "item_not_in_cargo", message: `${itemId} not found in cargo.` } };
    }

    const earned = actual * price;
    this.state.credits += earned;
    this.state.tick++;

    return {
      status: "sold",
      item_id: itemId,
      quantity: actual,
      price_per_unit: price,
      credits_earned: earned,
      credits: this.state.credits,
      tick: this.state.tick,
    };
  }

  /**
   * buy — purchase an item at the current station.
   * Deducts credits and adds to cargo.
   */
  private handleBuy(payload: Record<string, unknown>): Record<string, unknown> {
    if (!this.state.dockedAt) {
      return { status: "error", error: { code: "not_docked", message: "Must be docked at a station to buy." } };
    }

    const itemId = (payload.item_id as string | undefined) ?? "";
    const qty = typeof payload.quantity === "number" ? payload.quantity : 1;

    if (!itemId) {
      return { status: "error", error: { code: "missing_item_id", message: "item_id is required." } };
    }

    const PRICE_TABLE: Record<string, number> = { iron_ore: 12, steel_plate: 45, copper_ore: 10, fuel_cell: 5 };
    const price = PRICE_TABLE[itemId] ?? 10;
    const totalCost = qty * price;

    if (this.state.credits < totalCost) {
      return { status: "error", error: { code: "insufficient_credits", message: `Not enough credits. Need ${totalCost}, have ${this.state.credits}.` } };
    }

    const spaceAvailable = this.state.cargoCapacity - cargoUsed(this.state.cargo);
    const actualQty = Math.min(qty, spaceAvailable);
    if (actualQty <= 0) {
      return { status: "error", error: { code: "cargo_full", message: "Cargo is full." } };
    }

    const actualCost = actualQty * price;
    this.state.credits -= actualCost;
    addCargo(this.state, itemId, actualQty);
    this.state.tick++;

    return {
      status: "bought",
      item_id: itemId,
      quantity: actualQty,
      price_per_unit: price,
      credits_spent: actualCost,
      credits: this.state.credits,
      cargo_used: cargoUsed(this.state.cargo),
      cargo_capacity: this.state.cargoCapacity,
      tick: this.state.tick,
    };
  }

  /**
   * repair — restore hull at docked station, costs credits.
   * Uses a fixed rate of 5 credits per hull point.
   */
  private handleRepair(payload: Record<string, unknown>): Record<string, unknown> {
    if (!this.state.dockedAt) {
      return { status: "error", error: { code: "not_docked", message: "Must be docked at a station to repair." } };
    }

    const REPAIR_COST_PER_HP = 5;
    const hullMissing = 100 - this.state.hull;
    if (hullMissing <= 0) {
      return { status: "ok", message: "Hull is already at full integrity.", hull: this.state.hull };
    }

    const requestedHp = typeof payload.amount === "number" ? Math.min(payload.amount, hullMissing) : hullMissing;
    const cost = Math.ceil(requestedHp * REPAIR_COST_PER_HP);

    if (this.state.credits < cost) {
      const affordable = Math.floor(this.state.credits / REPAIR_COST_PER_HP);
      if (affordable <= 0) {
        return { status: "error", error: { code: "insufficient_credits", message: "Not enough credits to repair." } };
      }
      const actualCost = affordable * REPAIR_COST_PER_HP;
      const hullBefore = this.state.hull;
      this.state.hull = Math.min(100, this.state.hull + affordable);
      this.state.credits -= actualCost;
      return {
        status: "repaired",
        hull_before: hullBefore,
        hull_after: this.state.hull,
        credits_spent: actualCost,
        credits: this.state.credits,
      };
    }

    const hullBefore = this.state.hull;
    this.state.hull = Math.min(100, this.state.hull + requestedHp);
    this.state.credits -= cost;

    return {
      status: "repaired",
      hull_before: hullBefore,
      hull_after: this.state.hull,
      credits_spent: cost,
      credits: this.state.credits,
    };
  }

  /**
   * get_notifications — return empty notifications list.
   * Prevents parser errors when agents check for events.
   */
  private handleGetNotifications(): Record<string, unknown> {
    return {
      status: "ok",
      notifications: [],
    };
  }

  /**
   * view_market — return a canned item list for the current station.
   * Uses mock-responses.json if a "view_market" entry exists.
   */
  private handleViewMarket(): Record<string, unknown> {
    const canned = this.getCannedResponse("view_market");
    if (canned) return canned;

    const stationId = this.state.dockedAt ?? `${this.state.location}_station`;
    return {
      status: "ok",
      station_id: stationId,
      items: [
        { item_id: "iron_ore",   name: "Iron Ore",   price_buy: 15, price_sell: 12, quantity_available: 500, demand: "high" },
        { item_id: "steel_plate", name: "Steel Plate", price_buy: 55, price_sell: 45, quantity_available: 200, demand: "high" },
        { item_id: "copper_ore", name: "Copper Ore", price_buy: 14, price_sell: 10, quantity_available: 300, demand: "medium" },
        { item_id: "fuel_cell",  name: "Fuel Cell",  price_buy: 8,  price_sell: 5,  quantity_available: 100, demand: "low" },
      ],
    };
  }

  /**
   * view_storage — return canned storage contents at the current station.
   * Uses mock-responses.json if a "view_storage" entry exists.
   */
  private handleViewStorage(): Record<string, unknown> {
    const canned = this.getCannedResponse("view_storage");
    if (canned) return canned;

    const stationId = this.state.dockedAt ?? `${this.state.location}_station`;
    return {
      status: "ok",
      station_id: stationId,
      items: [],
      storage_used: 0,
      storage_capacity: 100,
    };
  }

  // ---------------------------------------------------------------------------
  // Default fallback
  // ---------------------------------------------------------------------------

  private handleDefault(_command: string): Record<string, unknown> {
    return this.getDefaultResponse();
  }
}
