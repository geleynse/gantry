import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import express, { type Request, type Response, type NextFunction } from "express";
import request from "supertest";
import { setConfigForTesting } from "../../config.js";
import type { GantryConfig } from "../../config.js";

const testConfig: GantryConfig = {
  agents: [
    { name: "drifter-gale" },
    { name: "sable-thorn" },
  ] as GantryConfig["agents"],
  gameUrl: "ws://localhost",
  gameApiUrl: "http://localhost",
  gameMcpUrl: "http://localhost",
  agentDeniedTools: {},
  callLimits: {},
  turnSleepMs: 90,
  staggerDelay: 20,
};

mock.module("../middleware/rate-limit.js", () => ({
  agentControlLimiter: (_req: Request, _res: Response, next: NextFunction) => next(),
  generalPostLimiter: (_req: Request, _res: Response, next: NextFunction) => next(),
  sessionLimiter: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import agentSessionsRouter, { slugToDisplayName, extractFirstAssistantText } from "./agent-sessions.js";

/** Mount the router behind a fake auth shim so we can flip roles per-test. */
function buildApp(role: "admin" | "viewer") {
  const app = express();
  app.use((req, _res, next) => {
    req.auth = { role, identity: "test" };
    next();
  });
  app.use("/api/agents", agentSessionsRouter);
  return app;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): globalThis.Response {
  return new globalThis.Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("agent-sessions routes", () => {
  beforeEach(() => {
    setConfigForTesting(testConfig);
  });

  afterEach(() => {
    mock.restore();
  });

  describe("extractFirstAssistantText", () => {
    it("returns null when no assistant messages", () => {
      expect(extractFirstAssistantText({ messages: [{ role: "user", content: "hi" }] })).toBeNull();
    });

    it("extracts text from string content", () => {
      const result = extractFirstAssistantText({
        messages: [{ role: "assistant", content: "Hello from assistant" }],
      });
      expect(result).toBe("Hello from assistant");
    });

    it("extracts text from array content with type=text", () => {
      const result = extractFirstAssistantText({
        messages: [
          { role: "user", content: "ping" },
          { role: "assistant", content: [{ type: "text", text: "pong response" }] },
        ],
      });
      expect(result).toBe("pong response");
    });

    it("truncates to 200 chars", () => {
      const long = "x".repeat(300);
      const result = extractFirstAssistantText({
        messages: [{ role: "assistant", content: long }],
      });
      expect(result?.length).toBe(200);
    });

    it("returns null for empty messages array", () => {
      expect(extractFirstAssistantText({})).toBeNull();
    });
  });

  describe("slugToDisplayName", () => {
    it("converts kebab to title case", () => {
      expect(slugToDisplayName("drifter-gale")).toBe("Drifter Gale");
      expect(slugToDisplayName("sable-thorn")).toBe("Sable Thorn");
      expect(slugToDisplayName("overseer")).toBe("Overseer");
    });
  });

  describe("admin gate", () => {
    it("rejects non-admin on list", async () => {
      const app = buildApp("viewer");
      const res = await request(app).get("/api/agents/drifter-gale/sessions");
      expect(res.status).toBe(403);
    });

    it("rejects non-admin on detail", async () => {
      const app = buildApp("viewer");
      const res = await request(app).get("/api/agents/drifter-gale/sessions/abcdef12-1234-5678-9abc-def012345678");
      expect(res.status).toBe(403);
    });
  });

  describe("GET /:name/sessions", () => {
    it("returns 404 for unknown agent", async () => {
      const app = buildApp("admin");
      const res = await request(app).get("/api/agents/who-dis/sessions");
      expect(res.status).toBe(404);
    });

    it("filters sessions by agent display name in firstMessage", async () => {
      const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
        jsonResponse({
          sessions: [
            { id: "s1", createdAt: 1, updatedAt: 2, firstMessage: 'LOGIN: username="Drifter Gale"\nrest', messageCount: 10 },
            { id: "s2", createdAt: 3, updatedAt: 4, firstMessage: 'LOGIN: username="Sable Thorn"\nrest', messageCount: 5 },
            { id: "s3", createdAt: 5, updatedAt: 6, firstMessage: 'LOGIN: username="Drifter Gale"\nrest', messageCount: 8 },
          ],
          nextCursor: null,
          hasMore: false,
        }),
      );

      const app = buildApp("admin");
      const res = await request(app).get("/api/agents/drifter-gale/sessions");
      expect(res.status).toBe(200);
      expect(res.body.sessions.map((s: { id: string }) => s.id)).toEqual(["s1", "s3"]);
      expect(res.body.hasMore).toBe(false);

      fetchSpy.mockRestore();
    });

    it("returns structured 503 when devtools is unreachable", async () => {
      const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
      const app = buildApp("admin");
      const res = await request(app).get("/api/agents/drifter-gale/sessions");
      expect(res.status).toBe(503);
      expect(res.body.code).toBe("devtools_unavailable");
      expect(res.body.url).toBeDefined();
      expect(res.body.docsUrl).toBeDefined();
      fetchSpy.mockRestore();
    });

    it("populates firstAssistantText from detail response", async () => {
      const listBody = {
        sessions: [
          { id: "s1-unique-test", createdAt: 1, updatedAt: 9999, firstMessage: 'LOGIN: username="Drifter Gale"\nrest', messageCount: 3 },
        ],
        nextCursor: null,
        hasMore: false,
      };
      const detailBody = {
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: [{ type: "text", text: "I am the assistant response!" }] },
        ],
      };
      // First call: list endpoint; second call: detail endpoint for s1-unique-test
      const fetchSpy = spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(jsonResponse(listBody))
        .mockResolvedValueOnce(jsonResponse(detailBody));

      const app = buildApp("admin");
      const res = await request(app).get("/api/agents/drifter-gale/sessions");
      expect(res.status).toBe(200);
      expect(res.body.sessions[0].firstAssistantText).toBe("I am the assistant response!");
      fetchSpy.mockRestore();
    });
  });

  describe("GET /:name/sessions/:sessionId", () => {
    const validId = "abcdef12-1234-5678-9abc-def012345678";

    it("rejects invalid session ID format", async () => {
      const app = buildApp("admin");
      // Chars outside [a-f0-9-] reach the handler but fail the UUID regex.
      const res = await request(app).get("/api/agents/drifter-gale/sessions/not_a_uuid");
      expect(res.status).toBe(400);
    });

    it("returns the session when it belongs to this agent", async () => {
      const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
        jsonResponse({
          session: { id: validId, firstMessage: 'LOGIN: username="Drifter Gale"\nstuff' },
          messages: [],
        }),
      );
      const app = buildApp("admin");
      const res = await request(app).get(`/api/agents/drifter-gale/sessions/${validId}`);
      expect(res.status).toBe(200);
      expect(res.body.session.id).toBe(validId);
      fetchSpy.mockRestore();
    });

    it("returns 404 when session belongs to a different agent", async () => {
      const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
        jsonResponse({
          session: { id: validId, firstMessage: 'LOGIN: username="Sable Thorn"\nstuff' },
          messages: [],
        }),
      );
      const app = buildApp("admin");
      const res = await request(app).get(`/api/agents/drifter-gale/sessions/${validId}`);
      expect(res.status).toBe(404);
      fetchSpy.mockRestore();
    });

    it("returns 404 when upstream omits firstMessage so ownership cannot be verified", async () => {
      const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
        jsonResponse({
          session: { id: validId },
          messages: [],
        }),
      );
      const app = buildApp("admin");
      const res = await request(app).get(`/api/agents/drifter-gale/sessions/${validId}`);
      expect(res.status).toBe(404);
      fetchSpy.mockRestore();
    });
  });
});
