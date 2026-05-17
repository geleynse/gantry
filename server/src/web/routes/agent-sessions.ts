import { Router, type Request, type Response, type NextFunction } from "express";
import { validateAgentName } from "../config.js";
import { createLogger } from "../../lib/logger.js";
import { getDevtoolsBaseUrl } from "../../lib/devtools.js";

const log = createLogger("agent-sessions");
const router: Router = Router();

// claude-devtools standalone server. Defaults to loopback (typical setup: it
// runs as a systemd --user unit on the same host as Gantry). Set
// DEVTOOLS_URL to point at a remote instance, or to disable the feature
// set it to an unreachable value — endpoints will return 503 with setup hints.
// See docs/devtools-integration.md for installation.
const DEVTOOLS_BASE = getDevtoolsBaseUrl();

// All fleet agents share one Claude Code "project" (the cwd they run from).
// Sessions for individual agents are demultiplexed by matching the LOGIN
// username in firstMessage.
const FLEET_PROJECT_ID = process.env.DEVTOOLS_FLEET_PROJECT_ID ?? "-home-spacemolt-fleet-agents";

// Returned to the client when devtools is unreachable. The UI keys off
// `code: "devtools_unavailable"` to render a setup card instead of a raw error.
function devtoolsUnavailable(res: Response, reason: string): void {
  res.status(503).json({
    error: "devtools_unavailable",
    code: "devtools_unavailable",
    url: DEVTOOLS_BASE,
    reason,
    docsUrl: "/docs/devtools-integration.md",
  });
}

/** kebab → Title Case (e.g. drifter-gale → "Drifter Gale"). */
function slugToDisplayName(slug: string): string {
  return slug
    .split("-")
    .map((w) => (w.length === 0 ? "" : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

function loginMarker(displayName: string): string {
  return `username="${displayName}"`;
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.auth?.role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}

router.use("/:name/sessions", requireAdmin);

interface DevtoolsSessionSummary {
  id: string;
  projectId: string;
  projectPath: string;
  createdAt: number;
  updatedAt: number;
  firstMessage?: string;
  hasSubagents?: boolean;
  messageCount?: number;
  isOngoing?: boolean;
  gitBranch?: string;
  metadataLevel?: string;
  contextConsumption?: number;
}

interface DevtoolsPaginatedResponse {
  sessions?: DevtoolsSessionSummary[];
  nextCursor?: string | null;
  hasMore?: boolean;
  totalCount?: number;
}

interface DevtoolsMessageContent {
  type?: string;
  text?: string;
}

interface DevtoolsMessage {
  role?: string;
  content?: string | DevtoolsMessageContent[];
}

interface DevtoolsDetailResponse {
  messages?: DevtoolsMessage[];
}

// Insertion-ordered cache for first assistant text — oldest-inserted entry
// is evicted at the cap, not least-recently-used. Fine at this scale.
// Key: `${sessionId}:${updatedAt}`, Value: { text: string | null; expiresAt: number }
const FIRST_ASSISTANT_CACHE = new Map<string, { text: string | null; expiresAt: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CACHE_MAX_SIZE = 500;

function cacheGet(key: string): { text: string | null } | undefined {
  const entry = FIRST_ASSISTANT_CACHE.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    FIRST_ASSISTANT_CACHE.delete(key);
    return undefined;
  }
  return { text: entry.text };
}

function cacheSet(key: string, text: string | null): void {
  // Evict oldest entries if at cap.
  if (FIRST_ASSISTANT_CACHE.size >= CACHE_MAX_SIZE) {
    const firstKey = FIRST_ASSISTANT_CACHE.keys().next().value;
    if (firstKey !== undefined) FIRST_ASSISTANT_CACHE.delete(firstKey);
  }
  FIRST_ASSISTANT_CACHE.set(key, { text, expiresAt: Date.now() + CACHE_TTL_MS });
}

function extractFirstAssistantText(data: DevtoolsDetailResponse): string | null {
  const messages = data.messages ?? [];
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const c = msg.content;
    if (typeof c === "string" && c.trim()) {
      return c.slice(0, 200);
    }
    if (Array.isArray(c)) {
      for (const part of c) {
        if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string" && part.text.trim()) {
          return part.text.slice(0, 200);
        }
      }
    }
  }
  return null;
}

async function fetchFirstAssistantText(sessionId: string, updatedAt: number): Promise<string | null> {
  const cacheKey = `${sessionId}:${updatedAt}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached.text;

  const url = `${DEVTOOLS_BASE}/api/projects/${FLEET_PROJECT_ID}/sessions/${sessionId}`;
  try {
    const upstream = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!upstream.ok) {
      cacheSet(cacheKey, null);
      return null;
    }
    const data = (await upstream.json()) as DevtoolsDetailResponse;
    const text = extractFirstAssistantText(data);
    cacheSet(cacheKey, text);
    return text;
  } catch {
    cacheSet(cacheKey, null);
    return null;
  }
}

// GET /api/agents/:name/sessions?cursor=&limit=
// Returns up to `limit` sessions that match this agent. Because the upstream
// devtools API doesn't support server-side filtering, we may need to walk
// several pages to collect a single response page. The returned cursor lets
// the caller resume from where we stopped scanning.
router.get("/:name/sessions", async (req, res) => {
  const name = req.params.name;
  if (!validateAgentName(name)) {
    res.status(404).json({ error: "Unknown agent" });
    return;
  }
  const displayName = slugToDisplayName(name);
  const marker = loginMarker(displayName);
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
  let currentCursor = (req.query.cursor as string) || "";

  const matches: DevtoolsSessionSummary[] = [];
  let scanned = 0;
  // Safety cap on upstream pages so a sparse agent doesn't run forever.
  const MAX_SCANNED = 500;
  let hasMore = true;

  while (matches.length < limit && scanned < MAX_SCANNED) {
    const params = new URLSearchParams({ limit: "50", includeTotalCount: "false" });
    if (currentCursor) params.set("cursor", currentCursor);
    const url = `${DEVTOOLS_BASE}/api/projects/${FLEET_PROJECT_ID}/sessions-paginated?${params.toString()}`;

    let upstream: globalThis.Response;
    try {
      // 8s covers a single page from a slow disk; with MAX_SCANNED=500 across
      // up to 10 round-trips a hung upstream could otherwise pin the request
      // until Node's default socket timeout (~2 min).
      upstream = await fetch(url, { signal: AbortSignal.timeout(8000) });
    } catch (err) {
      log.error("devtools fetch failed", { err: err instanceof Error ? err.message : String(err) });
      devtoolsUnavailable(res, err instanceof Error ? err.message : String(err));
      return;
    }
    if (!upstream.ok) {
      log.error("devtools returned non-ok", { status: upstream.status });
      res.status(502).json({ error: "devtools error", status: upstream.status });
      return;
    }
    const data = (await upstream.json()) as DevtoolsPaginatedResponse;
    const page = data.sessions ?? [];
    scanned += page.length;
    for (const s of page) {
      if (typeof s.firstMessage === "string" && s.firstMessage.includes(marker)) {
        matches.push(s);
        if (matches.length >= limit) break;
      }
    }
    hasMore = !!data.hasMore;
    currentCursor = data.nextCursor ?? "";
    if (!hasMore || !currentCursor) break;
  }

  // Fetch first assistant text for each matching session in parallel.
  const firstAssistantTexts = await Promise.all(
    matches.map((s) => fetchFirstAssistantText(s.id, s.updatedAt)),
  );

  const sessionsWithPreview = matches.map((s, i) => ({
    ...s,
    firstAssistantText: firstAssistantTexts[i] ?? null,
  }));

  res.json({
    sessions: sessionsWithPreview,
    nextCursor: hasMore && currentCursor ? currentCursor : null,
    hasMore: hasMore && !!currentCursor,
    scanned,
  });
});

// GET /api/agents/:name/sessions/:sessionId
// Fetches parsed session detail and verifies it belongs to this agent before
// returning — otherwise an admin could enumerate any session by ID.
router.get("/:name/sessions/:sessionId", async (req, res) => {
  const name = req.params.name;
  const sessionId = req.params.sessionId;
  if (!validateAgentName(name)) {
    res.status(404).json({ error: "Unknown agent" });
    return;
  }
  // Session IDs are UUIDs; reject anything else so we don't ferry arbitrary
  // path segments to the upstream.
  if (!/^[a-f0-9-]{8,64}$/i.test(sessionId)) {
    res.status(400).json({ error: "invalid session id" });
    return;
  }

  const url = `${DEVTOOLS_BASE}/api/projects/${FLEET_PROJECT_ID}/sessions/${sessionId}`;
  let upstream: globalThis.Response;
  try {
    // Session detail can be large (full message log + chunks). 15s budget.
    upstream = await fetch(url, { signal: AbortSignal.timeout(15000) });
  } catch (err) {
    log.error("devtools fetch failed", { err: err instanceof Error ? err.message : String(err) });
    devtoolsUnavailable(res, err instanceof Error ? err.message : String(err));
    return;
  }
  if (!upstream.ok) {
    res.status(upstream.status === 404 ? 404 : 502).json({ error: "devtools error" });
    return;
  }
  const data = (await upstream.json()) as { session?: { firstMessage?: string } } & Record<string, unknown>;
  const marker = loginMarker(slugToDisplayName(name));
  const first = data?.session?.firstMessage;
  if (typeof first !== "string") {
    res.status(404).json({ error: "session not found for this agent" });
    return;
  }
  if (!first.includes(marker)) {
    res.status(404).json({ error: "session not found for this agent" });
    return;
  }
  res.json(data);
});

export default router;
export { slugToDisplayName, extractFirstAssistantText };
