/**
 * Prompt deployer service.
 * Handles auto-generation of agent prompt files from templates.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../lib/logger.js";
import { substituteVars, toDisplayName } from "../lib/prompt-composer.js";
import { logEnrollmentEvent } from "./enrollment-audit.js";

const log = createLogger("prompt-deployer");

const ROLE_DESCRIPTIONS: Record<string, string> = {
  trader: "Run profitable trade routes, buy low and sell high across systems, and maximize credit gain through market arbitrage.",
  miner: "Mine asteroids in resource-rich belts, extract valuable ores, and sell them at the best available prices to fuel fleet growth.",
  explorer: "Scout new systems, survey planetary resources, and identify high-value opportunities for the rest of the fleet.",
  combat: "Patrol for threats, protect fleet assets from pirates, and engage in tactical combat when necessary to ensure fleet survival.",
  hauler: "Move large volumes of cargo between stations efficiently, supporting the logistics chain of the entire fleet.",
  salvager: "Search for debris and shipwrecks to recover valuable components and materials that others have left behind.",
  crafter: "Utilize raw materials to manufacture advanced components, ships, and equipment for the fleet's needs.",
  diplomat: "Manage faction relations, negotiate favorable terms, and represent the fleet's interests in the political arena.",
  prospector: "Scan celestial bodies for rare minerals and deep-space anomalies, marking them for later exploitation.",
};

export interface DeployOptions {
  fleetDir: string;
  agentName: string;
  roleType: string;
  role?: string;
  faction?: string;
  actor?: string;
}

/**
 * Generate and deploy prompt files for a new agent.
 * Fails if the prompt file already exists.
 */
export async function deployPrompt(opts: DeployOptions): Promise<void> {
  const { fleetDir, agentName, roleType, role, faction, actor } = opts;
  
  const promptPath = join(fleetDir, `${agentName}.txt`);
  const valuesPath = join(fleetDir, `${agentName}-values.txt`);
  const templatePath = join(fleetDir, "agent-template.txt");

  if (existsSync(promptPath)) {
    throw new Error(`Prompt file already exists for ${agentName}: ${promptPath}`);
  }

  if (!existsSync(templatePath)) {
    throw new Error(`Agent template file not found at ${templatePath}`);
  }

  log.info(`Deploying prompt for ${agentName} (roleType: ${roleType})`);

  const template = readFileSync(templatePath, "utf-8");
  const missionDescription = ROLE_DESCRIPTIONS[roleType] || `Perform duties as a ${role ?? roleType}.`;

  const templateVars: Record<string, string> = {
    AGENT_NAME: toDisplayName(agentName),
    CHARACTER_NAME: toDisplayName(agentName),
    ROLE: role ?? roleType ?? "Agent",
    EMPIRE: faction ?? "Independent",
    MISSION_DESCRIPTION: missionDescription,
  };

  const composedPrompt = substituteVars(template, templateVars);
  
  // Write agent prompt
  writeFileSync(promptPath, composedPrompt, "utf-8");

  // Write default values if they don't exist
  if (!existsSync(valuesPath)) {
    const defaultValues = `# Personality for ${toDisplayName(agentName)}\n\n` +
      `You are a focused ${roleType} dedicated to the success of your fleet.\n` +
      `Your voice is professional, efficient, and oriented towards your mission goals.`;
    writeFileSync(valuesPath, defaultValues, "utf-8");
  }

  logEnrollmentEvent(agentName, "prompt_deployed", actor ?? null, {
    roleType,
    role,
    faction
  });

  log.info(`Successfully deployed prompt for ${agentName}`);
}
