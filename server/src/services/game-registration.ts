/**
 * Game registration service.
 * Handles creating new player accounts on the spacemolt.com game server.
 */
import { createLogger } from "../lib/logger.js";

const log = createLogger("game-registration");

const GAME_API_BASE = "https://game.spacemolt.com/api/v1";

export interface RegistrationResult {
  playerId: string;
  password: string; // 256-bit password returned by the game server
}

export interface RegistrationError {
  error: string;
}

/**
 * Register a new player account with the game server.
 * Returns the generated password on success.
 */
export async function registerAccount(
  username: string,
  empire: string,
  registrationCode: string
): Promise<RegistrationResult> {
  log.info(`Registering account for "${username}" (Empire: ${empire})`);

  const response = await fetch(`${GAME_API_BASE}/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      username,
      empire,
      registration_code: registrationCode,
    }),
  });

  if (!response.ok) {
    const errorData = await response.json() as any;
    const message = errorData?.error || response.statusText;
    log.error(`Registration failed for "${username}": ${message}`);
    throw new Error(message);
  }

  const data = await response.json() as { player_id: string; password: string };

  if (!data.player_id || !data.password) {
    throw new Error("Invalid response from game server: missing playerId or password");
  }

  log.info(`Successfully registered account for "${username}" (ID: ${data.player_id})`);

  return {
    playerId: data.player_id,
    password: data.password,
  };
}
