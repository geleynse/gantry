/**
 * Agent enrollment routes.
 * Handles new agent registration, configuration, and prompt deployment.
 */
import { Router } from "express";
import { readFileSync, existsSync } from "node:fs";
import { atomicWriteFileSync } from "../../lib/atomic-write.js";
import { join } from "node:path";
import * as env from "../../config/env.js";
import { loadConfig, saveConfig, getAgentNames, resolveConfigPath } from "../../config/fleet.js";
import { AgentConfigSchema } from "../../config/schemas.js";
import { registerAccount } from "../../services/game-registration.js";
import { logEnrollmentEvent } from "../../services/enrollment-audit.js";
import { deployPrompt } from "../../services/prompt-deployer.js";
import { createLogger } from "../../lib/logger.js";
import { encryptPassword, getCredentialsFilePath } from "../../services/credentials-crypto.js";

const log = createLogger("enrollment-routes");

const router = Router();

// Computed once at module load; used by both enrollment-options and enroll handlers
const ROLE_TYPES: string[] = (AgentConfigSchema.shape.roleType as any).unwrap().options;

interface EnrollRequest {
  agentName: string; // lowercase-with-hyphens
  // New account registration:
  registrationCode?: string;
  username: string;
  empire?: string;
  // OR existing account:
  password?: string;
  // Fleet config:
  role: string;
  roleType: string;
  faction: string;
  mcpPreset: "basic" | "standard" | "full";
  model?: string;
}

/**
 * GET /api/agents/enrollment-options
 * Returns available enums and suggestions for the enrollment form.
 */
router.get("/enrollment-options", (req, res) => {
  const mcpPresets = ["basic", "standard", "full"];
  const empires = ["Solarian", "Nebula", "Crimson", "Voidborn", "Outerrim"];
  const factions = empires; // For now, empires are the primary factions

  const suggestions: Record<string, string> = {
    Solarian: "trader",
    Nebula: "explorer",
    Crimson: "combat",
    Voidborn: "stealth", // Future
    Outerrim: "crafter", // Future
  };

  res.json({
    roleTypes: ROLE_TYPES,
    mcpPresets,
    empires,
    factions,
    suggestions,
  });
});

/**
 * POST /api/agents/enroll
 * Admin-only route to enroll a new agent.
 */
router.post("/enroll", async (req, res) => {
  const { 
    agentName, 
    registrationCode, 
    username, 
    empire, 
    password: providedPassword,
    role,
    roleType,
    faction,
    mcpPreset,
    model = "claude-haiku-4-5"
  } = req.body as EnrollRequest;

  const FLEET_DIR = env.FLEET_DIR;

  // 1. Validation
  if (!agentName || !username || (!registrationCode && !providedPassword)) {
    res.status(400).json({ error: "Missing required fields: agentName, username, and either registrationCode or password" });
    return;
  }

  // Name validation: lowercase-with-hyphens, 3-20 chars
  const nameRegex = /^[a-z0-9-]+$/;
  if (!nameRegex.test(agentName) || agentName.length < 3 || agentName.length > 20) {
    res.status(400).json({ error: "Invalid agent name. Use lowercase, numbers, and hyphens (3-20 chars)." });
    return;
  }

  // Check uniqueness
  if (getAgentNames().includes(agentName)) {
    res.status(409).json({ error: `Agent name "${agentName}" is already taken.` });
    return;
  }

  // Validate roleType enum
  if (!ROLE_TYPES.includes(roleType as any)) {
    res.status(400).json({ error: `Invalid roleType: ${roleType}` });
    return;
  }

  try {
    let password = providedPassword;
    let registered = false;

    // 2. Handle Game Registration
    if (registrationCode) {
      const result = await registerAccount(username, empire || "Solarian", registrationCode);
      password = result.password;
      registered = true;
    }

    if (!password) {
      throw new Error("Password could not be obtained.");
    }

    // 3. Update fleet-config.json
    const configPath = resolveConfigPath(FLEET_DIR);
    const rawConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    
    const newAgent = {
      name: agentName,
      role,
      roleType,
      faction,
      mcpPreset,
      mcpVersion: "v2",
      backend: "claude",
      model,
    };

    rawConfig.agents.push(newAgent);
    saveConfig(rawConfig);

    // 4. Update credentials file
    // getCredentialsFilePath() returns the enc file if it exists, otherwise plain
    const credentialsPath = getCredentialsFilePath(FLEET_DIR);
    let credentials: Record<string, any> = {};
    if (existsSync(credentialsPath)) {
      credentials = JSON.parse(readFileSync(credentialsPath, "utf-8"));
    }

    credentials[agentName] = {
      username,
      password: encryptPassword(password),
    };
    atomicWriteFileSync(credentialsPath, JSON.stringify(credentials, null, 2));

    // 5. Audit log
    logEnrollmentEvent(agentName, "enrolled", req.auth?.identity || "admin", {
      username,
      registered,
      roleType,
    });

    // 6. Auto-deploy prompt
    try {
      await deployPrompt({
        fleetDir: FLEET_DIR,
        agentName,
        roleType,
        role,
        faction,
        actor: req.auth?.identity || "admin",
      });
    } catch (deployErr) {
      log.error(`Failed to auto-deploy prompt for ${agentName}: ${deployErr}`);
      // Don't fail the whole enrollment if prompt deployment fails
    }

    res.json({
      success: true,
      agent: newAgent,
      registered,
      password: registered ? password : undefined, // Only return password if we registered it now
    });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Enrollment failed for ${agentName}: ${message}`, err as Record<string, unknown>);
    res.status(500).json({ error: message });
  }
});

/**
 * POST /api/agents/:name/deploy-prompt
 * Admin-only route to manually (re)deploy a prompt.
 */
router.post("/:name/deploy-prompt", async (req, res) => {
  const { name } = req.params;
  const FLEET_DIR = env.FLEET_DIR;
  const config = loadConfig(FLEET_DIR);
  const agent = config.agents.find(a => a.name === name);

  if (!agent) {
    res.status(404).json({ error: `Agent "${name}" not found.` });
    return;
  }

  try {
    await deployPrompt({
      fleetDir: FLEET_DIR,
      agentName: name,
      roleType: agent.roleType || "trader",
      role: agent.role,
      faction: agent.faction,
      actor: req.auth?.identity || "admin",
    });
    res.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

/**
 * GET /api/agents/:name/prompt-preview
 * Admin-only route to preview a generated prompt from template.
 */
router.get("/:name/prompt-preview", async (req, res) => {
  const { name } = req.params;
  const FLEET_DIR = env.FLEET_DIR;
  const config = loadConfig(FLEET_DIR);
  const agent = config.agents.find(a => a.name === name);

  if (!agent) {
    res.status(404).json({ error: `Agent "${name}" not found.` });
    return;
  }

  try {
    const templatePath = join(FLEET_DIR, "agent-template.txt");
    if (!existsSync(templatePath)) {
      throw new Error("Agent template not found.");
    }
    const template = readFileSync(templatePath, "utf-8");
    
    // Minimal substitution for preview
    const roleDescriptions: Record<string, string> = {
      trader: "Run profitable trade routes...",
      miner: "Mine asteroids and sell refined ores...",
      explorer: "Scout new systems and survey resources...",
      combat: "Patrol for threats and protect fleet...",
      hauler: "Move cargo between stations...",
    };

    const missionDescription = roleDescriptions[agent.roleType || "trader"] || `Perform duties as a ${agent.role || agent.roleType}.`;
    
    const vars: Record<string, string> = {
      AGENT_NAME: name,
      CHARACTER_NAME: name,
      ROLE: agent.role || agent.roleType || "Agent",
      EMPIRE: agent.faction || "Independent",
      MISSION_DESCRIPTION: missionDescription,
    };

    let preview = template;
    for (const [k, v] of Object.entries(vars)) {
      preview = preview.replaceAll(`{{${k}}}`, v);
    }

    res.json({ preview });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;

export function createEnrollmentRouter() {
  return router;
}
