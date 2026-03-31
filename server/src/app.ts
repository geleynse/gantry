import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import type { GantryConfig } from "./config.js";
import { createMcpServer } from "./proxy/server.js";
import { createAuthAdapter } from "./web/auth/index.js";
import { authMiddleware } from "./web/auth/middleware.js";
import { createApiRoutes } from "./web/routes/api-routes.js";
import { generalPostLimiter, sessionLimiter, agentControlLimiter, secretRotationLimiter } from "./web/middleware/rate-limit.js";
import { createLogger } from "./lib/logger.js";
import type { HealthMonitor } from "./services/health-monitor.js";

const log = createLogger("app");

// --- Embedded static file support (compiled binary mode) ---

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".txt": "text/plain",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** Resolve the public directory path, with env var override for Docker/binary deployments. */
function resolvePublicDir(): string {
  if (process.env.GANTRY_PUBLIC_DIR) return process.env.GANTRY_PUBLIC_DIR;
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
}

/** Pre-buffered embedded file with content type. */
interface EmbeddedFile {
  data: Buffer;
  contentType: string;
  cacheable: boolean;
}

/** Build a map of URL path → pre-buffered content from Bun.embeddedFiles, or null if not in compiled mode. */
async function buildEmbeddedFileMap(): Promise<Map<string, EmbeddedFile> | null> {
  // Bun.embeddedFiles is empty when not running as a compiled binary
  const files = typeof globalThis.Bun !== "undefined" ? (globalThis.Bun as any).embeddedFiles : undefined;
  if (!files || !Array.isArray(files) || files.length === 0) return null;

  const map = new Map<string, EmbeddedFile>();
  for (const file of files) {
    // Embedded file names are relative paths like "dist/public/index.html"
    const name: string = file.name ?? "";
    const prefix = "dist/public";
    if (!name.startsWith(prefix)) continue;
    const urlPath = name.slice(prefix.length); // "/index.html"
    const ext = path.extname(name);
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    const data = Buffer.from(await file.arrayBuffer());
    map.set(urlPath, { data, contentType, cacheable: ext === ".js" || ext === ".css" });
  }
  if (map.size === 0) return null;
  log.info(`Serving ${map.size} embedded static files (pre-buffered)`);
  return map;
}

/** Express middleware that serves from pre-buffered embedded files map. */
function serveEmbedded(fileMap: Map<string, EmbeddedFile>): express.RequestHandler {
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();

    let urlPath = req.path;
    let file = fileMap.get(urlPath);

    // Try with .html extension (matches express.static extensions: ['html'])
    if (!file && !path.extname(urlPath)) {
      file = fileMap.get(urlPath + ".html");
    }
    // Try index.html for directory-like paths (with or without trailing slash)
    if (!file && urlPath.endsWith("/")) {
      file = fileMap.get(urlPath + "index.html");
    }
    // Try subdirectory index.html (Next.js static export directory format)
    if (!file && !path.extname(urlPath)) {
      file = fileMap.get(urlPath + "/index.html");
    }

    if (!file) return next();

    res.set("Content-Type", file.contentType);
    res.set("Content-Length", String(file.data.length));
    if (file.cacheable) {
      res.set("Cache-Control", "public, max-age=31536000, immutable");
    }
    res.send(file.data);
  };
}

/**
 * Create the unified Express application combining:
 * - MCP proxy routes (/, /mcp, /mcp/v2, /health, /sessions, /game-state)
 * - Web dashboard API routes (/api/*)
 * - Static file serving for the SPA frontend
 */
const LOCALHOST_ADDRESSES = new Set(['127.0.0.1', '::1', 'localhost']);

function isLocalhostBind(host: string): boolean {
  return LOCALHOST_ADDRESSES.has(host);
}

export async function createApp(config: GantryConfig, options?: { bindHost?: string; healthMonitor?: HealthMonitor }) {
  const app: Express = express();

  // Trust proxy headers for IP extraction (needed for auth adapters to work correctly with proxies/containers)
  // Configure via TRUST_PROXY env var: false (default, safe), 1 (Cloudflare tunnel), or true (trust all)
  const trustProxy = process.env.TRUST_PROXY;
  const trustProxyValue = trustProxy === "true" ? true : trustProxy === "1" ? 1 : false;
  app.set("trust proxy", trustProxyValue);
  if (trustProxyValue) {
    log.warn("TRUST_PROXY is broadly set — consider using specific proxy IP/CIDR for production");
  }

  // Security headers (defense in depth)
  app.use((_req, res, next) => {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    if (_req.secure || _req.headers["x-forwarded-proto"] === "https") {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }

    // CORS: same-origin only — reflect origin if it matches the Host header
    const origin = _req.headers["origin"];
    const host = _req.headers["host"];
    if (origin && host) {
      try {
        const originHost = new URL(origin).host;
        if (originHost === host) {
          res.setHeader("Access-Control-Allow-Origin", origin);
          res.setHeader("Vary", "Origin");
        }
      } catch {
        // malformed origin — skip CORS headers
      }
    }

    if (_req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.writeHead(204);
      res.end();
      return;
    }

    next();
  });

  // Body parsing with generous limit for MCP payloads
  // strict: false allows bare JSON null (used for clearing battle state via PUT /api/action-proxy/battle-state/:agent)
  app.use(express.json({ limit: "1mb", strict: false }));

  // Prevent caching on API responses
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  // --- Observability (Log API errors) ---
  // Must be registered before routes to capture all responses.
  app.use((req, res, next) => {
    // Only instrument API errors (non-static files)
    if (req.path.startsWith("/api") || req.path.startsWith("/mcp") || req.path.startsWith("/health")) {
      const originalSend = res.send;
      res.send = function(data: any) {
        if (res.statusCode >= 400) {
          // Suppress 405 on MCP endpoints — Claude CLI probes with GET during init, which is expected
          const isMcpProbe = res.statusCode === 405 && req.method === "GET" && req.path.startsWith("/mcp");
          if (!isMcpProbe) {
            log.warn("HTTP error", {
              status: res.statusCode,
              method: req.method,
              path: req.path,
              query: Object.keys(req.query).length > 0 ? req.query : undefined,
            });
          }
        }
        return originalSend.call(this, data);
      };
    }
    next();
  });

  // General POST rate limiter (60 req/min per IP, localhost exempt).
  // Specific sensitive endpoints apply stricter limiters before this one runs.
  app.use(generalPostLimiter);

  // Stricter limiters for sensitive endpoints
  app.use("/sessions", sessionLimiter);
  app.use("/api/security/rotate-secret", secretRotationLimiter);
  app.use("/api/agents/:name/inject", agentControlLimiter);
  app.use("/api/agents/:name/order", agentControlLimiter);
  app.use("/api/agents/:name/shutdown", agentControlLimiter);

  // --- Auth middleware ---
  const adapter = await createAuthAdapter(config.auth);
  app.use(authMiddleware(adapter));
  log.info("Auth adapter active", { adapter: adapter.name });

  // --- Startup warning for none auth adapter on non-localhost binding ---
  const bindHost = options?.bindHost;
  if (adapter.name === 'none' && bindHost && !isLocalhostBind(bindHost)) {
    log.warn(
      `⚠️  WARNING: Auth disabled (authAdapter=none) and server binding to ${bindHost}\n` +
      `   Anyone with network access can control your fleet agents.\n` +
      `   Set authAdapter=token or authAdapter=cloudflare-access for production use.`
    );
  }

  // --- Auth info endpoint (public) ---
  app.get("/api/auth/me", (req, res) => {
    res.json({
      role: req.auth?.role ?? "viewer",
      identity: req.auth?.identity ?? null,
    });
  });

  // --- Auth debug endpoint (admin-only) ---
  // Returns diagnostic info about the active auth adapter and current request auth state.
  // Useful for debugging auth regressions without reading server logs.
  app.get("/api/auth/debug", (req, res) => {
    if (req.auth?.role !== "admin") {
      res.status(403).json({ error: "Admin access required" });
      return;
    }

    const headers = req.headers;

    // CF Access JWT status (redact actual token value, show metadata only)
    const cfJwtHeader = headers["cf-access-jwt-assertion"] as string | undefined;
    const cfCookie = headers["cookie"] as string | undefined;
    const cfJwtCookieMatch = cfCookie ? /CF_Authorization=([^;]+)/.exec(cfCookie) : null;
    const cfJwt = cfJwtHeader ?? cfJwtCookieMatch?.[1];
    let cfJwtStatus: string;
    if (!cfJwt) {
      cfJwtStatus = "missing";
    } else {
      const parts = cfJwt.split(".");
      if (parts.length !== 3) {
        cfJwtStatus = "malformed";
      } else {
        try {
          const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8")) as Record<string, unknown>;
          const exp = typeof payload.exp === "number" ? payload.exp : null;
          const now = Math.floor(Date.now() / 1000);
          if (exp !== null && now > exp) {
            cfJwtStatus = `expired (exp=${exp}, now=${now}, age=${now - exp}s)`;
          } else if (exp !== null) {
            cfJwtStatus = `valid (exp=${exp}, ttl=${exp - now}s, iss=${payload.iss ?? "?"}, sub=${payload.sub ?? "?"})`;
          } else {
            cfJwtStatus = "present (no exp claim)";
          }
        } catch {
          cfJwtStatus = "present but unparseable";
        }
      }
    }

    // Sanitized headers (redact Authorization, Cookie values but show presence)
    const sanitizedHeaders: Record<string, string> = {};
    for (const [key, val] of Object.entries(headers)) {
      const v = Array.isArray(val) ? val.join(", ") : (val ?? "");
      if (key === "authorization") {
        sanitizedHeaders[key] = v ? "[redacted]" : "[absent]";
      } else if (key === "cookie") {
        // Show cookie names only, not values
        const names = v.split(";").map((c) => c.trim().split("=")[0]).filter(Boolean);
        sanitizedHeaders[key] = names.length > 0 ? `[names: ${names.join(", ")}]` : "[absent]";
      } else if (key === "cf-access-jwt-assertion") {
        sanitizedHeaders[key] = v ? "[present, redacted]" : "[absent]";
      } else {
        sanitizedHeaders[key] = v;
      }
    }

    res.json({
      adapter: adapter.name,
      auth_result: {
        role: req.auth?.role ?? "viewer",
        identity: req.auth?.identity ?? null,
      },
      cf_jwt: cfJwtStatus,
      host: req.get("host") ?? null,
      ip: req.ip,
      trust_proxy: app.get("trust proxy"),
      headers: sanitizedHeaders,
    });
  });

  // --- MCP + proxy routes (mounted at root) ---
  const { router: mcpRouter, sessions, registeredToolCount, sharedState, overseerAgent, dispose: disposeProxy } = await createMcpServer(config);
  app.use("/", mcpRouter);

  // --- Web API routes ---
  app.use("/api", createApiRoutes({
    config,
    sharedState,
    sessions,
    registeredToolCount,
    healthMonitor: options?.healthMonitor,
    overseerAgent,
  }));

  // --- Static files (SPA frontend) ---
  // When running as a compiled binary, static files are embedded via
  // Bun.embeddedFiles. Otherwise, serve from disk (dev/esbuild mode).
  const embeddedFileMap = await buildEmbeddedFileMap();
  const publicDir = resolvePublicDir();
  if (embeddedFileMap) {
    app.use(serveEmbedded(embeddedFileMap));
  } else {
    // Redirect direct hits to Next.js RSC flight data (.txt) to the HTML page.
    // These files are for client-side prefetch only — if a browser navigates to them
    // directly (e.g., JS failed to load, or the URL was shared), show the page instead.
    // Prefetch requests include the RSC header and won't match this redirect.
    app.use((req, res, next) => {
      if (req.method === "GET" && req.path.endsWith("/index.txt") && !req.headers["rsc"]) {
        const htmlPath = req.path.replace(/\/index\.txt$/, "/");
        res.redirect(301, htmlPath);
        return;
      }
      next();
    });
    app.use(express.static(publicDir, { extensions: ['html'], redirect: false }));
  }

  // Fallback for extensionless paths that express.static missed due to directory
  // collision (e.g. /fleet has both fleet.html and fleet/ directory — static middleware
  // sees the directory, gives up with redirect: false, never tries fleet.html).
  // Also handles Next.js trailingSlash: true pages (e.g. /overseer → overseer/index.html).
  if (!embeddedFileMap) {
    const { existsSync } = await import("node:fs");
    app.use((req, res, next) => {
      if (req.method !== "GET" || path.extname(req.path)) return next();
      const htmlPath = path.join(publicDir, req.path + ".html");
      if (existsSync(htmlPath)) {
        res.sendFile(htmlPath);
        return;
      }
      // Try directory index (Next.js trailingSlash export format)
      const indexPath = path.join(publicDir, req.path, "index.html");
      if (existsSync(indexPath)) {
        res.sendFile(indexPath);
        return;
      }
      next();
    });
  }

  // Final fallback: serve index.html for SPA client-side routing.
  // This handles dynamic routes like /agent/[name] that aren't pre-rendered at build time.
  // The React app uses client-side routing to handle these after hydration.
  // API routes (/api/*) and MCP routes are defined before this handler, so they're not caught.
  if (embeddedFileMap) {
    // Compiled binary mode: serve index.html from embedded files
    app.use((req, res) => {
      if (req.method !== "GET") {
        res.status(404).json({ error: "Not found" });
        return;
      }
      const indexFile = embeddedFileMap.get("/index.html");
      if (!indexFile) {
        res.status(404).end();
        return;
      }
      res.set("Content-Type", "text/html");
      res.set("Content-Length", String(indexFile.data.length));
      res.send(indexFile.data);
    });
  } else {
    // Dev/esbuild mode: serve index.html from disk
    const { existsSync } = await import("node:fs");
    app.use((req, res) => {
      if (req.method !== "GET") {
        res.status(404).json({ error: "Not found" });
        return;
      }
      const indexPath = path.join(publicDir, "index.html");
      if (existsSync(indexPath)) {
        res.sendFile(indexPath);
        return;
      }
      res.status(404).end();
    });
  }

  return { app, sessions, sharedState, overseerAgent, dispose: disposeProxy };
}
