import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { deployPrompt } from "./prompt-deployer.js";
import { createDatabase, closeDb } from "./database.js";

const TMP_FLEET_DIR = join(import.meta.dir, "tmp-fleet-deployer");

describe("prompt-deployer", () => {
  beforeEach(() => {
    createDatabase(":memory:");
    if (existsSync(TMP_FLEET_DIR)) rmSync(TMP_FLEET_DIR, { recursive: true });
    mkdirSync(TMP_FLEET_DIR);
    
    // Create template
    writeFileSync(
      join(TMP_FLEET_DIR, "agent-template.txt"),
      "Name: {{AGENT_NAME}}\nRole: {{ROLE}}\nMission: {{MISSION_DESCRIPTION}}"
    );
  });

  afterEach(() => {
    closeDb();
    if (existsSync(TMP_FLEET_DIR)) rmSync(TMP_FLEET_DIR, { recursive: true });
  });

  it("successfully deploys a prompt from template", async () => {
    await deployPrompt({
      fleetDir: TMP_FLEET_DIR,
      agentName: "test-agent",
      roleType: "trader",
    });

    const promptPath = join(TMP_FLEET_DIR, "test-agent.txt");
    const valuesPath = join(TMP_FLEET_DIR, "test-agent-values.txt");

    expect(existsSync(promptPath)).toBe(true);
    expect(existsSync(valuesPath)).toBe(true);

    const prompt = readFileSync(promptPath, "utf-8");
    expect(prompt).toContain("Name: Test Agent");
    expect(prompt).toContain("Role: trader");
    expect(prompt).toContain("Mission: Run profitable trade routes");
  });

  it("throws error if prompt already exists", async () => {
    writeFileSync(join(TMP_FLEET_DIR, "test-agent.txt"), "existing");
    
    await expect(deployPrompt({
      fleetDir: TMP_FLEET_DIR,
      agentName: "test-agent",
      roleType: "trader",
    })).rejects.toThrow("already exists");
  });

  it("throws error if template is missing", async () => {
    rmSync(join(TMP_FLEET_DIR, "agent-template.txt"));
    
    await expect(deployPrompt({
      fleetDir: TMP_FLEET_DIR,
      agentName: "test-agent",
      roleType: "trader",
    })).rejects.toThrow("template file not found");
  });
});
