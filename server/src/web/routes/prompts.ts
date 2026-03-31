/**
 * Prompt management API routes.
 *
 * Provides read/write access to fleet-agent prompt files and assembled prompt previews.
 * Write endpoints are admin-only with path-traversal validation.
 */
import { Router } from "express";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import type { GantryConfig } from "../../config.js";
import { createLogger } from "../../lib/logger.js";
import { atomicWriteFileSync } from "../../lib/atomic-write.js";

const log = createLogger("prompts");

/**
 * Validate a prompt filename to prevent path traversal.
 * Must end in .txt, contain no slashes, no '..', and be a bare filename.
 */
function isValidPromptFilename(filename: string): boolean {
  if (!filename.endsWith(".txt")) return false;
  if (filename.includes("/") || filename.includes("\\")) return false;
  if (filename.includes("..")) return false;
  if (basename(filename) !== filename) return false;
  return true;
}

export function createPromptsRouter(fleetDir: string, config: GantryConfig): Router {
  const router = Router();

  /**
   * Read a file from the fleet directory, returning null if not found.
   */
  function readFleetFile(filename: string): string | null {
    const filePath = join(fleetDir, filename);
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, "utf-8");
  }

  // GET /api/prompts/agents — list all agents with their prompt file paths
  router.get("/agents", (_req, res) => {
    const agents = config.agents.map((agent) => {
      const promptFile = `${agent.name}.txt`;
      const promptPath = join(fleetDir, promptFile);
      return {
        name: agent.name,
        promptFile,
        promptFileExists: existsSync(promptPath),
        model: agent.model ?? null,
        role: agent.role ?? null,
        systemPrompt: agent.systemPrompt ?? null,
      };
    });

    res.json({ agents });
  });

  // GET /api/prompts/files — list all .txt files in fleet-agents directory with content
  router.get("/files", (_req, res) => {
    const files: Array<{ filename: string; content: string }> = [];
    try {
      const entries = readdirSync(fleetDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".txt")) {
          const content = readFileSync(join(fleetDir, entry.name), "utf-8");
          files.push({ filename: entry.name, content });
        }
      }
    } catch (err) {
      log.error("Failed to list fleet files", { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: "Failed to read fleet directory" });
      return;
    }

    res.json({ files });
  });

  // GET /api/prompts/common-rules — return content of common-rules.txt
  router.get("/common-rules", (_req, res) => {
    const content = readFleetFile("common-rules.txt");
    if (content === null) {
      res.status(404).json({ error: "common-rules.txt not found" });
      return;
    }
    res.json({ filename: "common-rules.txt", content });
  });

  // GET /api/prompts/assembled/:agentName — full assembled prompt for an agent
  router.get("/assembled/:agentName", (req, res) => {
    const { agentName } = req.params;

    const agent = config.agents.find((a) => a.name === agentName);
    if (!agent) {
      res.status(404).json({ error: `Agent '${agentName}' not found` });
      return;
    }

    const commonRules = readFleetFile("common-rules.txt") ?? "";
    const agentPrompt = readFleetFile(`${agentName}.txt`) ?? "";
    const systemPrompt = agent.systemPrompt ?? "";

    const parts: string[] = [];
    if (systemPrompt) {
      parts.push(`=== SYSTEM PROMPT ===\n${systemPrompt}`);
    }
    if (commonRules) {
      parts.push(`=== COMMON RULES ===\n${commonRules}`);
    }
    if (agentPrompt) {
      parts.push(`=== AGENT PROMPT ===\n${agentPrompt}`);
    }

    const assembled = parts.join("\n\n");

    res.json({
      agentName,
      assembled,
      parts: {
        systemPrompt: systemPrompt || null,
        commonRules: commonRules || null,
        agentPrompt: agentPrompt || null,
      },
    });
  });

  // PUT /api/prompts/files/:filename — admin-only write endpoint
  router.put("/files/:filename", (req, res) => {
    if (req.auth?.role !== "admin") {
      res.status(403).json({ error: "Admin access required" });
      return;
    }

    const { filename } = req.params;

    if (!isValidPromptFilename(filename)) {
      res.status(400).json({ error: "Invalid filename. Must be a .txt file with no path components." });
      return;
    }

    const { content } = req.body;
    if (typeof content !== "string") {
      res.status(400).json({ error: "content is required and must be a string" });
      return;
    }

    const filePath = join(fleetDir, filename);

    try {
      atomicWriteFileSync(filePath, content);
      log.info("Prompt file updated", { filename, by: req.auth?.identity ?? "admin" });
      res.json({ ok: true, filename });
    } catch (err) {
      log.error("Failed to write prompt file", { filename, error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: "Failed to write file" });
    }
  });

  return router;
}

export default createPromptsRouter;
