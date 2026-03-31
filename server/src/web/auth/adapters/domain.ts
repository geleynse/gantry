import type { AuthAdapter } from "../types.js";
import { createLogger } from "../../../lib/logger.js";

const log = createLogger("auth:domain");

interface DomainConfig {
  adminDomains: string[];
}

/**
 * Domain-based auth adapter.
 * Grants admin access based on the Host header, BUT only when the request
 * also carries a Cloudflare Access JWT assertion header.
 *
 * The Host header is client-supplied and trivially spoofable — anyone on the
 * LAN can send `Host: admin.your-domain.com` and bypass access controls if we rely on
 * the Host header alone. Requiring the CF JWT header ensures the request
 * actually passed through Cloudflare Access. This adapter does NOT validate
 * the JWT (that's the cloudflare-access adapter's job); it just uses the
 * header's presence as proof the request arrived via CF's edge.
 *
 * WARNING: Still MUST NOT be used as a standalone auth mechanism. It is safe
 * only when called from within a validated auth context where the CF JWT has
 * already been verified (e.g., via the layered adapter).
 */
export function createDomainAdapter(config: DomainConfig): AuthAdapter {
  const adminDomains = new Set(config.adminDomains);

  return {
    name: "domain",
    async authenticate(req) {
      const host = req.get("host") || "";

      // Require a CF JWT assertion header to be present. The Host header is
      // client-supplied and spoofable, so matching the host alone is not
      // sufficient — we need evidence the request came through CF Access.
      // We don't validate the JWT here (cloudflare-access adapter does that);
      // we just check that CF's edge injected the header at all.
      const cfJwt = req.headers["cf-access-jwt-assertion"];
      if (!cfJwt || typeof cfJwt !== "string" || cfJwt.trim() === "") {
        log.debug(`✗ Domain ${host} DENIED (no CF JWT header — possible Host spoofing attempt)`);
        return null;
      }

      if (adminDomains.has(host)) {
        log.debug(`✓ Domain ${host} ALLOWED (admin, CF JWT present)`);
        return {
          role: "admin",
          identity: `domain:${host}`,
        };
      }

      log.debug(`✗ Domain ${host} DENIED (not in admin list)`);
      return null;
    },
  };
}
