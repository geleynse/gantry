import type { GameEvent } from "../proxy/event-buffer.js";

interface LoggedEvent {
  agent: string;
  event: GameEvent;
  timestamp: number;
}

export class OverseerEventLog {
  private events: LoggedEvent[] = [];

  constructor(private maxAge: number = 30 * 60 * 1000) {}

  push(agent: string, event: GameEvent): void {
    this.events.push({ agent, event, timestamp: Date.now() });
  }

  since(timestamp: number): LoggedEvent[] {
    return this.events.filter((e) => e.timestamp >= timestamp);
  }

  prune(): void {
    const cutoff = Date.now() - this.maxAge;
    this.events = this.events.filter((e) => e.timestamp >= cutoff);
  }

  get size(): number {
    return this.events.length;
  }
}
