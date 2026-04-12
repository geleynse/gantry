/**
 * Fleet configuration: file resolution, loading, parsing, hot-reload, caching, agent helpers.
 */
import { readFileSync, watchFile, existsSync } from "node:fs";
import { atomicWriteFileSync } from "../lib/atomic-write.js";
import { join } from "node:path";
import { createLogger } from "../lib/logger.js";
import { FLEET_DIR, GANTRY_ENV } from "./env.js";
import { FleetConfigSchema } from "./schemas.js";
import { DEFAULT_TURN_INTERVAL, DEFAULT_STAGGER_DELAY } from "./constants.js";
import type { AgentConfig, AuthConfig, MockModeConfig, AccountPoolConfig, CoordinatorConfig, OverseerConfig, OutboundConfig, GantryConfig } from "./types.js";

const log = createLogger("config");

/**
 * Resolve which config file to use, in priority order:
 * 1. $FLEET_DIR/gantry.$GANTRY_ENV.json  (if GANTRY_ENV is set)
 * 2. $FLEET_DIR/gantry.json
 * 3. $FLEET_DIR/fleet-config.json         (backward compat)
 *
 * Returns the resolved path, or throws if none found.
 */
export function resolveConfigPath(fleetDir: string): string {
  const candidates: string[] = [];

  if (GANTRY_ENV) {
    candidates.push(join(fleetDir, `gantry.${GANTRY_ENV}.json`));
  }
  candidates.push(join(fleetDir, "gantry.json"));
  candidates.push(join(fleetDir, "fleet-config.json"));

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const tried = candidates.map((c) => `  - ${c}`).join("\n");
  throw new Error(
    `[config] No config file found in ${fleetDir}.\n` +
    `Tried:\n${tried}\n` +
    `Create a gantry.json (or fleet-config.json) with your agent definitions.`
  );
}

/**
 * Parse a proxychains4 .conf file to extract the SOCKS5 port.
 * Expected format: "socks5 127.0.0.1 <port>"
 */
function parseSocksPort(confPath: string): number | undefined {
  try {
    const content = readFileSync(confPath, "utf-8");
    const match = content.match(/socks5\s+[\d.]+\s+(\d+)/);
    return match ? parseInt(match[1], 10) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Load and parse the fleet config from the given fleet directory.
 * Looks for gantry.$GANTRY_ENV.json, then gantry.json, then fleet-config.json.
 * Returns GantryConfig with all proxy, web, and agent settings.
 */
export function loadConfig(fleetDir: string = FLEET_DIR): GantryConfig {
  const configPath = resolveConfigPath(fleetDir);
  const raw = readFileSync(configPath, "utf-8");
  const rawParsed: unknown = JSON.parse(raw);

  const parsed = FleetConfigSchema.safeParse(rawParsed);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`[config] Invalid config at ${configPath}:\n${issues}`);
  }

  const fleetConfig = parsed.data;

  const agents: AgentConfig[] = fleetConfig.agents.map((a) => {
    // socksPort is computed at load time (not in JSON), so derive it then spread
    let socksPort: number | undefined;
    if (a.proxy) {
      const confPath = join(fleetDir, "proxy", `proxy-${a.proxy}.conf`);
      socksPort = parseSocksPort(confPath);
    }

    // mcpPreset defaults to "standard" when mcpVersion is v2 and preset is unset
    const mcpPreset =
      a.mcpVersion === "v2" ? ((a.mcpPreset ?? "standard") as AgentConfig["mcpPreset"]) : a.mcpPreset;

    return { ...a, socksPort, mcpPreset };
  });

  const gameUrl = fleetConfig.mcpGameUrl;
  const gameApiUrl = gameUrl.replace(/\/mcp$/, "/api/v1");
  const gameMcpUrl = gameUrl; // mcpGameUrl IS the MCP URL

  const agentDeniedTools = fleetConfig.agentDeniedTools ?? {};
  const callLimits = fleetConfig.callLimits ?? {};
  // Accept both turnSleepMs (new) and turnInterval (deprecated) — turnSleepMs wins if both present.
  if (fleetConfig.turnInterval !== undefined && fleetConfig.turnSleepMs === undefined) {
    log.warn("Config field 'turnInterval' is deprecated. Rename to 'turnSleepMs' in your fleet config.");
  }
  const turnSleepMs = fleetConfig.turnSleepMs ?? fleetConfig.turnInterval ?? DEFAULT_TURN_INTERVAL;
  const staggerDelay = fleetConfig.staggerDelay ?? DEFAULT_STAGGER_DELAY;
  const auth = fleetConfig.auth as AuthConfig | undefined;
  const fleetName = fleetConfig.fleetName;
  const maxIterationsPerSession = fleetConfig.maxIterationsPerSession ?? 200;
  const maxTurnDurationMs = fleetConfig.maxTurnDurationMs ?? 10 * 60 * 1000; // 10 minutes
  const idleTimeoutMs = fleetConfig.idleTimeoutMs ?? 2 * 60 * 1000; // 2 minutes
  const shutdownWarningMs = fleetConfig.shutdownWarningMs; // default applied in injection (1100000ms)

  // Normalize mockMode: boolean shorthand → MockModeConfig object
  let mockMode: MockModeConfig | undefined;
  if (fleetConfig.mockMode !== undefined) {
    if (typeof fleetConfig.mockMode === "boolean") {
      mockMode = { enabled: fleetConfig.mockMode };
    } else {
      mockMode = fleetConfig.mockMode as MockModeConfig;
    }
  }

  // Resolve accountPool path (relative paths resolved against fleetDir)
  let accountPool: AccountPoolConfig | undefined;
  if (fleetConfig.accountPool) {
    const poolPath = fleetConfig.accountPool.startsWith("/")
      ? fleetConfig.accountPool
      : join(fleetDir, fleetConfig.accountPool);
    if (!existsSync(poolPath)) {
      throw new Error(
        `[config] accountPool file not found: ${poolPath}\n` +
        `Set "accountPool" to a valid path or remove it from the config.`
      );
    }
    accountPool = { poolFile: poolPath };
  }

  // Coordinator config — Zod `.default()` on CoordinatorConfigSchema already applies
  // field-level defaults after parsing, so no `??` fallbacks needed here.
  const coordinator: CoordinatorConfig | undefined = fleetConfig.coordinator
    ? fleetConfig.coordinator as CoordinatorConfig
    : undefined;

  // Overseer config — same pattern as coordinator, Zod defaults applied during parse.
  const overseer: OverseerConfig | undefined = fleetConfig.overseer
    ? fleetConfig.overseer as OverseerConfig
    : undefined;

  const outbound: OutboundConfig | undefined = fleetConfig.outbound
    ? fleetConfig.outbound as OutboundConfig
    : undefined;

  return {
    agents,
    gameUrl,
    gameApiUrl,
    gameMcpUrl,
    agentDeniedTools,
    callLimits,
    turnSleepMs,
    staggerDelay,
    auth,
    fleetName,
    mockMode,
    accountPool,
    credentialsPath: fleetConfig.credentialsPath as string | undefined,
    maxIterationsPerSession,
    maxTurnDurationMs,
    idleTimeoutMs,
    shutdownWarningMs,
    coordinator,
    overseer,
    outbound,
    mcpPresets: fleetConfig.mcpPresets,
    forumUrl: fleetConfig.forumUrl,
    validateCredentialsOnStartup: fleetConfig.validateCredentialsOnStartup as boolean | undefined,
  };
}

// Cached config state
let cachedConfig: GantryConfig | null = null;
let initError: Error | null = null;
let isInitialized = false;

// Export cached agent list and names (updated by watcher)
export let AGENTS: AgentConfig[] = [];
export let AGENT_NAMES: Set<string> = new Set();
/** @deprecated Use TURN_SLEEP_MS instead. Kept for backward compat. */
export let TURN_INTERVAL: number = DEFAULT_TURN_INTERVAL;
export let TURN_SLEEP_MS: number = DEFAULT_TURN_INTERVAL;

/**
 * Update derived state variables when config is reloaded.
 */
function updateDerivedState(): void {
  if (!cachedConfig) return;
  AGENTS = cachedConfig.agents;
  AGENT_NAMES = new Set(AGENTS.map((a) => a.name));
  TURN_SLEEP_MS = cachedConfig.turnSleepMs;
  TURN_INTERVAL = cachedConfig.turnSleepMs; // deprecated alias
}

/**
 * Initialize config (called at module load).
 * Sets up the initial config and starts watching for changes.
 * On failure, records the error — getConfig() will throw it.
 * In tests, this may fail silently; tests should call setConfigForTesting().
 */
function initConfig(): void {
  if (isInitialized) return;
  isInitialized = true;

  let configPath: string;
  try {
    configPath = resolveConfigPath(FLEET_DIR);
  } catch (err) {
    // During tests, FLEET_DIR might be /dev/null or invalid
    // Don't set initError yet; tests can call setConfigForTesting()
    // Only throw if getConfig() is actually called
    return;
  }

  try {
    cachedConfig = loadConfig(FLEET_DIR);
  } catch (err) {
    // During tests, loading might fail; again, allow setConfigForTesting()
    return;
  }

  // Watch whichever config file was actually found
  watchFile(configPath, { interval: 5000 }, () => {
    try {
      cachedConfig = loadConfig(FLEET_DIR);
      updateDerivedState();
      log.info(`Reloaded config (${AGENTS.length} agents)`);
    } catch (err) {
      log.error(`Failed to reload config: ${err}`);
    }
  });
}

/**
 * Get the currently loaded config.
 * Throws if config failed to initialize or has not been loaded yet.
 */
export function getConfig(): GantryConfig {
  if (initError) {
    throw initError;
  }
  if (!cachedConfig) {
    throw new Error(
      "[config] Config not initialized. Call initConfig() or access AGENTS first."
    );
  }
  return cachedConfig;
}

/**
 * Find an agent by name in the loaded config.
 */
export function getAgent(name: string): AgentConfig | undefined {
  return AGENTS.find((a) => a.name === name);
}

/**
 * Check if an agent name is valid (exists in the loaded config).
 */
export function validateAgentName(name: string): boolean {
  return AGENT_NAMES.has(name);
}

/**
 * Get all agent names from the loaded config.
 */
export function getAgentNames(): string[] {
  return Array.from(AGENT_NAMES);
}

/**
 * Get a human-readable label for an agent (from web code).
 */
export function getAgentLabel(agent: AgentConfig): string {
  if (agent.backend === "claude" && agent.model) {
    return `claude/${agent.model}`;
  }
  return agent.backend || "unknown";
}

/**
 * For testing: Set the config directly without loading from filesystem.
 * This bypasses initConfig() and sets up AGENTS and AGENT_NAMES for routes.
 */
export function setConfigForTesting(config: GantryConfig): void {
  cachedConfig = config;
  updateDerivedState();
}

/**
 * Get the list of allowed v2 tool names for a given roleType.
 *
 * Uses the mcpPresets map from fleet-config.json to look up the role's allowed tools.
 * Falls back to the "standard" preset if the roleType has no specific preset.
 * Returns null if no mcpPresets are defined (no filtering — all tools allowed).
 *
 * The returned list contains top-level v2 tool group names (e.g. "spacemolt",
 * "spacemolt_market"), not individual action names. login/logout are always included.
 *
 * Used by mcp-factory.ts to create role-specific MCP server instances (#214).
 */
export function getToolsForRolePreset(
  mcpPresets: Record<string, string[]> | undefined,
  roleType: string | undefined,
): string[] | null {
  if (!mcpPresets) return null;

  // Try roleType first, then "standard" fallback
  const key = (roleType && roleType in mcpPresets) ? roleType : "standard";
  const preset = mcpPresets[key];
  if (!preset) return null;

  // Always include login/logout (proxy-intercepted auth tools)
  const tools = new Set(preset);
  tools.add("login");
  tools.add("logout");
  return Array.from(tools);
}

/**
 * Save the provided raw configuration back to the active config file.
 */
export function saveConfig(rawConfig: any): void {
  const configPath = resolveConfigPath(FLEET_DIR);
  atomicWriteFileSync(configPath, JSON.stringify(rawConfig, null, 2));
}

// Initialize on module load
initConfig();
updateDerivedState();
