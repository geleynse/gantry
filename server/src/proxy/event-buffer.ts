export enum EventPriority {
  Critical = "critical",
  Normal = "normal",
  Internal = "internal",
}

export interface GameEvent {
  type: string;
  payload: unknown;
  receivedAt: number;
}

const CRITICAL_TYPES = new Set([
  "combat_update",
  "player_died",
  "trade_offer_received",
  "scan_detected",
  "police_warning",
  "pirate_warning",
  "pirate_combat",
  "respawn_state",
]);

const INTERNAL_TYPES = new Set([
  "tick",
  "state_update",
  "welcome",
  "logged_in",
  "action_error",
]);

export function categorizeEvent(type: string): EventPriority {
  if (CRITICAL_TYPES.has(type)) return EventPriority.Critical;
  if (INTERNAL_TYPES.has(type)) return EventPriority.Internal;
  return EventPriority.Normal;
}

const DEFAULT_CAPACITY = 200;

/**
 * Ring buffer for game events. Uses a fixed-size array with head/tail pointers
 * so that overflow eviction is O(1) instead of O(n) Array.shift().
 */
export class EventBuffer {
  private buf: (GameEvent | undefined)[];
  private head = 0; // index of oldest element
  private tail = 0; // index of next write slot
  private count = 0;
  private readonly capacity: number;

  constructor(capacity = DEFAULT_CAPACITY) {
    this.capacity = capacity;
    // Allocate one extra slot to distinguish full from empty
    this.buf = new Array(capacity + 1);
  }

  get size(): number {
    return this.count;
  }

  push(event: GameEvent): void {
    if (categorizeEvent(event.type) === EventPriority.Internal) return;

    if (this.count === this.capacity) {
      // Overwrite oldest — advance head
      this.buf[this.tail] = event;
      this.tail = (this.tail + 1) % this.buf.length;
      this.head = (this.head + 1) % this.buf.length;
      // count stays the same
    } else {
      this.buf[this.tail] = event;
      this.tail = (this.tail + 1) % this.buf.length;
      this.count++;
    }
  }

  /** Drain events, optionally filtered by types and capped by limit.
   *  Excess events beyond limit stay in the buffer. */
  drain(types?: string[], limit?: number): GameEvent[] {
    if (!types) {
      if (!limit || this.count <= limit) {
        const all = this.toArray();
        this.clear();
        return all;
      }
      // Return first `limit` events, keep the rest
      const returned: GameEvent[] = [];
      for (let i = 0; i < limit; i++) {
        returned.push(this.buf[this.head]!);
        this.buf[this.head] = undefined;
        this.head = (this.head + 1) % this.buf.length;
        this.count--;
      }
      return returned;
    }

    const typeSet = new Set(types);
    const matching: GameEvent[] = [];
    const remaining: GameEvent[] = [];
    const len = this.count;
    let idx = this.head;
    for (let i = 0; i < len; i++) {
      const e = this.buf[idx]!;
      if (typeSet.has(e.type) && (!limit || matching.length < limit)) {
        matching.push(e);
      } else {
        remaining.push(e);
      }
      idx = (idx + 1) % this.buf.length;
    }
    this.rebuildFrom(remaining);
    return matching;
  }

  /** Drain only critical-priority events, leaving normal events in the buffer. */
  drainCritical(): GameEvent[] {
    const critical: GameEvent[] = [];
    const rest: GameEvent[] = [];
    const len = this.count;
    let idx = this.head;
    for (let i = 0; i < len; i++) {
      const e = this.buf[idx]!;
      if (categorizeEvent(e.type) === EventPriority.Critical) critical.push(e);
      else rest.push(e);
      idx = (idx + 1) % this.buf.length;
    }
    this.rebuildFrom(rest);
    return critical;
  }

  /**
   * Find the first event matching the predicate and remove it from the buffer.
   * Returns the event if found, or undefined if not.
   */
  findAndRemove(predicate: (event: GameEvent) => boolean): GameEvent | undefined {
    const len = this.count;
    let idx = this.head;
    for (let i = 0; i < len; i++) {
      const e = this.buf[idx]!;
      if (predicate(e)) {
        // Remove this single element by rebuilding around it
        const remaining: GameEvent[] = [];
        let idx2 = this.head;
        for (let j = 0; j < len; j++) {
          if (j !== i) remaining.push(this.buf[idx2]!);
          idx2 = (idx2 + 1) % this.buf.length;
        }
        this.rebuildFrom(remaining);
        return e;
      }
      idx = (idx + 1) % this.buf.length;
    }
    return undefined;
  }

  /**
   * Check if the buffer contains any events matching the given types.
   * Does not remove events from the buffer.
   */
  hasEventOfType(types: string[]): boolean {
    const typeSet = new Set(types);
    const len = this.count;
    let idx = this.head;
    for (let i = 0; i < len; i++) {
      if (typeSet.has(this.buf[idx]!.type)) return true;
      idx = (idx + 1) % this.buf.length;
    }
    return false;
  }

  pushReconnectMarker(): void {
    this.push({
      type: "_reconnected",
      payload: { message: "WebSocket reconnected — some events may have been missed" },
      receivedAt: Date.now(),
    });
  }

  /** Read all events in order without modifying the buffer. */
  private toArray(): GameEvent[] {
    const result: GameEvent[] = [];
    let idx = this.head;
    for (let i = 0; i < this.count; i++) {
      result.push(this.buf[idx]!);
      idx = (idx + 1) % this.buf.length;
    }
    return result;
  }

  private clear(): void {
    this.buf = new Array(this.capacity + 1);
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }

  /** Replace buffer contents with the given events array. */
  private rebuildFrom(events: GameEvent[]): void {
    this.buf = new Array(this.capacity + 1);
    this.head = 0;
    this.count = events.length;
    this.tail = events.length % this.buf.length;
    for (let i = 0; i < events.length; i++) {
      this.buf[i] = events[i];
    }
  }
}
