import { createHash, timingSafeEqual } from "node:crypto";
import type { AuthAdapter } from "../types.js";

/**
 * Bearer token auth adapter.
 * Checks Authorization header for a pre-shared secret.
 * Useful for self-hosted setups behind any reverse proxy.
 */
export function createTokenAdapter(config: { token: string }): AuthAdapter {
  if (!config.token) {
    throw new Error("[auth:token] Token must be a non-empty string");
  }

  // Pre-compute hash at init time — avoids per-request Buffer allocation
  // and prevents token length leaking via timing (fixed-length comparison)
  const configHash = createHash("sha256").update(config.token).digest();

  return {
    name: "token",
    async authenticate(req) {
      const header = req.headers.authorization;
      if (!header?.startsWith("Bearer ")) {
        return null; // No token → viewer
      }
      const provided = header.slice(7);
      const providedHash = createHash("sha256").update(provided).digest();
      if (timingSafeEqual(providedHash, configHash)) {
        return { role: "admin", identity: "token" };
      }
      return null; // Wrong token → viewer
    },
  };
}
