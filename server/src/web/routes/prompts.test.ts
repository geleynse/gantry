/**
 * Tests for /api/prompts/* routes.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import supertest from "supertest";
import { createPromptsRouter } from "./prompts.js";

const TMP_FLEET_DIR = join(import.meta.dir, "tmp-prompts-test");

// ---------------------------------------------------------------------------
// Test setup helpers
// ---------------------------------------------------------------------------

const BASE_CONFIG = {
  agents: [
    {
      name: "test-alpha",
      model: "haiku",
      role: "Trader/Mining",
      systemPrompt: "You are Test Alpha. Keep it short.",
    },
    {
      name: "test-bravo",
      model: "sonnet",
      role: "Explorer",
      systemPrompt: null,
    },
  ],
  gameUrl: "http://localhost/mcp",
  gameApiUrl: "http://localhost/api/v1",
  agentDeniedTools: {},
  callLimits: {},
  turnSleepMs: 90000,
  staggerDelay: 5000,
  maxIterationsPerSession: 200,
  maxTurnDurationMs: 300000,
  idleTimeoutMs: 120000,
} as any;

function makeTestApp(role: "admin" | "viewer" = "admin") {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.auth = { role, identity: "test-user" };
    next();
  });
  app.use("/api/prompts", createPromptsRouter(TMP_FLEET_DIR, BASE_CONFIG));
  return app;
}

// ---------------------------------------------------------------------------
// Before/After
// ---------------------------------------------------------------------------

beforeEach(() => {
  if (existsSync(TMP_FLEET_DIR)) rmSync(TMP_FLEET_DIR, { recursive: true });
  mkdirSync(TMP_FLEET_DIR, { recursive: true });

  // Write test prompt files
  writeFileSync(join(TMP_FLEET_DIR, "common-rules.txt"), "COMMON RULES CONTENT\nrule 1\nrule 2");
  writeFileSync(join(TMP_FLEET_DIR, "test-alpha.txt"), "ALPHA PROMPT\nmission: trade stuff");
  writeFileSync(join(TMP_FLEET_DIR, "test-bravo.txt"), "BRAVO PROMPT\nmission: explore");
  writeFileSync(join(TMP_FLEET_DIR, "personality-rules.txt"), "PERSONALITY RULES");
});

afterEach(() => {
  if (existsSync(TMP_FLEET_DIR)) rmSync(TMP_FLEET_DIR, { recursive: true });
});

// ---------------------------------------------------------------------------
// GET /api/prompts/agents
// ---------------------------------------------------------------------------

describe("GET /api/prompts/agents", () => {
  it("returns agent list with prompt file paths", async () => {
    const app = makeTestApp();
    const res = await supertest(app).get("/api/prompts/agents");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("agents");
    expect(res.body.agents).toBeInstanceOf(Array);
    expect(res.body.agents).toHaveLength(2);
  });

  it("includes name, promptFile, model, role for each agent", async () => {
    const app = makeTestApp();
    const res = await supertest(app).get("/api/prompts/agents");

    const alpha = res.body.agents.find((a: any) => a.name === "test-alpha");
    expect(alpha).toBeDefined();
    expect(alpha.promptFile).toBe("test-alpha.txt");
    expect(alpha.model).toBe("haiku");
    expect(alpha.role).toBe("Trader/Mining");
  });

  it("includes systemPrompt field (null when not set)", async () => {
    const app = makeTestApp();
    const res = await supertest(app).get("/api/prompts/agents");

    const alpha = res.body.agents.find((a: any) => a.name === "test-alpha");
    expect(alpha.systemPrompt).toBe("You are Test Alpha. Keep it short.");

    const bravo = res.body.agents.find((a: any) => a.name === "test-bravo");
    expect(bravo.systemPrompt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /api/prompts/files
// ---------------------------------------------------------------------------

describe("GET /api/prompts/files", () => {
  it("returns array of .txt files with content", async () => {
    const app = makeTestApp();
    const res = await supertest(app).get("/api/prompts/files");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("files");
    expect(res.body.files).toBeInstanceOf(Array);
    expect(res.body.files.length).toBeGreaterThanOrEqual(3);
  });

  it("includes filename and content for each file", async () => {
    const app = makeTestApp();
    const res = await supertest(app).get("/api/prompts/files");

    const cr = res.body.files.find((f: any) => f.filename === "common-rules.txt");
    expect(cr).toBeDefined();
    expect(cr.content).toContain("COMMON RULES CONTENT");
  });

  it("only returns .txt files", async () => {
    // Write a non-.txt file
    writeFileSync(join(TMP_FLEET_DIR, "fleet-credentials.json"), "{}");
    const app = makeTestApp();
    const res = await supertest(app).get("/api/prompts/files");

    const nonTxt = res.body.files.filter((f: any) => !f.filename.endsWith(".txt"));
    expect(nonTxt).toHaveLength(0);
  });

  it("accessible to viewers", async () => {
    const app = makeTestApp("viewer");
    const res = await supertest(app).get("/api/prompts/files");
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /api/prompts/common-rules
// ---------------------------------------------------------------------------

describe("GET /api/prompts/common-rules", () => {
  it("returns content of common-rules.txt", async () => {
    const app = makeTestApp();
    const res = await supertest(app).get("/api/prompts/common-rules");

    expect(res.status).toBe(200);
    expect(res.body.filename).toBe("common-rules.txt");
    expect(res.body.content).toContain("COMMON RULES CONTENT");
  });

  it("returns 404 when file is missing", async () => {
    rmSync(join(TMP_FLEET_DIR, "common-rules.txt"));
    const app = makeTestApp();
    const res = await supertest(app).get("/api/prompts/common-rules");

    expect(res.status).toBe(404);
  });

  it("accessible to viewers", async () => {
    const app = makeTestApp("viewer");
    const res = await supertest(app).get("/api/prompts/common-rules");
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /api/prompts/assembled/:agentName
// ---------------------------------------------------------------------------

describe("GET /api/prompts/assembled/:agentName", () => {
  it("returns assembled prompt for a valid agent", async () => {
    const app = makeTestApp();
    const res = await supertest(app).get("/api/prompts/assembled/test-alpha");

    expect(res.status).toBe(200);
    expect(res.body.agentName).toBe("test-alpha");
    expect(res.body.assembled).toBeDefined();
    expect(typeof res.body.assembled).toBe("string");
  });

  it("assembled contains all three parts", async () => {
    const app = makeTestApp();
    const res = await supertest(app).get("/api/prompts/assembled/test-alpha");

    expect(res.body.assembled).toContain("COMMON RULES CONTENT");
    expect(res.body.assembled).toContain("ALPHA PROMPT");
    expect(res.body.assembled).toContain("You are Test Alpha");
  });

  it("returns parts breakdown separately", async () => {
    const app = makeTestApp();
    const res = await supertest(app).get("/api/prompts/assembled/test-alpha");

    expect(res.body.parts).toBeDefined();
    expect(res.body.parts.commonRules).toContain("COMMON RULES CONTENT");
    expect(res.body.parts.agentPrompt).toContain("ALPHA PROMPT");
    expect(res.body.parts.systemPrompt).toContain("You are Test Alpha");
  });

  it("handles agent without systemPrompt — parts.systemPrompt is null", async () => {
    const app = makeTestApp();
    const res = await supertest(app).get("/api/prompts/assembled/test-bravo");

    expect(res.status).toBe(200);
    expect(res.body.parts.systemPrompt).toBeNull();
  });

  it("returns 404 for unknown agent", async () => {
    const app = makeTestApp();
    const res = await supertest(app).get("/api/prompts/assembled/nonexistent");

    expect(res.status).toBe(404);
  });

  it("accessible to viewers", async () => {
    const app = makeTestApp("viewer");
    const res = await supertest(app).get("/api/prompts/assembled/test-alpha");
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/prompts/files/:filename
// ---------------------------------------------------------------------------

describe("PUT /api/prompts/files/:filename", () => {
  it("admin can update an existing file", async () => {
    const app = makeTestApp("admin");
    const res = await supertest(app)
      .put("/api/prompts/files/test-alpha.txt")
      .send({ content: "UPDATED CONTENT\nnew mission" })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.filename).toBe("test-alpha.txt");

    const saved = readFileSync(join(TMP_FLEET_DIR, "test-alpha.txt"), "utf-8");
    expect(saved).toBe("UPDATED CONTENT\nnew mission");
  });

  it("admin can create a new .txt file", async () => {
    const app = makeTestApp("admin");
    const res = await supertest(app)
      .put("/api/prompts/files/new-agent.txt")
      .send({ content: "NEW AGENT CONTENT" })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(200);
    const saved = readFileSync(join(TMP_FLEET_DIR, "new-agent.txt"), "utf-8");
    expect(saved).toBe("NEW AGENT CONTENT");
  });

  it("rejects viewer access with 403", async () => {
    const app = makeTestApp("viewer");
    const res = await supertest(app)
      .put("/api/prompts/files/test-alpha.txt")
      .send({ content: "hacked" })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(403);
  });

  it("rejects filenames with path traversal (..) ", async () => {
    const app = makeTestApp("admin");
    const res = await supertest(app)
      .put("/api/prompts/files/..%2Fevil.txt")
      .send({ content: "pwned" })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
  });

  it("rejects filenames without .txt extension", async () => {
    const app = makeTestApp("admin");
    const res = await supertest(app)
      .put("/api/prompts/files/malicious.sh")
      .send({ content: "#!/bin/bash" })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
  });

  it("rejects filenames with forward slash", async () => {
    const app = makeTestApp("admin");
    const res = await supertest(app)
      .put("/api/prompts/files/subdir%2Ffile.txt")
      .send({ content: "test" })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
  });

  it("rejects missing content field", async () => {
    const app = makeTestApp("admin");
    const res = await supertest(app)
      .put("/api/prompts/files/test-alpha.txt")
      .send({ not_content: "oops" })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
  });

  it("rejects non-string content", async () => {
    const app = makeTestApp("admin");
    const res = await supertest(app)
      .put("/api/prompts/files/test-alpha.txt")
      .send({ content: 42 })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
  });
});
