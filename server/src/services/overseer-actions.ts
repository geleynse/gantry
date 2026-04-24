import { createLogger } from "../lib/logger.js";
import type { OverseerAction, ActionResult } from "../shared/types/overseer.js";

const log = createLogger("overseer-actions");
const LIFECYCLE_COOLDOWN_MS = 5 * 60 * 1000;

export interface ActionExecutorDeps {
  agentManager: {
    startAgent: (name: string) => Promise<{ ok: boolean; message: string }>;
    stopAgent: (name: string, reason?: string) => Promise<{ ok: boolean; message: string }>;
  };
  commsDb: {
    createOrder: (opts: { message: string; target_agent: string; priority?: string }) => number;
  };
  /**
   * Authoritative check for whether an agent's Claude Code process is alive.
   * Backed by process-manager.hasSession (in-memory ChildProcess map + PID file).
   * Optional for backward compat — if omitted, redundancy pre-checks are skipped.
   */
  isAgentRunning?: (name: string) => Promise<boolean>;
}

export function createActionExecutor(deps: ActionExecutorDeps) {
  const lifecycleTimestamps = new Map<string, number>();

  async function executeOne(action: OverseerAction): Promise<ActionResult> {
    const { type, params } = action;
    const agent = params.agent as string;

    try {
      switch (type) {
        case "issue_order": {
          const message = params.message as string;
          const priority = (params.priority as string) || "normal";
          deps.commsDb.createOrder({ message, target_agent: agent, priority });
          return { action, success: true, message: `Order sent to ${agent}` };
        }
        case "trigger_routine": {
          const routine = params.routine as string;
          const routineParams = params.params ? JSON.stringify(params.params) : "{}";
          const message = `[OPERATOR] Execute routine: ${routine}\nParams: ${routineParams}`;
          deps.commsDb.createOrder({ message, target_agent: agent, priority: "urgent" });
          return { action, success: true, message: `Routine ${routine} triggered for ${agent}` };
        }
        case "start_agent":
        case "stop_agent": {
          // Authoritative liveness check — the overseer's fleet snapshot derives
          // isOnline from statusCache (game tool activity age), which reads stale
          // after even a few minutes of idleness. The real source of truth is
          // process-manager.hasSession. If the overseer asks to start an agent
          // whose Claude Code process is already alive, short-circuit with a log
          // line instead of returning "already running" as a failure.
          if (deps.isAgentRunning) {
            try {
              const running = await deps.isAgentRunning(agent);
              if (type === "start_agent" && running) {
                log.info("overseer: skipping start — already running", { agent });
                return { action, success: true, message: `${agent} already running (skipped redundant start)` };
              }
              if (type === "stop_agent" && !running) {
                log.info("overseer: skipping stop — already stopped", { agent });
                return { action, success: true, message: `${agent} already stopped (skipped redundant stop)` };
              }
            } catch (err) {
              log.warn("overseer: isAgentRunning check failed, proceeding with action", { agent, error: err instanceof Error ? err.message : String(err) });
            }
          }
          const lastAction = lifecycleTimestamps.get(agent) ?? 0;
          if (Date.now() - lastAction < LIFECYCLE_COOLDOWN_MS) {
            return { action, success: false, message: `Lifecycle rate limit: ${agent} had action <5 min ago` };
          }
          lifecycleTimestamps.set(agent, Date.now());
          const overseerReason = (params.reason as string | undefined) ?? "no reason given";
          const result =
            type === "start_agent"
              ? await deps.agentManager.startAgent(agent)
              : await deps.agentManager.stopAgent(agent, `overseer: ${overseerReason}`);
          return { action, success: result.ok, message: result.message };
        }
        case "reassign_role": {
          const role = params.role as string;
          const zone = params.zone as string | undefined;
          const message = `[OVERSEER] Role reassignment: shift to ${role}${zone ? ` in zone ${zone}` : ""}. Adjust your priorities accordingly.`;
          deps.commsDb.createOrder({ message, target_agent: agent, priority: "urgent" });
          return { action, success: true, message: `Reassigned ${agent} to ${role}` };
        }
        case "no_action":
          return { action, success: true, message: (params.reason as string) || "No action needed" };
        default:
          return { action, success: false, message: `Unknown action type: ${type}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Action ${type} failed for ${agent}`, { error: msg });
      return { action, success: false, message: msg };
    }
  }

  return {
    async execute(actions: OverseerAction[]): Promise<ActionResult[]> {
      const results: ActionResult[] = [];
      for (const action of actions) {
        results.push(await executeOne(action));
      }
      return results;
    },
    getToolSchemas() {
      return OVERSEER_TOOLS;
    },
  };
}

const OVERSEER_TOOLS = [
  {
    name: "issue_order",
    description:
      "Send a fleet order to an agent. Orders are injected into the agent's next tool response.",
    input_schema: {
      type: "object" as const,
      properties: {
        agent: { type: "string" as const, description: "Agent name" },
        message: { type: "string" as const, description: "Order text" },
        priority: { type: "string" as const, enum: ["normal", "urgent"], default: "normal" },
      },
      required: ["agent", "message"],
    },
  },
  {
    name: "trigger_routine",
    description:
      "Start a named routine for an agent. Available: sell_cycle, mining_loop, refuel_repair, full_trade_run, navigate_home, explore_system, explore_and_mine, navigate_and_mine, supply_run, craft_and_sell, salvage_loop, patrol_and_attack, mission_run, mission_check, manage_storage, upgrade_ship, fleet_refuel, fleet_jump.",
    input_schema: {
      type: "object" as const,
      properties: {
        agent: { type: "string" as const },
        routine: { type: "string" as const },
        params: { type: "object" as const, description: "Optional routine params" },
      },
      required: ["agent", "routine"],
    },
  },
  {
    name: "start_agent",
    description: "Start a stopped agent.",
    input_schema: {
      type: "object" as const,
      properties: { agent: { type: "string" as const } },
      required: ["agent"],
    },
  },
  {
    name: "stop_agent",
    description: "Stop a running agent gracefully.",
    input_schema: {
      type: "object" as const,
      properties: {
        agent: { type: "string" as const },
        reason: { type: "string" as const },
      },
      required: ["agent", "reason"],
    },
  },
  {
    name: "reassign_role",
    description: "Change an agent's operating focus by sending an urgent fleet order.",
    input_schema: {
      type: "object" as const,
      properties: {
        agent: { type: "string" as const },
        role: {
          type: "string" as const,
          description: "New role: miner, trader, explorer, combat",
        },
        zone: { type: "string" as const, description: "Optional operating zone" },
      },
      required: ["agent", "role"],
    },
  },
  {
    name: "no_action",
    description: "Fleet is operating well. No changes needed.",
    input_schema: {
      type: "object" as const,
      properties: { reason: { type: "string" as const } },
      required: ["reason"],
    },
  },
];
