/**
 * Prompt composer for layered agent prompts.
 *
 * Composes a final system prompt from multiple layers in priority order:
 *   1. base-agent.txt       — universal base identity + critical rules
 *   2. roles/{roleType}.txt — role-specific priorities and behavior overlay
 *   3. {agent}.txt          — agent-specific mission and ship stats
 *   4. {agent}-values.txt   — personality, voice, decision biases
 *   5. common-rules.txt     — shared tool rules (v2 syntax, compound tools, etc.)
 *   6. personality-rules.txt — shared rules for personality expression
 *
 * Template variables substituted from agent config:
 *   {{AGENT_NAME}} — agent name (title-cased)
 *   {{ROLE}}       — agent role string from fleet-config.json
 *   {{FACTION}}    — faction name
 *   {{EMPIRE}}     — alias for FACTION (base-agent.txt uses {{EMPIRE}})
 *
 * Falls back to flat file composition (just agent.txt + common-rules.txt) if
 * base-agent.txt does not exist — preserves backwards compatibility.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "./logger.js";

const log = createLogger("prompt-composer");

export interface PromptComposerOptions {
  /** Absolute path to the fleet-agents directory */
  fleetDir: string;
  /** Agent name (e.g. "my-agent") */
  agentName: string;
  /** roleType from fleet-config.json (e.g. "trader", "combat") */
  roleType?: string;
  /** role description string (e.g. "Trader/Mining") */
  role?: string;
  /** faction name */
  faction?: string;
}

export interface ComposedPrompt {
  /** Final composed prompt text */
  prompt: string;
  /** Which layers were included (for debugging) */
  layers: string[];
  /** Whether layered composition was used (false = flat fallback) */
  layered: boolean;
}

function readOptional(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Substitute template variables in a prompt string.
 */
export function substituteVars(text: string, vars: Record<string, string>): string {
  let result = text;
  for (const [key, value] of Object.entries(vars)) {
    // Replace all occurrences of {{KEY}}
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

/**
 * Convert agent name to a display form (e.g. "my-agent" → "Cinder Wake").
 */
export function toDisplayName(agentName: string): string {
  return agentName
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Compose the agent system prompt from layered files.
 *
 * Returns a ComposedPrompt with the final text and metadata about which
 * layers were used. Falls back to flat file if base-agent.txt doesn't exist.
 */
export function composePrompt(opts: PromptComposerOptions): ComposedPrompt {
  const { fleetDir, agentName, roleType, role, faction } = opts;

  const baseAgentPath = join(fleetDir, "roles", "base-agent.txt");
  const agentPath = join(fleetDir, `${agentName}.txt`);
  const valuesPath = join(fleetDir, `${agentName}-values.txt`);
  const commonRulesPath = join(fleetDir, "common-rules.txt");
  const personalityRulesPath = join(fleetDir, "personality-rules.txt");

  const templateVars: Record<string, string> = {
    AGENT_NAME: toDisplayName(agentName),
    CHARACTER_NAME: toDisplayName(agentName),
    ROLE: role ?? roleType ?? "Agent",
    FACTION: faction ?? "Independent",
    EMPIRE: faction ?? "Independent",
  };

  // --- Layered composition ---
  const baseAgent = readOptional(baseAgentPath);
  const agentSpecific = readOptional(agentPath);

  const layers: string[] = [];
  const parts: string[] = [];

  /** Append a section to parts/layers if the file content is non-null. */
  function addSection(content: string | null, label: string, header: string | null): void {
    if (!content) return;
    const text = substituteVars(content, templateVars);
    parts.push(header ? `\n\n---\n# ${header}\n\n${text}` : text);
    layers.push(label);
  }

  if (!baseAgent) {
    // Flat fallback: agent.txt + values + common-rules + personality-rules
    log.info(`[${agentName}] no base-agent.txt found, using flat fallback`);

    addSection(agentSpecific, `${agentName}.txt`, null);
    addSection(readOptional(valuesPath), `${agentName}-values.txt`, "Personality");
    addSection(readOptional(commonRulesPath), "common-rules.txt", "Common Rules");
    addSection(readOptional(personalityRulesPath), "personality-rules.txt", "Personality Rules");

    return { prompt: parts.join(""), layers, layered: false };
  }

  // --- Full layered composition ---

  // Layer 1: base-agent.txt
  addSection(baseAgent, "roles/base-agent.txt", null);

  // Layer 2: role overlay (roles/{roleType}.txt)
  if (roleType) {
    const rolePath = join(fleetDir, "roles", `${roleType}.txt`);
    const roleText = readOptional(rolePath);
    if (roleText) {
      addSection(roleText, `roles/${roleType}.txt`, `Role: ${roleType}`);
    } else {
      log.info(`[${agentName}] no role file for roleType="${roleType}" at ${rolePath}`);
    }
  }

  // Layer 3: agent-specific prompt
  addSection(agentSpecific, `${agentName}.txt`, `Agent: ${toDisplayName(agentName)}`);

  // Layer 4: personality/values
  addSection(readOptional(valuesPath), `${agentName}-values.txt`, "Personality");

  // Layer 5: common-rules.txt
  addSection(readOptional(commonRulesPath), "common-rules.txt", "Common Rules");

  // Layer 6: personality-rules.txt
  addSection(readOptional(personalityRulesPath), "personality-rules.txt", "Personality Rules");

  log.info(`[${agentName}] composed layered prompt`, {
    layers: layers.length,
    files: layers.join(", "),
  });

  return { prompt: parts.join(""), layers, layered: true };
}
