import type { AuthAdapter } from "../types.js";
import { createLocalNetworkAdapter } from "./local-network.js";
import { createCloudflareAccessAdapter } from "./cloudflare-access.js";
import { createDomainAdapter } from "./domain.js";
import { createLogger } from "../../../lib/logger.js";

const log = createLogger("auth:layered");

interface LayeredConfig {
  localNetworkRanges?: string[]; // IP ranges for local access
  cloudflareTeamDomain?: string; // Cloudflare team domain
  cloudflareAudience?: string; // Cloudflare audience
  adminDomains?: string[]; // Domains that grant admin access
}

/**
 * Layered auth adapter that tries multiple auth methods.
 * 1. If CF JWT is present → validate it; if valid, return admin (domain adapter runs as routing annotation only)
 * 2. Try local network → admin if IP matches allowed ranges
 * 3. Otherwise → viewer
 *
 * SECURITY: adminDomains only take effect when combined with a valid CF Access JWT.
 * The Host header is client-supplied and spoofable — domain matching alone MUST NOT
 * grant admin. CF Access is the identity signal; domain is routing context only.
 *
 * Config example:
 * {
 *   "adapter": "layered",
 *   "config": {
 *     "localNetworkRanges": ["192.168.0.0/16", "10.0.0.0/8"],
 *     "cloudflareTeamDomain": "yourteam.cloudflareaccess.com",
 *     "cloudflareAudience": "audience-tag",
 *     "adminDomains": ["admin.example.com"]
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

  // Create Domain adapter if configured (optional)
  let domainAdapter: AuthAdapter | null = null;
  if (config?.adminDomains) {
    domainAdapter = createDomainAdapter({
      adminDomains: config.adminDomains,
    });
  }

  return {
    name: "layered",
    async authenticate(req) {
      const host = req.get("host") || "";
      const hasCfJwt = !!(req.headers["cf-access-jwt-assertion"] || /\bCF_Authorization=/.test(req.headers["cookie"] ?? ""));
      log.debug(`Incoming request | Host: ${host} | IP: ${req.ip} | hasCfJwt: ${hasCfJwt}`);

      // 1. Try Cloudflare first if it looks like a CF request.
      // If CF validates, also check domain as routing context (which admin tunnel the request used).
      // Domain alone (without CF JWT) MUST NOT grant admin — the Host header is client-supplied and spoofable.
      if (hasCfJwt && cfAdapter) {
        log.debug(`Detected Cloudflare JWT, trying Cloudflare Access auth layer`);
        try {
          const cfResult = await cfAdapter.authenticate(req);
          if (cfResult) {
            log.info(`✓ CF Access auth success | adapter=cloudflare-access | identity=${cfResult.identity}`);
            // Domain adapter runs here as routing context only — CF already validated identity.
            // This lets domain matching annotate which tunnel the admin came through,
            // but the admin grant comes from CF, not from the Host header.
            if (domainAdapter) {
              const domainResult = await domainAdapter.authenticate(req);
              if (domainResult) {
                log.info(`✓ Domain routing confirmed | host=${host}`);
              }
            }
            return cfResult;
          }
          log.warn(`CF JWT present but validation failed | host=${host} | adapter=cloudflare-access → falling back`);
        } catch (err) {
          log.warn(`CF adapter threw during auth | host=${host} | err=${err instanceof Error ? err.message : String(err)} → falling back`);
        }
      }

      // 2. Domain adapter is intentionally NOT tried without a valid CF JWT.
      // Host header is client-supplied and must not grant admin on its own.

      // 3. Try local network next
      const localResult = await localAdapter.authenticate(req);
      if (localResult) {
        log.debug(`✓ Local network auth success | adapter=local-network | ip=${req.ip}`);
        return localResult;
      }

      // 4. No auth method succeeded → viewer
      log.warn(`✗ All auth layers failed → viewer | host=${host} | ip=${req.ip} | hasCfJwt=${hasCfJwt} | domainAdapter=${!!domainAdapter} | cfAdapter=${!!cfAdapter}`);
      return null;
    },
  };
}
