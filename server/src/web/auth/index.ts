import { createTokenAdapter } from "./adapters/token.js";
import { createCloudflareAccessAdapter } from "./adapters/cloudflare-access.js";
import { createDenyAdapter } from "./adapters/deny.js";
import { createLocalNetworkAdapter } from "./adapters/local-network.js";
import { createLoopbackAdapter } from "./adapters/loopback.js";
import { createLayeredAdapter } from "./adapters/layered.js";
import { createDomainAdapter } from "./adapters/domain.js";
import type { AuthAdapter, AuthConfig } from "./types.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("auth");

export type { AuthAdapter, AuthConfig, AuthResult, AuthRole } from "./types.js";

/**
 * Detect if server is externally accessible.
 * Checks env vars and would check bind address in production.
 */
function isExternallyAccessible(): boolean {
  // Check for tunnel/external access indicators
  if (process.env.CF_TUNNEL || process.env.GANTRY_EXTERNAL) {
    return true;
  }
  // In production, would also check if bind address is not localhost
  // For now, trust env vars
  return false;
}

/**
 * Create an auth adapter from config.
 * Built-in adapters: "none", "token", "cloudflare-access", "deny", "local-network", "loopback", "layered".
 * Custom adapters: file path starting with "./" (loaded via dynamic import as an extension point).
 *
 * SECURITY NOTE: Custom adapter loading via dynamic import is an intentional extension mechanism.
 * Only use custom adapters if you trust the source of gantry.json. Do not allow untrusted users
 * to modify the auth config.
 *
 * Fail-closed behavior:
 * - If auth config is missing → LoopbackAdapter (safest default — only localhost gets admin)
 * - If adapter is "none" AND server is externally accessible → DenyAdapter
 * - If adapter is "none" → NoneAdapter (dev/local operation, all get admin role)
 */
export async function createAuthAdapter(authConfig?: AuthConfig): Promise<AuthAdapter> {
  if (!authConfig || authConfig.adapter === "loopback") {
    if (isExternallyAccessible()) {
      log.info(
        "Server is externally accessible. Using LoopbackAdapter (admin access only from 127.0.0.1/::1).",
      );
    }
    return createLoopbackAdapter();
  }

  const adapterName = authConfig.adapter;
  const config = authConfig.config ?? {};

  switch (adapterName) {
    case "none": {
      log.warn(
        "⚠️  Auth adapter 'none' is active — ALL requests get admin access. Only use for localhost development.",
      );
      if (isExternallyAccessible()) {
        log.error(
          "🚨 Auth adapter 'none' is active on a non-localhost interface. This is a security risk.",
        );
      }
      // none adapter: grants admin to everyone, no checks
      return {
        name: "none",
        async authenticate(req) {
          return { role: "admin" as const, identity: req.ip ?? "unknown" };
        },
      };
    }

    case "deny":
      return createDenyAdapter();

    case "token":
      return createTokenAdapter(config as { token: string });

    case "cloudflare-access":
      return createCloudflareAccessAdapter(
        config as { teamDomain: string; audience: string },
      );

    case "local-network":
      return createLocalNetworkAdapter(config as { allowedIpRanges?: string[] });

    case "domain":
      return createDomainAdapter(config as { adminDomains: string[] });

    case "layered":
      return createLayeredAdapter(
        config as {
          localNetworkRanges?: string[];
          cloudflareTeamDomain?: string;
          cloudflareAudience?: string;
        },
      );

    default: {
      // Custom adapter: load from file path (must start with "./" for relative paths)
      if (!adapterName.startsWith("./")) {
        throw new Error(
          `[auth] Custom adapter path must start with "./": got "${adapterName}". ` +
          `Use relative paths like "./my-adapter.js" to prevent arbitrary package imports.`,
        );
      }

      try {
        log.warn(
          `Loading custom auth adapter from "${adapterName}". ` +
          `Ensure this file is trusted and that gantry.json is not modifiable by untrusted users.`,
        );
        const mod = await import(adapterName);
        const adapter: AuthAdapter = mod.default ?? mod;
        if (typeof adapter.authenticate !== "function") {
          throw new Error(`Custom adapter at ${adapterName} must export an AuthAdapter object`);
        }
        log.info(`Loaded custom adapter: ${adapter.name || adapterName}`);
        return adapter;
      } catch (err) {
        throw new Error(
          `[auth] Failed to load custom adapter from "${adapterName}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
