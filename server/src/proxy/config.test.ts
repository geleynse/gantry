import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "bun:test";
import { loadConfig } from "../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Point to the repo root's fleet-agents (not gantry/fleet-agents which has a minimal gantry.json)
const FLEET_DIR = resolve(__dirname, "../../../../fleet-agents");

describe("loadConfig", () => {
  it("loads agent list from fleet-config.json", () => {
    const config = loadConfig(FLEET_DIR);
    expect(config.agents.length).toBeGreaterThan(0);
    expect(config.agents[0]).toHaveProperty("name");
  });

  it("agents with proxy config have a proxy field", () => {
    const config = loadConfig(FLEET_DIR);
    const sable = config.agents.find((a) => a.name === "sable-thorn");
    expect(sable?.proxy).toBe("micro");
  });

  it("agents without proxy have no proxy field", () => {
    const config = loadConfig(FLEET_DIR);
    const drifter = config.agents.find((a) => a.name === "drifter-gale");
    expect(drifter?.proxy).toBeUndefined();
  });

  it("loads game URL from config", () => {
    const config = loadConfig(FLEET_DIR);
    expect(config.gameUrl).toBe("https://game.spacemolt.com/mcp");
  });

  it("derives MCP URL from game URL", () => {
    const config = loadConfig(FLEET_DIR);
    expect(config.gameMcpUrl).toBe("https://game.spacemolt.com/mcp");
  });

  it("loads agentDeniedTools from config", () => {
    const config = loadConfig(FLEET_DIR);
    expect(config.agentDeniedTools["drifter-gale"]).toBeDefined();
    expect(config.agentDeniedTools["drifter-gale"]["batch_mine"]).toContain("scout");
  });

  it("loads callLimits from config", () => {
    const config = loadConfig(FLEET_DIR);
    expect(config.callLimits["get_location"]).toBe(40);
    expect(config.callLimits["scan"]).toBe(8);
  });

  it("loads roleType for agents that specify it", () => {
    const config = loadConfig(FLEET_DIR);
    const drifter = config.agents.find((a) => a.name === "drifter-gale");
    expect(drifter?.roleType).toBe("explorer");
  });

  it("loads operatingZone for agents", () => {
    const config = loadConfig(FLEET_DIR);
    const sable = config.agents.find((a) => a.name === "sable-thorn");
    expect(sable?.operatingZone).toBe("crimson-zones");
  });
});
