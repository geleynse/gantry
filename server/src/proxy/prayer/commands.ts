import { cargoItemsForTool, homeDestination } from "./state.js";
import { PrayerRuntimeError, type CommandSpec, type ResolvedArg } from "./types.js";

function stringArg(args: ResolvedArg[], index: number): string {
  return String(args[index] ?? "");
}

function intArg(args: ResolvedArg[], index: number, fallback: number): number {
  const value = Number(args[index] ?? fallback);
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function currentData(ctx: { agentName: string; statusCache: Map<string, { data: Record<string, unknown>; fetchedAt: number }> }): Record<string, unknown> {
  return ctx.statusCache.get(ctx.agentName)?.data ?? {};
}

export const COMMANDS: Record<string, CommandSpec> = {
  halt: {
    name: "halt",
    backingTool: null,
    arity: [0, 0],
    argTypes: [],
    dispatcher: {
      kind: "native",
      handler: async (_args, state) => {
        state.haltRequested = true;
      },
    },
  },
  wait: {
    name: "wait",
    backingTool: null,
    arity: [0, 1],
    argTypes: ["integer"],
    dispatcher: {
      kind: "native",
      handler: async (args, state, deps) => {
        const ticks = Math.max(1, intArg(args, 0, 1));
        for (let i = 0; i < ticks; i++) {
          await deps.client.waitForTick();
        }
      },
    },
  },
  mine: {
    name: "mine",
    backingTool: "batch_mine",
    arity: [0, 1],
    argTypes: ["item"],
    dispatcher: {
      kind: "compound",
      tool: "batch_mine",
      argMapper: () => ({ maxAttempts: 1 }),
    },
  },
  go: {
    name: "go",
    backingTool: "travel_to",
    arity: [1, 1],
    argTypes: ["destination"],
    dispatcher: {
      kind: "compound",
      tool: "travel_to",
      argMapper: (args) => ({ destination: stringArg(args, 0) }),
    },
  },
  dock: {
    name: "dock",
    backingTool: "dock",
    arity: [0, 0],
    argTypes: [],
    dispatcher: { kind: "passthrough", tool: "dock", argMapper: () => undefined },
  },
  undock: {
    name: "undock",
    backingTool: "undock",
    arity: [0, 0],
    argTypes: [],
    dispatcher: { kind: "passthrough", tool: "undock", argMapper: () => undefined },
  },
  refuel: {
    name: "refuel",
    backingTool: "refuel",
    arity: [0, 0],
    argTypes: [],
    dispatcher: { kind: "passthrough", tool: "refuel", argMapper: () => undefined },
  },
  repair: {
    name: "repair",
    backingTool: "repair",
    arity: [0, 0],
    argTypes: [],
    dispatcher: { kind: "passthrough", tool: "repair", argMapper: () => undefined },
  },
  sell: {
    name: "sell",
    backingTool: "multi_sell",
    arity: [0, 1],
    argTypes: ["item"],
    dispatcher: {
      kind: "compound",
      tool: "multi_sell",
      argMapper: (args, ctx) => {
        const data = currentData(ctx);
        const items = args.length === 0
          ? cargoItemsForTool(data)
          : cargoItemsForTool(data).filter((item) => item.item_id === stringArg(args, 0));
        if (items.length === 0) throw new PrayerRuntimeError("skip_no_items", "No cargo to sell");
        return { items };
      },
    },
  },
  stash: {
    name: "stash",
    backingTool: "deposit_items",
    arity: [0, 2],
    argTypes: ["item", "integer"],
    dispatcher: {
      kind: "native",
      handler: async (args, state, deps) => {
        const data = deps.statusCache.get(deps.agentName)?.data ?? {};
        const cargo = cargoItemsForTool(data);
        const items = args.length === 0
          ? cargo
          : (() => {
              const itemId = stringArg(args, 0);
              const existing = cargo.find((item) => item.item_id === itemId);
              const quantity = args.length >= 2 ? intArg(args, 1, 0) : existing?.quantity ?? 0;
              return quantity > 0 ? [{ item_id: itemId, quantity }] : [];
            })();
        if (items.length === 0) {
          throw new PrayerRuntimeError("skip_no_items", "No cargo to stash");
        }

        for (const item of items) {
          const started = Date.now();
          const result = await deps.handlePassthrough("deposit_items", item);
          const durationMs = Date.now() - started;
          state.log.push({ tool: "deposit_items", args: item, result, durationMs, ok: true });
          deps.logSubTool?.("pray:deposit_items", item, result, durationMs);
        }
      },
    },
  },
};

export const UNSUPPORTED_COMMANDS = new Set([
  "self_destruct",
  "jettison",
  "sell_ship",
  "list_ship_for_sale",
  "buy_ship",
  "buy_listed_ship",
  "commission_ship",
  "switch_ship",
  "distress_signal",
  "tow_wreck",
  "scrap_wreck",
  "sell_wreck",
  "decline_mission",
  "use_item",
  "set_home",
]);

export function resolveSpecialDestination(value: string, data: Record<string, unknown>): string {
  if (value !== "home") return value;
  const home = homeDestination(data);
  if (!home) throw new PrayerRuntimeError("home_not_set", "Agent has no home destination set");
  return home;
}
