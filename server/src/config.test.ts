import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveConfigPath } from "./config.js";

/** Create a temp fleet dir and return its path */
function makeTempFleetDir(): string {
  return mkdtempSync(join(tmpdir(), "gantry-test-"));
}

/** Write a config file into a fleet dir */
function writeConfig(fleetDir: string, filename: string, config: unknown): void {
  writeFileSync(join(fleetDir, filename), JSON.stringify(config), "utf-8");
}

const MINIMAL_VALID_CONFIG = {
  mcpGameUrl: "https://game.example.com/mcp",
  agents: [
    { name: "test-agent", backend: "claude", model: "haiku" },
  ],
};

describe("resolveConfigPath", () => {
  test("finds gantry.json when present", () => {
    const fleetDir = makeTempFleetDir();
    writeConfig(fleetDir, "gantry.json", MINIMAL_VALID_CONFIG);
    const path = resolveConfigPath(fleetDir);
    expect(path).toEndWith("gantry.json");
  });

  test("finds fleet-config.json as fallback", () => {
    const fleetDir = makeTempFleetDir();
    writeConfig(fleetDir, "fleet-config.json", MINIMAL_VALID_CONFIG);
    const path = resolveConfigPath(fleetDir);
    expect(path).toEndWith("fleet-config.json");
  });

  test("prefers gantry.json over fleet-config.json", () => {
    const fleetDir = makeTempFleetDir();
    writeConfig(fleetDir, "gantry.json", MINIMAL_VALID_CONFIG);
    writeConfig(fleetDir, "fleet-config.json", MINIMAL_VALID_CONFIG);
    const path = resolveConfigPath(fleetDir);
    expect(path).toEndWith("gantry.json");
  });

  test("throws with helpful message when no config found", () => {
    const fleetDir = makeTempFleetDir();
    expect(() => resolveConfigPath(fleetDir)).toThrow("[config] No config file found");
    expect(() => resolveConfigPath(fleetDir)).toThrow("gantry.json");
    expect(() => resolveConfigPath(fleetDir)).toThrow("fleet-config.json");
  });
});

describe("loadConfig", () => {
  test("loads a valid config from gantry.json", () => {
    const fleetDir = makeTempFleetDir();
    writeConfig(fleetDir, "gantry.json", MINIMAL_VALID_CONFIG);
    const config = loadConfig(fleetDir);
    expect(config.agents).toHaveLength(1);
    expect(config.agents[0].name).toBe("test-agent");
  });

  test("loads a valid config from fleet-config.json", () => {
    const fleetDir = makeTempFleetDir();
    writeConfig(fleetDir, "fleet-config.json", MINIMAL_VALID_CONFIG);
    const config = loadConfig(fleetDir);
    expect(config.agents[0].name).toBe("test-agent");
  });

  test("derives API URL and MCP URL from mcpGameUrl", () => {
    const fleetDir = makeTempFleetDir();
    writeConfig(fleetDir, "gantry.json", MINIMAL_VALID_CONFIG);
    const config = loadConfig(fleetDir);
    expect(config.gameUrl).toBe("https://game.example.com/mcp");
    expect(config.gameApiUrl).toBe("https://game.example.com/api/v1");
    expect(config.gameMcpUrl).toBe("https://game.example.com/mcp");
  });

  test("uses default turnSleepMs and staggerDelay when not specified", () => {
    const fleetDir = makeTempFleetDir();
    writeConfig(fleetDir, "gantry.json", MINIMAL_VALID_CONFIG);
    const config = loadConfig(fleetDir);
    expect(config.turnSleepMs).toBe(90);
    expect(config.staggerDelay).toBe(20);
  });

  test("uses provided turnSleepMs and staggerDelay", () => {
    const fleetDir = makeTempFleetDir();
    writeConfig(fleetDir, "gantry.json", {
      ...MINIMAL_VALID_CONFIG,
      turnSleepMs: 60,
      staggerDelay: 10,
    });
    const config = loadConfig(fleetDir);
    expect(config.turnSleepMs).toBe(60);
    expect(config.staggerDelay).toBe(10);
  });

  test("backward compat: accepts deprecated turnInterval and maps to turnSleepMs", () => {
    const fleetDir = makeTempFleetDir();
    writeConfig(fleetDir, "gantry.json", {
      ...MINIMAL_VALID_CONFIG,
      turnInterval: 60,
      staggerDelay: 10,
    });
    const config = loadConfig(fleetDir);
    expect(config.turnSleepMs).toBe(60);
    expect(config.staggerDelay).toBe(10);
  });

  test("loads agentDeniedTools", () => {
    const fleetDir = makeTempFleetDir();
    writeConfig(fleetDir, "gantry.json", {
      ...MINIMAL_VALID_CONFIG,
      agentDeniedTools: {
        "test-agent": { batch_mine: "only scouts" },
      },
    });
    const config = loadConfig(fleetDir);
    expect(config.agentDeniedTools["test-agent"]).toBeDefined();
    expect(config.agentDeniedTools["test-agent"]["batch_mine"]).toBe("only scouts");
  });

  test("loads callLimits", () => {
    const fleetDir = makeTempFleetDir();
    writeConfig(fleetDir, "gantry.json", {
      ...MINIMAL_VALID_CONFIG,
      callLimits: { get_location: 3, scan: 5 },
    });
    const config = loadConfig(fleetDir);
    expect(config.callLimits["get_location"]).toBe(3);
    expect(config.callLimits["scan"]).toBe(5);
  });

  test("loads mcpVersion and mcpPreset for agents", () => {
    const fleetDir = makeTempFleetDir();
    writeConfig(fleetDir, "gantry.json", {
      ...MINIMAL_VALID_CONFIG,
      agents: [{ name: "v2-agent", backend: "claude", mcpVersion: "v2", mcpPreset: "full" }],
    });
    const config = loadConfig(fleetDir);
    expect(config.agents[0].mcpVersion).toBe("v2");
    expect(config.agents[0].mcpPreset).toBe("full");
  });

  test("defaults mcpPreset to standard when mcpVersion is v2", () => {
    const fleetDir = makeTempFleetDir();
    writeConfig(fleetDir, "gantry.json", {
      ...MINIMAL_VALID_CONFIG,
      agents: [{ name: "v2-agent", backend: "claude", mcpVersion: "v2" }],
    });
    const config = loadConfig(fleetDir);
    expect(config.agents[0].mcpPreset).toBe("standard");
  });

  test("loads toolResultFormat for agents", () => {
    const fleetDir = makeTempFleetDir();
    writeConfig(fleetDir, "gantry.json", {
      ...MINIMAL_VALID_CONFIG,
      agents: [{ name: "yaml-agent", backend: "claude", toolResultFormat: "yaml" }],
    });
    const config = loadConfig(fleetDir);
    expect(config.agents[0].toolResultFormat).toBe("yaml");
  });

  test("throws when no config file found", () => {
    const fleetDir = makeTempFleetDir();
    expect(() => loadConfig(fleetDir)).toThrow("[config] No config file found");
  });

  test("throws when mcpGameUrl is missing (Zod validation)", () => {
    const fleetDir = makeTempFleetDir();
    writeConfig(fleetDir, "gantry.json", {
      agents: [{ name: "test-agent" }],
      // mcpGameUrl missing
    });
    expect(() => loadConfig(fleetDir)).toThrow("[config] Invalid config");
  });

  test("throws when agents array is empty (Zod validation)", () => {
    const fleetDir = makeTempFleetDir();
    writeConfig(fleetDir, "gantry.json", {
      mcpGameUrl: "https://game.example.com/mcp",
      agents: [],
    });
    expect(() => loadConfig(fleetDir)).toThrow("[config] Invalid config");
  });

  test("throws when agent has no name (Zod validation)", () => {
    const fleetDir = makeTempFleetDir();
    writeConfig(fleetDir, "gantry.json", {
      mcpGameUrl: "https://game.example.com/mcp",
      agents: [{ model: "haiku" }], // name missing
    });
    expect(() => loadConfig(fleetDir)).toThrow("[config] Invalid config");
  });

  test("throws when agent name is empty string (Zod validation)", () => {
    const fleetDir = makeTempFleetDir();
    writeConfig(fleetDir, "gantry.json", {
      mcpGameUrl: "https://game.example.com/mcp",
      agents: [{ name: "" }],
    });
    expect(() => loadConfig(fleetDir)).toThrow("[config] Invalid config");
  });

  test("reads SOCKS port from .conf file", () => {
    const fleetDir = makeTempFleetDir();
    const proxyDir = join(fleetDir, "proxy");
    mkdirSync(proxyDir);
    writeFileSync(
      join(proxyDir, "proxy-micro.conf"),
      "strict_chain\nproxy_dns\n[ProxyList]\nsocks5 127.0.0.1 1082\n",
      "utf-8"
    );
    writeConfig(fleetDir, "gantry.json", {
      mcpGameUrl: "https://game.example.com/mcp",
      agents: [{ name: "proxy-agent", backend: "claude", proxy: "micro" }],
    });
    const config = loadConfig(fleetDir);
    expect(config.agents[0].socksPort).toBe(1082);
    expect(config.agents[0].proxy).toBe("micro");
  });

  test("agents without proxy have no socksPort", () => {
    const fleetDir = makeTempFleetDir();
    writeConfig(fleetDir, "gantry.json", MINIMAL_VALID_CONFIG);
    const config = loadConfig(fleetDir);
    expect(config.agents[0].socksPort).toBeUndefined();
  });

  test("throws with helpful message on JSON parse error", () => {
    const fleetDir = makeTempFleetDir();
    writeFileSync(join(fleetDir, "gantry.json"), "not valid json", "utf-8");
    expect(() => loadConfig(fleetDir)).toThrow();
  });

  test("multiple agents all loaded", () => {
    const fleetDir = makeTempFleetDir();
    writeConfig(fleetDir, "gantry.json", {
      mcpGameUrl: "https://game.example.com/mcp",
      agents: [
        { name: "alpha", backend: "claude" },
        { name: "beta", backend: "codex" },
        { name: "gamma" },
      ],
    });
    const config = loadConfig(fleetDir);
    expect(config.agents).toHaveLength(3);
    expect(config.agents.map((a) => a.name)).toEqual(["alpha", "beta", "gamma"]);
  });

  test("loads gemini backend for agents", () => {
    const fleetDir = makeTempFleetDir();
    writeConfig(fleetDir, "gantry.json", {
      mcpGameUrl: "https://game.example.com/mcp",
      agents: [{ name: "gemini-agent", backend: "gemini", model: "flash" }],
    });
    const config = loadConfig(fleetDir);
    expect(config.agents[0].backend).toBe("gemini");
    expect(config.agents[0].model).toBe("flash");
  });
});
