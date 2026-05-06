import type { AuthAdapter } from "../types.js";
import { createLocalNetworkAdapter } from "./local-network.js";
import { createCloudflareAccessAdapter } from "./cloudflare-access.js";
import { createLogger } from "../../../lib/logger.js";

const log = createLogger("auth:layered");

interface LayeredConfig {
  localNetworkRanges?: string[]; // IP ranges for local access
  cloudflareTeamDomain?: string; // Cloudflare team domain
  cloudflareAudience?: string; // Cloudflare audience
  adminDomains?: string[]; // accepted but unused — domain auth requires a standalone domain adapter
}

/**
 * Layered auth adapter that tries multiple auth methods.
 * 1. If CF JWT is present → validate it; if valid, return admin
 * 2. Try local network → admin if IP matches allowed ranges
 * 3. Otherwise → viewer
 *
 * Config example:
 * {
 *   "adapter": "layered",
 *   "config": {
 *     "localNetworkRanges": ["192.168.0.0/16", "10.0.0.0/8"],
 *     "cloudflareTeamDomain": "yourteam.cloudflareaccess.com",
 *     "cloudflareAudience": "audience-tag"
 *   }
 * }
 */
export function createLayeredAdapter(config?: LayeredConfig): AuthAdapter {
  // Create local network adapter with provided ranges
  const localAdapter = createLocalNetworkAdapter({
    allowedIpRanges: config?.localNetworkRanges,
  });

  // Create CF adapter if configured (optional)
  let cfAdapter: AuthAdapter | null = null;
  if (config?.cloudflareTeamDomain) {
    cfAdapter = createCloudflareAccessAdapter({
      teamDomain: config.cloudflareTeamDomain,
      audience: config.cloudflareAudience,
    });
  }

  return {
    name: "layered",
    async authenticate(req) {
      const host = req.get("host") || "";
      const hasCfJwt = !!(req.headers["cf-access-jwt-assertion"] || /\bCF_Authorization=/.test(req.headers["cookie"] ?? ""));
      log.debug(`Incoming request | Host: ${host} | IP: ${req.ip} | hasCfJwt: ${hasCfJwt}`);

      // 1. Try Cloudflare first if it looks like a CF request.
      if (hasCfJwt && cfAdapter) {
        log.debug(`Detected Cloudflare JWT, trying Cloudflare Access auth layer`);
        try {
          const cfResult = await cfAdapter.authenticate(req);
          if (cfResult) {
            log.info(`✓ CF Access auth success | adapter=cloudflare-access | identity=${cfResult.identity}`);
            return cfResult;
          }
          log.warn(`CF JWT present but validation failed | host=${host} | adapter=cloudflare-access → falling back`);
        } catch (err) {
          log.warn(`CF adapter threw during auth | host=${host} | err=${err instanceof Error ? err.message : String(err)} → falling back`);
        }
      }

      // 2. Try local network next
      const localResult = await localAdapter.authenticate(req);
      if (localResult) {
        log.debug(`✓ Local network auth success | adapter=local-network | ip=${req.ip}`);
        return localResult;
      }

      // 3. No auth method succeeded → viewer
      log.warn(`✗ All auth layers failed → viewer | host=${host} | ip=${req.ip} | hasCfJwt=${hasCfJwt} | cfAdapter=${!!cfAdapter}`);
      return null;
    },
  };
}
