import type { AuthAdapter } from "../types.js";
import { createLogger } from "../../../lib/logger.js";

const log = createLogger("auth:cf");

interface CfAccessConfig {
  teamDomain: string; // e.g. "yourteam.cloudflareaccess.com"
  audience?: string; // Application Audience (AUD) tag (optional)
}

interface CfJwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

interface CfCertsResponse {
  keys: CfJwk[];
}

const CACHE_TTL = 10 * 60 * 1000;

/**
 * Import a JWK RSA public key for verification.
 */
async function importKey(jwk: CfJwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: jwk.alg || "RS256" },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

/**
 * Base64url decode to Buffer.
 */
function base64urlDecode(str: string): Buffer {
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Cloudflare Access JWT auth adapter.
 * Validates the Cf-Access-Jwt-Assertion header (or CF_Authorization cookie).
 * Valid JWT → admin. Missing/invalid → viewer (allows public read access).
 *
 * Each adapter instance maintains its own key cache.
 */
export function createCloudflareAccessAdapter(config: CfAccessConfig): AuthAdapter {
  if (!config.teamDomain) {
    throw new Error("[auth:cloudflare-access] teamDomain is required");
  }

  // Per-instance key cache
  let cachedKeys: CfJwk[] = [];
  let cacheExpiry = 0;
  const cryptoKeyCache = new Map<string, CryptoKey>();

  async function fetchPublicKeys(teamDomain: string): Promise<CfJwk[]> {
    const now = Date.now();
    if (cachedKeys.length > 0 && now < cacheExpiry) {
      return cachedKeys;
    }

    const url = `https://${teamDomain}/cdn-cgi/access/certs`;
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`Failed to fetch CF Access certs: ${resp.status}`);
    }
    const data = (await resp.json()) as CfCertsResponse;
    cachedKeys = data.keys;
    cacheExpiry = now + CACHE_TTL;
    cryptoKeyCache.clear();
    return cachedKeys;
  }

  /**
   * Verify and decode a CF Access JWT.
   * Validates:
   * - Signature (RSA)
   * - Issuer (iss): must be https://{teamDomain}
   * - Audience (aud): must include configured audience
   * - Not-before (nbf): token must be valid now
   * - Issued-at (iat): token shouldn't be from far future (60s clock skew allowed)
   * - Expiry (exp): token must not be expired
   * Returns decoded payload on success, null on failure.
   */
  async function verifyJwt(
    token: string,
    teamDomain: string,
    audience: string,
  ): Promise<Record<string, unknown> | null> {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signatureB64] = parts;

    let header: { kid?: string; alg?: string };
    try {
      header = JSON.parse(base64urlDecode(headerB64).toString("utf8"));
    } catch {
      return null;
    }

    const keys = await fetchPublicKeys(teamDomain);
    const jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) {
      log.error(`No matching public key found for kid: ${header.kid}`);
      return null;
    }

    // Cache CryptoKey objects to avoid repeated importKey calls
    let key = cryptoKeyCache.get(jwk.kid);
    if (!key) {
      key = await importKey(jwk);
      cryptoKeyCache.set(jwk.kid, key);
    }
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = base64urlDecode(signatureB64);

    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature as BufferSource,
      data as BufferSource,
    );
    if (!valid) {
      log.error("JWT signature verification failed");
      return null;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(base64urlDecode(payloadB64).toString("utf8"));
    } catch (err) {
      log.error(`Failed to parse JWT payload: ${err}`);
      return null;
    }

    // Validate issuer (should be https://{teamDomain})
    const expectedIssuer = `https://${teamDomain}`;
    const iss = payload.iss;
    if (typeof iss !== "string" || iss !== expectedIssuer) {
      log.error(`JWT issuer mismatch: expected ${expectedIssuer}, got ${iss}`);
      return null; // Issuer mismatch or missing
    }

    // Validate audience
    const aud = payload.aud;
    const audArray = Array.isArray(aud) ? aud : [aud];
    if (audience && !audArray.includes(audience)) {
      log.warn(`JWT audience mismatch: expected ${audience}, got ${JSON.stringify(aud)}`);
      return null;
    }

    const nowSec = Date.now() / 1000;

    // Validate not-before (nbf): token not valid before this timestamp
    const nbf = payload.nbf;
    if (typeof nbf === "number" && nowSec < nbf) {
      return null; // Token not yet valid
    }

    // Validate issued-at (iat): reasonable to check token isn't from far future
    const iat = payload.iat;
    if (typeof iat === "number" && iat > nowSec + 60) {
      // Allow 60s clock skew
      return null; // Token issued in the future
    }

    // Validate expiry
    const exp = payload.exp;
    if (typeof exp === "number" && nowSec > exp) return null;

    return payload;
  }

  return {
    name: "cloudflare-access",
    async authenticate(req) {
      // Try header first, then cookie
      let token = req.headers["cf-access-jwt-assertion"] as string | undefined;
      if (!token) {
        const cookies = req.headers.cookie;
        if (cookies) {
          const match = cookies.match(/CF_Authorization=([^;]+)/);
          if (match) token = match[1];
        }
      }

      if (!token) {
        log.debug("No Cloudflare Access JWT found in headers or cookies");
        return null;
      }

      try {
        log.debug("Verifying Cloudflare Access JWT...");
        const payload = await verifyJwt(token, config.teamDomain, config.audience || "");
        if (!payload) {
          log.debug("JWT verification failed (invalid payload or signature)");
          return null;
        }
        log.info(`✓ JWT verified for ${payload.email}`);
        return {
          role: "admin",
          identity: typeof payload.email === "string" ? payload.email : undefined,
        };
      } catch (err) {
        log.error(`JWT verification failed with error: ${err}`);
        return null;
      }
    },
  };
}
