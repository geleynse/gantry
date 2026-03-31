#!/usr/bin/env bun
/**
 * gantry-setup.ts — Cross-platform first-run setup for Gantry.
 *
 * Creates the data/ directory structure and generates a default gantry.json
 * with placeholder values. Safe to run multiple times (idempotent).
 *
 * Usage:
 *   bun gantry/server/scripts/gantry-setup.ts [install-dir]
 */

import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const installDir = resolve(process.argv[2] || process.cwd());
const configFile = join(installDir, "gantry.json");
const dataDir = join(installDir, "data");
const logsDir = join(installDir, "logs");

// ── Helpers ──────────────────────────────────────────────────────────────────

const BLUE = "\x1b[34m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

function info(msg: string) {
  console.log(`${BLUE}[gantry-setup]${RESET} ${msg}`);
}
function ok(msg: string) {
  console.log(`${GREEN}[gantry-setup]${RESET} ${msg}`);
}
function warn(msg: string) {
  console.log(`${YELLOW}[gantry-setup]${RESET} ${msg}`);
}

// ── Directories ──────────────────────────────────────────────────────────────

info(`Creating data directories in: ${installDir}`);

mkdirSync(join(dataDir, "pids"), { recursive: true });
mkdirSync(logsDir, { recursive: true });
ok(`Created: ${dataDir}/pids`);
ok(`Created: ${logsDir}`);

// ── Default config ───────────────────────────────────────────────────────────

const defaultConfig = {
  mcpGameUrl: "wss://game.spacemolt.com/mcp",
  agents: [
    {
      name: "my-agent",
      model: "claude-haiku-4-5",
      mcpVersion: "v2",
      mcpPreset: "standard",
    },
  ],
};

if (existsSync(configFile)) {
  warn(`Config already exists, skipping: ${configFile}`);
} else {
  info(`Writing default config: ${configFile}`);
  writeFileSync(configFile, JSON.stringify(defaultConfig, null, 2) + "\n");
  ok(`Written: ${configFile}`);
}

// ── Instructions ─────────────────────────────────────────────────────────────

console.log(`
─────────────────────────────────────────────────────────
  Gantry setup complete!
─────────────────────────────────────────────────────────

Next steps:

  1. Edit ${configFile}
     - Add your agent name(s)
     - Add auth if needed: { "adapter": "token", "config": { "token": "secret" } }

  2. Start the server:
       cd gantry/server
       FLEET_DIR=${installDir} bun run dev

  3. Open the dashboard at http://localhost:3100

  4. Connect Claude Code:
       Add to your .mcp.json:
       {
         "mcpServers": {
           "spacemolt": {
             "type": "http",
             "url": "http://localhost:3100/mcp/v2"
           }
         }
       }
`);
