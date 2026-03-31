// game-client.ts — game client factory
import { HttpGameClient } from "./http-game-client.js";
import type { MetricsWindow } from "./instability-metrics.js";

export { HttpGameClient } from "./http-game-client.js";
export type { GameResponse, GameTransport, ExecuteOpts, ConnectionHealthMetrics, GameEvent } from "./game-transport.js";

/**
 * Create a game client for connecting to the game server via MCP.
 */
export function createGameClient(
  mcpUrl: string,
  serverMetrics: MetricsWindow,
  socksPort?: number,
): HttpGameClient {
  return new HttpGameClient(mcpUrl, serverMetrics, socksPort);
}
