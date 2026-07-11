import { describe, test, expect, beforeEach } from "bun:test";
import { writeFileSync, readFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { FleetConfigSchema, AgentConfigSchema } from "./schemas.js";
import {
  loadConfig,
  saveConfig,
  setConfigForTesting,
  applyConfig,
  getConfig,
  AGENTS,
  AGENT_NAMES,
  TURN_SLEEP_MS,
} from "./fleet.js";
import type { AgentConfig, GantryConfig } from "./types.js";

describe("Config Schemas", () => {
  describe("AgentConfigSchema", () => {
    test("validates agent with required fields only", () => {
      const agent = { name: "test-agent" };
      const result = AgentConfigSchema.safeParse(agent);
      expect(result.success).toBe(true);
    });

    test("validates agent with new roleType field", () => {
      const agent = {
        name: "trader-agent",
        roleType: "trader",
      };
      const result = AgentConfigSchema.safeParse(agent);
      expect(result.success).toBe(true);
      expect(result.data?.roleType).toBe("trader");
    });

    test("validates agent with skillModules array", () => {
      const agent = {
        name: "mining-agent",
        skillModules: ["mining", "trading", "navigation"],
      };
      const result = AgentConfigSchema.safeParse(agent);
      expect(result.success).toBe(true);
      expect(result.data?.skillModules).toEqual(["mining", "trading", "navigation"]);
    });

    test("validates agent with factionNote", () => {
      const agent = {
        name: "explorer-agent",
        factionNote: "Leader of the faction base building efforts",
      };
      const result = AgentConfigSchema.safeParse(agent);
      expect(result.success).toBe(true);
      expect(result.data?.factionNote).toBe("Leader of the faction base building efforts");
    });

    test("validates agent with operatingZone", () => {
      const agent = {
        name: "zoned-agent",
        operatingZone: "sol-sirius",
      };
      const result = AgentConfigSchema.safeParse(agent);
      expect(result.success).toBe(true);
      expect(result.data?.operatingZone).toBe("sol-sirius");
    });

    test("validates agent with all new fields", () => {
      const agent = {
        name: "full-agent",
        roleType: "explorer",
        skillModules: ["exploration", "mining"],
        factionNote: "Scout for Solarian faction",
        operatingZone: "sol-sirius",
      };
      const result = AgentConfigSchema.safeParse(agent);
      expect(result.success).toBe(true);
      expect(result.data?.roleType).toBe("explorer");
      expect(result.data?.skillModules).toEqual(["exploration", "mining"]);
      expect(result.data?.factionNote).toBe("Scout for Solarian faction");
      expect(result.data?.operatingZone).toBe("sol-sirius");
    });

    test("preserves per-agent turnSleepMs and turnInterval (regression: zod strips unknown keys)", () => {
      const agent = {
        name: "slow-agent",
        turnSleepMs: 300,
        turnInterval: 250,
      };
      const result = AgentConfigSchema.safeParse(agent);
      expect(result.success).toBe(true);
      expect(result.data?.turnSleepMs).toBe(300);
      expect(result.data?.turnInterval).toBe(250);
    });

    test("rejects invalid roleType", () => {
      const agent = {
        name: "bad-agent",
        roleType: "invalid_role",
      };
      const result = AgentConfigSchema.safeParse(agent);
      expect(result.success).toBe(false);
    });

    test("validates backward compatibility (old agents without new fields)", () => {
      const agent = {
        name: "legacy-agent",
        backend: "claude",
        model: "sonnet",
        faction: "solarian",
        role: "Trader",
        mcpVersion: "v2" as const,
        mcpPreset: "standard" as const,
      };
      const result = AgentConfigSchema.safeParse(agent);
      expect(result.success).toBe(true);
      expect(result.data?.roleType).toBeUndefined();
      expect(result.data?.skillModules).toBeUndefined();
    });
  });

  describe("FleetConfigSchema", () => {
    test("validates fleet config with minimal agents", () => {
      const config = {
        mcpGameUrl: "https://game.example.com/mcp",
        agents: [{ name: "agent1" }],
      };
      const result = FleetConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    test("validates fleet config with agents using new fields", () => {
      const config = {
        mcpGameUrl: "https://game.example.com/mcp",
        agents: [
          {
            name: "trader",
            roleType: "trader",
            skillModules: ["trading"],
            operatingZone: "zone1",
          },
          {
            name: "miner",
            roleType: "miner",
            skillModules: ["mining"],
            operatingZone: "zone2",
          },
        ],
      };
      const result = FleetConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      expect(result.data?.agents).toHaveLength(2);
      expect(result.data?.agents[0]?.roleType).toBe("trader");
    });

    test("validates backward compatibility (fleet config without new fields)", () => {
      const config = {
        mcpGameUrl: "https://game.example.com/mcp",
        agents: [
          {
            name: "agent1",
            backend: "claude",
            model: "sonnet",
            faction: "solarian",
          },
        ],
        turnSleepMs: 90,
      };
      const result = FleetConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    test("validates prayer config", () => {
      const config = {
        mcpGameUrl: "https://game.example.com/mcp",
        agents: [{ name: "agent1", prayEnabled: true }],
        prayer: { fuzzyMatchThreshold: 0.8 },
      };
      const result = FleetConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      expect(result.data?.agents[0]?.prayEnabled).toBe(true);
      expect(result.data?.prayer?.fuzzyMatchThreshold).toBe(0.8);
    });
  });
});

describe("Config Loading (loadConfig)", () => {
  const tmpDir = join(import.meta.dir, "__test_fleet_dir__");
  const configPath = join(tmpDir, "fleet-config.json");

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  function writeConfig(config: Record<string, unknown>) {
    writeFileSync(configPath, JSON.stringify(config));
  }

  function cleanup() {
    try { rmSync(tmpDir, { recursive: true }); } catch {}
  }

  test("loadConfig preserves routineMode on agents", () => {
    writeConfig({
      mcpGameUrl: "https://game.example.com/mcp",
      agents: [
        { name: "agent-a", routineMode: true },
        { name: "agent-b", routineMode: false },
        { name: "agent-c" },
      ],
    });
    const config = loadConfig(tmpDir);
    expect(config.agents[0].routineMode).toBe(true);
    expect(config.agents[1].routineMode).toBe(false);
    expect(config.agents[2].routineMode).toBeUndefined();
    cleanup();
  });

  test("loadConfig preserves all AgentConfigSchema fields", () => {
    // Create an agent config with ALL optional fields set
    const fullAgent = {
      name: "full-agent",
      backend: "claude" as const,
      model: "sonnet",
      extraTools: "extra",
      faction: "solarian",
      role: "Trader",
      mcpVersion: "v2" as const,
      mcpPreset: "full" as const,
      toolResultFormat: "yaml" as const,
      homeSystem: "sol",
      roleType: "trader" as const,
      skillModules: ["trading", "mining"],
      factionNote: "Test faction note",
      operatingZone: "sol-sirius",
      routineMode: true,
      systemPrompt: "Be concise.",
    };
    writeConfig({
      mcpGameUrl: "https://game.example.com/mcp",
      agents: [fullAgent],
    });
    const config = loadConfig(tmpDir);
    const loaded = config.agents[0];

    // Verify every field from the schema is preserved through loadConfig
    const schemaKeys = Object.keys(AgentConfigSchema.shape);
    for (const key of schemaKeys) {
      // socksPort is computed from proxy config, skip it
      if (key === "socksPort" || key === "proxy") continue;
      const expected = fullAgent[key as keyof typeof fullAgent];
      if (expected !== undefined) {
        expect({ key, value: loaded[key as keyof AgentConfig] }).toEqual({ key, value: expected });
      }
    }
    cleanup();
  });

  test("loadConfig loads minimal config without errors", () => {
    writeConfig({
      mcpGameUrl: "https://game.example.com/mcp",
      agents: [{ name: "minimal" }],
    });
    const config = loadConfig(tmpDir);
    expect(config.agents).toHaveLength(1);
    expect(config.agents[0].name).toBe("minimal");
    cleanup();
  });

  test("loadConfig preserves per-agent turnSleepMs override", () => {
    writeConfig({
      mcpGameUrl: "https://game.example.com/mcp",
      agents: [
        { name: "overseer", turnSleepMs: 300 },
        { name: "worker" },
      ],
      turnSleepMs: 150,
    });
    const config = loadConfig(tmpDir);
    expect(config.agents[0].turnSleepMs).toBe(300);
    expect(config.agents[1].turnSleepMs).toBeUndefined();
    expect(config.turnSleepMs).toBe(150);
    cleanup();
  });

  test("loadConfig preserves the survivability block (auto-cloak gate)", () => {
    writeConfig({
      mcpGameUrl: "https://game.example.com/mcp",
      agents: [{ name: "agent1" }],
      survivability: {
        autoCloakEnabled: true,
        agentOverrides: { "agent1": false },
      },
    });
    const config = loadConfig(tmpDir);
    expect(config.survivability).toBeDefined();
    expect(config.survivability?.autoCloakEnabled).toBe(true);
    expect(config.survivability?.agentOverrides).toEqual({ "agent1": false });
    cleanup();
  });

  test("loadConfig derives gameApiUrl from a /mcp suffix, tolerating a trailing slash", () => {
    writeConfig({
      mcpGameUrl: "https://game.example.com/mcp/",
      agents: [{ name: "agent1" }],
    });
    const config = loadConfig(tmpDir);
    expect(config.gameApiUrl).toBe("https://game.example.com/api/v1");
    expect(config.gameMcpUrl).toBe("https://game.example.com/mcp");
    cleanup();
  });

  test("saveConfig rejects schema-invalid config and leaves the file untouched", () => {
    const validConfig = {
      mcpGameUrl: "https://game.example.com/mcp",
      agents: [{ name: "agent1" }],
    };
    writeConfig(validConfig);

    const invalid = {
      mcpGameUrl: "https://game.example.com/mcp",
      agents: [{ name: "agent1", mcpPreset: "not-a-preset" }],
    };
    expect(() => saveConfig(invalid, tmpDir)).toThrow(/Refusing to save invalid config/);
    expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual(validConfig);
    cleanup();
  });

  test("saveConfig writes valid config verbatim, preserving unknown top-level keys", () => {
    writeConfig({
      mcpGameUrl: "https://game.example.com/mcp",
      agents: [{ name: "agent1" }],
    });

    const updated = {
      mcpGameUrl: "https://game.example.com/mcp",
      agents: [{ name: "agent1" }, { name: "agent2" }],
      someUnknownKey: { keep: true },
    };
    saveConfig(updated, tmpDir);
    expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual(updated);
    cleanup();
  });

  test("loadConfig preserves prayer feature config", () => {
    writeConfig({
      mcpGameUrl: "https://game.example.com/mcp",
      agents: [{ name: "minimal", prayEnabled: true }],
      prayer: { fuzzyMatchThreshold: 0.75 },
    });
    const config = loadConfig(tmpDir);
    expect(config.agents[0].prayEnabled).toBe(true);
    expect(config.prayer?.fuzzyMatchThreshold).toBe(0.75);
    cleanup();
  });
});

// Regression: bug #124 — there used to be TWO independently-loaded config objects
// (index.ts's own loadConfig() vs config/fleet.ts's cachedConfig). A runtime edit
// only half-applied: the module-global getConfig()/AGENTS/TURN_SLEEP_MS consumers
// saw the new value while the object index.ts passed into createApp → pipeline /
// routes / MCP kept the boot-time value. The fix: index.ts consumes getConfig()
// (the single cached object) and the watcher applies reloads IN PLACE via
// applyConfig(), so a runtime edit is seen coherently by both worlds.
describe("Config single source of truth (#124)", () => {
  const tmpDir = join(import.meta.dir, "__test_fleet_single_source__");
  const configPath = join(tmpDir, "fleet-config.json");

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  function writeConfig(config: Record<string, unknown>) {
    writeFileSync(configPath, JSON.stringify(config));
  }

  function cleanup() {
    try { rmSync(tmpDir, { recursive: true }); } catch {}
  }

  test("a watcher reload is visible on the object index.ts already handed to the app", () => {
    // Boot: cachedConfig is loaded and index.ts grabs getConfig() once.
    writeConfig({
      mcpGameUrl: "https://game.example.com/mcp",
      turnSleepMs: 111,
      agents: [{ name: "alpha" }],
    });
    setConfigForTesting(loadConfig(tmpDir));

    // index.ts: `const config = getConfig()` — this exact object is threaded
    // into createApp → createMcpServer (pipelineCtx.config) and createApiRoutes.
    const appHeldConfig = getConfig();
    expect(appHeldConfig.turnSleepMs).toBe(111);
    expect(appHeldConfig.agents).toHaveLength(1);
    // Module-global consumers agree at boot.
    expect(TURN_SLEEP_MS).toBe(111);
    expect(AGENTS).toHaveLength(1);

    // Operator edits gantry.json at runtime → watchFile fires → applyConfig(reloaded).
    writeConfig({
      mcpGameUrl: "https://game.example.com/mcp",
      turnSleepMs: 222,
      agents: [{ name: "alpha" }, { name: "beta" }],
    });
    applyConfig(loadConfig(tmpDir));

    // SINGLE SOURCE: the reference the app is still holding reflects the edit —
    // no half-apply. (Before the fix this stayed 111 / 1 agent.)
    expect(appHeldConfig.turnSleepMs).toBe(222);
    expect(appHeldConfig.agents.map((a) => a.name)).toEqual(["alpha", "beta"]);

    // Object identity is preserved — there is exactly one config object.
    expect(getConfig()).toBe(appHeldConfig);

    // Module-global consumers updated coherently with the app's view.
    expect(TURN_SLEEP_MS).toBe(222);
    expect(AGENTS).toHaveLength(2);
    expect(AGENT_NAMES.has("beta")).toBe(true);

    cleanup();
  });

  test("applyConfig fully overwrites — a field removed from the reload does not linger", () => {
    writeConfig({
      mcpGameUrl: "https://game.example.com/mcp",
      agents: [{ name: "alpha" }],
      fleetName: "first-fleet",
    });
    setConfigForTesting(loadConfig(tmpDir));
    const held = getConfig();
    expect(held.fleetName).toBe("first-fleet");

    // Reload without fleetName — the held object's field must clear, not persist.
    writeConfig({
      mcpGameUrl: "https://game.example.com/mcp",
      agents: [{ name: "alpha" }],
    });
    applyConfig(loadConfig(tmpDir));
    expect(held.fleetName).toBeUndefined();

    cleanup();
  });
});
