import type { AuthAdapter } from "../types.js";
import { createLogger } from "../../../lib/logger.js";

const log = createLogger("auth:local-network");

interface LocalNetworkConfig {
  allowedIpRanges?: string[]; // CIDR notation or IP patterns (e.g., "192.168.1.0/24", "10.0.0.0/8", "192.168.*")
}

/**
 * Parse a CIDR range into network and mask.
 * Returns { network: bigint, mask: bigint } or null if invalid.
 */
function parseCidr(cidr: string): { network: bigint; mask: bigint } | null {
  const [ip, bits] = cidr.split("/");
  if (!ip || !bits) return null;

  const bitCount = parseInt(bits, 10);
  if (isNaN(bitCount) || bitCount < 0 || bitCount > 32) return null;

  const parts = ip.split(".");
  if (parts.length !== 4) return null;

  let network = 0n;
  for (const part of parts) {
    const num = parseInt(part, 10);
    if (isNaN(num) || num < 0 || num > 255) return null;
    network = (network << 8n) | BigInt(num);
  }

  // Create mask: 32 - bitCount ones, followed by zeros
  const mask = ((1n << BigInt(bitCount)) - 1n) << BigInt(32 - bitCount);

  return { network, mask };
}

/**
 * Parse a simple IP pattern like "192.168.*" into CIDR.
 */
function parsePattern(pattern: string): { network: bigint; mask: bigint } | null {
  const parts = pattern.split(".");

  let network = 0n;
  let wildcardPosition = -1;

  for (let i = 0; i < Math.min(parts.length, 4); i++) {
    const part = parts[i];
    if (part === "*" || part === "") {
      wildcardPosition = i;
      break;
    }
    const num = parseInt(part, 10);
    if (isNaN(num) || num < 0 || num > 255) return null;
    network = (network << 8n) | BigInt(num);
  }

  if (wildcardPosition === -1) return null; // No wildcard found

  const wildcardCount = 4 - wildcardPosition;

  // Shift left to account for missing octets
  network = network << BigInt(8 * wildcardCount);

  // Create mask: the non-wildcard parts
  const significantBits = (4 - wildcardCount) * 8;
  const mask = significantBits > 0
    ? (((1n << BigInt(significantBits)) - 1n) << BigInt(8 * wildcardCount))
    : 0n;

  return { network, mask };
}

/**
 * Convert IP address string to bigint.
 */
function ipToBigint(ip: string): bigint | null {
  // Handle IPv6 mapped IPv4 (::ffff:192.168.1.1)
  if (ip.includes("::ffff:")) {
    ip = ip.replace("::ffff:", "");
  }

  // Only support IPv4 for now
  if (ip.includes(":")) {
    return null;
  }

  const parts = ip.split(".");
  if (parts.length !== 4) return null;

  let result = 0n;
  for (const part of parts) {
    const num = parseInt(part, 10);
    if (isNaN(num) || num < 0 || num > 255) return null;
    result = (result << 8n) | BigInt(num);
  }

  return result;
}

/**
 * Check if an IP is in a CIDR range.
 */
function ipInRange(ip: string, network: bigint, mask: bigint): boolean {
  const ipNum = ipToBigint(ip);
  if (ipNum === null) return false;
  return (ipNum & mask) === (network & mask);
}

/**
 * Local network auth adapter.
 * Grants admin access to requests from allowed IP ranges.
 * Useful for accessing admin interface from local network without Cloudflare.
 *
 * Config example:
 * {
 *   "adapter": "local-network",
 *   "config": {
 *     "allowedIpRanges": ["192.168.0.0/16", "10.0.0.0/8", "172.16.0.0/12"]
 *   }
 * }
 *
 * Or with simple patterns:
 * {
 *   "allowedIpRanges": ["192.168.*", "10.*"]
 * }
 */
export function createLocalNetworkAdapter(config?: LocalNetworkConfig): AuthAdapter {
  const ranges = config?.allowedIpRanges || ["127.0.0.1/32", "192.168.0.0/16", "10.0.0.0/8", "172.16.0.0/12"];

  // Parse all ranges at init time
  const parsedRanges: Array<{ network: bigint; mask: bigint }> = [];

  for (const range of ranges) {
    let parsed: { network: bigint; mask: bigint } | null = null;

    // Try CIDR notation first
    if (range.includes("/")) {
      parsed = parseCidr(range);
    } else if (range.includes("*")) {
      // Try pattern notation
      parsed = parsePattern(range);
    } else {
      // Single IP
      parsed = parseCidr(`${range}/32`);
    }

    if (parsed) {
      parsedRanges.push(parsed);
    } else {
      log.warn(`Invalid IP range: ${range}`);
    }
  }

  return {
    name: "local-network",
    async authenticate(req) {
      const ip = req.ip;

      // Log for debugging
      if (!ip) {
        log.warn(
          `Request IP is undefined. remoteAddress: ${req.socket?.remoteAddress}, headers: ${JSON.stringify({
            "x-forwarded-for": req.headers["x-forwarded-for"],
            "x-real-ip": req.headers["x-real-ip"],
          })}`
        );
        return null;
      }

      // Check if IP is in any allowed range
      for (const { network, mask } of parsedRanges) {
        if (ipInRange(ip, network, mask)) {
          log.debug(`✓ IP ${ip} ALLOWED`);
          return {
            role: "admin",
            identity: ip,
          };
        }
      }

      log.debug(`✗ IP ${ip} DENIED (not in ranges)`);
      return null; // IP not in allowed ranges → viewer
    },
  };
}
