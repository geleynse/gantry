import type { Request, Response, NextFunction } from "express";
import type { AuthAdapter, AuthResult } from "./types.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("auth:middleware");

// Extend Express Request with auth info
declare global {
  namespace Express {
    interface Request {
      auth?: AuthResult;
    }
  }
}

const PUBLIC_ROUTES = new Set(["/health", "/health/instability", "/api/ping"]);

// Routes that should authenticate (to populate req.auth) but never block access
const AUTH_OPTIONAL_ROUTES = new Set(["/api/auth/me"]);

const MCP_PREFIXES = ["/mcp", "/sessions"];

function isPublicRoute(req: Request): boolean {
  return PUBLIC_ROUTES.has(req.path);
}

function isMcpRoute(req: Request): boolean {
  return MCP_PREFIXES.some((p) => req.path === p || req.path.startsWith(p + "/"));
}

function isLocalhost(req: Request): boolean {
  const ip = req.ip;
  if (!ip) return false;
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function isAdminRoute(req: Request): boolean {
  // Non-GET requests are admin
  if (req.method !== "GET") return true;
  // MCP endpoints are admin (even GET — they shouldn't be exposed publicly)
  if (isMcpRoute(req)) return true;
  return false;
}

/**
 * Express middleware that enforces role-based access control.
 *
 * Flow:
 * 1. Public routes (health, ping, auth/me) → always pass
 * 2. MCP from localhost → always pass (agent connections)
 * 3. Authenticate via adapter → sets req.auth
 * 4. Admin routes require admin role → 403 if viewer
 * 5. All other routes → pass (viewers can read)
 */
export function authMiddleware(adapter: AuthAdapter) {
  return async (req: Request, res: Response, next: NextFunction) => {
    log.debug(`[auth] ${req.method} ${req.path} | Host: ${req.get("host")} | IP: ${req.ip}`);

    // Public routes: always pass without authenticating
    if (isPublicRoute(req)) {
      return next();
    }

    // MCP localhost bypass: agents connect from localhost
    if (isMcpRoute(req) && isLocalhost(req)) {
      req.auth = { role: "admin", identity: "localhost" };
      return next();
    }

    // Authenticate
    const isOptional = AUTH_OPTIONAL_ROUTES.has(req.path);
    try {
      const result = await adapter.authenticate(req);
      req.auth = result ?? { role: "viewer" };
    } catch (err) {
      if (isOptional) {
        // Auth-optional routes fall back to viewer on error
        req.auth = { role: "viewer" };
      } else {
        // Fail-closed: auth adapter errors should reject the request
        log.warn(`Auth adapter error (fail-closed): ${err instanceof Error ? err.message : String(err)}`);
        res.status(503).json({ error: "Authentication service unavailable" });
        return;
      }
    }

    // Auth-optional routes: authenticate but never block
    if (isOptional) {
      return next();
    }

    // Check authorization for admin routes
    if (isAdminRoute(req) && req.auth.role !== "admin") {
      res.status(403).json({ error: "Admin access required" });
      return;
    }

    next();
  };
}

/**
 * Middleware that restricts access to localhost-only.
 * Used for sensitive endpoints like credential restore.
 */
export function localhostOnlyMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!isLocalhost(req)) {
    res.status(403).json({ error: "Localhost only" });
    return;
  }
  next();
}

// Exported for testing
export { isPublicRoute, isMcpRoute, isLocalhost, isAdminRoute };
