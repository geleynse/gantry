import type { AuthAdapter } from "../types.js";
import { createLogger } from "../../../lib/logger.js";

const log = createLogger("auth:loopback");

/**
 * Loopback auth adapter.
 * Grants admin access ONLY to requests from loopback addresses (127.0.0.1, ::1).
 * This is the safest default — only local processes on the same machine can be admin.
 *
 * All other IPs → viewer (public read-only access).
 * Missing IP → viewer (fail-closed for security).
 *
 * Usage:
 * {
 *   "adapter": "loopback"
 * }
 */
export function createLoopbackAdapter(): AuthAdapter {
  const loopbackIps = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

  return {
    name: "loopback",
    async authenticate(req) {
      const ip = req.ip;

      if (!ip) {
        log.warn(
          `Request IP is undefined. remoteAddress: ${req.socket?.remoteAddress}, headers: ${JSON.stringify({
            "x-forwarded-for": req.headers["x-forwarded-for"],
            "x-real-ip": req.headers["x-real-ip"],
          })}`
        );
        return null; // Fail closed: no IP → viewer
      }

      // Check if IP is loopback
      if (loopbackIps.has(ip)) {
        log.debug(`✓ IP ${ip} ALLOWED (loopback)`);
        return {
          role: "admin",
          identity: ip,
        };
      }

      log.debug(`✗ IP ${ip} DENIED (not loopback)`);
      return null; // Not loopback → viewer
    },
  };
}
