import { describe, test, expect, beforeEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { FleetConfigSchema, AgentConfigSchema } from "./schemas.js";
import { loadConfig } from "./fleet.js";
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
});
