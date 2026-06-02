/**
 * overseer-prompt.ts — Prompt builder for the OverseerAgent LLM call.
 *
 * Provides two exported functions:
 *   buildSystemPrompt(maxActions) — static system prompt defining the overseer's role
 *   buildUserPrompt(snapshot, previousDecisions) — structured per-tick user prompt
 */

import type { FleetSnapshot } from "./coordinator-state.js";
import type { OverseerDecision, OverseerAction } from "../shared/types/overseer.js";

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

/**
 * Returns a static system prompt (~300 tokens) defining the overseer role.
 */
export function buildSystemPrompt(maxActions: number): string {
  return `You are the fleet overseer for a SpaceMolt bot fleet. Your job is to monitor fleet health and issue corrective actions when needed.

Rules:
- Use no_action when the fleet is operating normally — do not intervene unnecessarily.
- Prefer issue_order and trigger_routine over lifecycle actions (start_agent / stop_agent).
- Do not start or stop agents rapidly — lifecycle changes should be rare and deliberate.
- Issue at most ${maxActions} actions per tick.
- Use trigger_routine for structured multi-step tasks (mining, trading, refueling).
- Use issue_order for one-off instructions that don't map to a routine.
- Use reassign_role only when an agent is clearly misallocated for its current conditions.

Respond with a JSON object:
{
  "reasoning": "brief explanation of what you observed and why",
  "actions": [
    { "type": "action_type", "params": { ... } }
  ]
}

Valid action types: issue_order, trigger_routine, start_agent, stop_agent, reassign_role, no_action.`;
}

// ---------------------------------------------------------------------------
// User prompt
// ---------------------------------------------------------------------------

/**
 * Builds a structured markdown prompt from current fleet state and history.
 */
export function buildUserPrompt(
  snapshot: FleetSnapshot,
  previousDecisions: OverseerDecision[],
): string {
  const lines: string[] = [];

  // --- Agent table ---
  lines.push("## Fleet Status\n");
  lines.push("| Agent | Status | Location | Credits | Cargo | Fuel | Role |");
  lines.push("|-------|--------|----------|---------|-------|------|------|");

  for (const agent of snapshot.agents) {
    const status = agent.isInCombat ? "COMBAT" : agent.isOnline ? "online" : "offline";
    const rawLoc = agent.poi ?? agent.system ?? "unknown";
    const location = typeof rawLoc === "object" ? JSON.stringify(rawLoc) : String(rawLoc);
    const credits = agent.credits !== undefined ? agent.credits.toLocaleString() : "—";
    const cargo =
      agent.cargoUsed !== undefined && agent.cargoMax !== undefined
        ? `${agent.cargoUsed}/${agent.cargoMax}`
        : "—";
    const fuel =
      agent.fuel === undefined
        ? "—"
        : agent.fuelMax !== undefined && agent.fuelMax > 0
          ? `${Math.round((agent.fuel / agent.fuelMax) * 100)}%`
          : `${agent.fuel}`;
    lines.push(`| ${agent.name} | ${status} | ${location} | ${credits} | ${cargo} | ${fuel} | ${agent.role ?? "—"} |`);
  }

  // --- Fleet totals ---
  lines.push("");
  lines.push("## Fleet Totals");
  const { fleetTotals } = snapshot;
  lines.push(
    `Credits: ${fleetTotals.totalCredits.toLocaleString()} | ` +
    `Cargo: ${fleetTotals.totalCargoUsed}/${fleetTotals.totalCargoMax} | ` +
    `Online: ${fleetTotals.onlineCount} | Offline: ${fleetTotals.offlineCount}`,
  );

  // --- Auto-triage: detect agents needing attention ---
  const triageItems: string[] = [];
  for (const agent of snapshot.agents) {
    const name = agent.name;
    const locName = agent.poi || agent.system || "unknown location";

    // Offline agents
    if (!agent.isOnline) {
      // Transient-miss guard: the status cache has a 5-minute online threshold. An agent
      // finishing a turn cycle can briefly miss the window without actually being offline
      // (race between turn-cycle exit and the next status fetch). Only classify as OFFLINE
      // when the cache age is >10 minutes (2× the threshold) OR when there is no cache entry
      // at all (agent was never seen). A miss under 10 minutes is a transient gap — skip.
      const OFFLINE_CONFIRM_MS = 10 * 60 * 1000; // 10 minutes
      const isConfirmedOffline =
        agent.statusCacheAgeMs === undefined || agent.statusCacheAgeMs > OFFLINE_CONFIRM_MS;
      if (!isConfirmedOffline) {
        // Transient gap — agent recently had status; skip triage this tick.
        continue;
      }

      // Perma-stranded check: agent logged out with 0 fuel and is sitting at a non-refueling
      // POI (or no POI). Restarting just burns cost cycling logout/login until external rescue
      // arrives. Flag for operator attention instead of auto-restart.
      if (agent.fuel !== undefined && agent.fuel <= 1) {
        triageItems.push(
          `🚫 ${name}: PERMA-STRANDED (offline, last seen with ${agent.fuel} fuel at ${locName}) — DO NOT call start_agent. The agent has been logging out compliantly because it has no fuel. Restarting only cycles logout/login and burns cost. Required action: write a fleet_report describing the rescue need (system, POI, fuel needed). Operator must grant fuel or teleport. Skip this triage item until the agent moves or fuel changes.`,
        );
        continue;
      }
      triageItems.push(`⚠ ${name}: OFFLINE → call start_agent(agent="${name}")`);
      continue;
    }

    // Idle agents (last tool call > 10 minutes ago)
    if (agent.lastToolCallAge !== undefined && agent.lastToolCallAge > 600) {
      const mins = Math.round(agent.lastToolCallAge / 60);
      triageItems.push(`⚠ ${name}: IDLE ${mins}m → call issue_order(agent="${name}", message="Login and resume your mission")`);
    }

    // Transit detection: empty location means agent is mid-jump.
    // Distinguish two cases:
    //   - TRANSIT IDLE (cargo > 0): in hyperspace with payload — wait, do NOT intervene.
    //   - TRANSIT STUCK (cargo === 0 or undefined): no payload, may be genuinely stuck — order a reset.
    // Either way the agent can't execute routines until location resolves.
    const hasStatusData = agent.credits !== undefined || agent.system !== undefined || agent.poi !== undefined;
    if (!hasStatusData) {
      triageItems.push(`ℹ ${name}: AWAITING STATUS — agent recently started, no data yet. No action needed.`);
      continue; // No data yet — skip cargo/fuel/credits checks
    }
    if (!(agent.poi ?? agent.system)) {
      if ((agent.cargoUsed ?? 0) > 0) {
        triageItems.push(`ℹ ${name}: TRANSIT IDLE (in hyperspace, cargo ${agent.cargoUsed}/${agent.cargoMax ?? "?"}) — agent is mid-jump with payload. Do NOT stop_agent. Do NOT issue_order — they cannot consume orders mid-transit. Wait one turn.`);
      } else {
        triageItems.push(`⚠ ${name}: TRANSIT STUCK (empty location, no cargo) → call issue_order(agent="${name}", message="Logout, wait 2 minutes, then re-login to reset position"). Do NOT trigger routines — they will fail during transit.`);
      }
      continue; // Skip cargo/fuel/credits checks — transit must resolve first
    }

    // Cargo full (>90%) — suggest sell_cycle with deposit fallback
    if (
      agent.cargoUsed !== undefined &&
      agent.cargoMax !== undefined &&
      agent.cargoMax > 0 &&
      agent.cargoUsed / agent.cargoMax > 0.9
    ) {
      triageItems.push(`⚠ ${name}: CARGO FULL (${agent.cargoUsed}/${agent.cargoMax}) → call issue_order(agent="${name}", message="Sell cargo: analyze_market then multi_sell. If no demand, deposit to station storage. If still full, jettison iron_ore.")`);
    }

    // Zero credits
    if (agent.credits === 0) {
      triageItems.push(`⚠ ${name}: ZERO CREDITS → call trigger_routine(agent="${name}", routine="mining_loop")`);
    }

    // Low fuel (<20%) — but distinguish PERMA-STRANDED (0 fuel + undocked) from
    // recoverable LOW FUEL. refuel_repair routine needs to travel to a station,
    // and travel requires fuel — so 0-fuel-undocked agents can't self-rescue.
    if (agent.fuel !== undefined && agent.fuelMax !== undefined && agent.fuelMax > 0) {
      if (agent.fuel <= 1 && agent.docked !== true) {
        triageItems.push(
          `🚫 ${name}: PERMA-STRANDED (online, ${agent.fuel} fuel, undocked at ${locName}) — DO NOT call trigger_routine refuel_repair. Travel needs fuel; the routine will fail. Required action: write a fleet_report describing the rescue need (system, POI, fuel needed) and identify a fleetmate within 5 jumps with a Refueling Pump fitted who can deliver. One report per stranded agent per hour — do not repeat.`,
        );
      } else if (agent.fuel / agent.fuelMax < 0.2) {
        triageItems.push(`⚠ ${name}: LOW FUEL (${Math.round((agent.fuel / agent.fuelMax) * 100)}%) → call trigger_routine(agent="${name}", routine="refuel_repair")`);
      }
    }
  }

  if (triageItems.length > 0) {
    lines.push("");
    lines.push("## ⚠ Triage — Agents Needing Attention");
    lines.push("Act on these issues this turn:");
    for (const item of triageItems) {
      lines.push(`- ${item}`);
    }
  }

  // --- Recent events ---
  if (snapshot.recentEvents.length > 0) {
    lines.push("");
    lines.push("## Recent Events");
    const events = snapshot.recentEvents.slice(-20);
    for (const ev of events) {
      lines.push(`- ${ev.agent}: ${ev.type}`);
    }
  }

  // --- Market summary ---
  if (snapshot.marketSummary.length > 0) {
    lines.push("");
    lines.push("## Market Opportunities");
    for (const opp of snapshot.marketSummary) {
      lines.push(
        `- ${opp.item_name} (${opp.item_id}): +${opp.profit_per_unit}/unit, ` +
        `${opp.estimated_volume} demand | ${opp.buy_empire} → ${opp.sell_empire}`,
      );
    }
  }

  const previewMsg = (msg: string) =>
    msg.length > 60 ? msg.slice(0, 57) + "..." : msg;

  // --- Active orders ---
  if (snapshot.activeOrders.length > 0) {
    lines.push("");
    lines.push("## Active Orders");
    for (const order of snapshot.activeOrders.slice(0, 10)) {
      const target = order.target_agent ?? "all";
      const ageMin = Math.round((Date.now() - new Date(order.created_at).getTime()) / 60000);
      lines.push(`- ${target}: "${previewMsg(order.message)}" (${ageMin}m ago, ${order.priority})`);
    }
  }

  // --- Recently delivered orders ---
  if (snapshot.recentDeliveries.length > 0) {
    lines.push("");
    lines.push("## Recently Delivered Orders");
    for (const delivery of snapshot.recentDeliveries) {
      const time = new Date(delivery.delivered_at).toISOString().slice(11, 16); // HH:MM
      lines.push(`- ${delivery.target_agent}: "${previewMsg(delivery.message)}" (delivered at ${time})`);
    }
  }

  // --- Previous decisions ---
  if (previousDecisions.length > 0) {
    lines.push("");
    lines.push("## Previous Decisions");
    for (const dec of previousDecisions) {
      let actions: OverseerAction[] = [];
      try {
        actions = JSON.parse(dec.actions_json) as OverseerAction[];
      } catch {
        // malformed — skip actions listing
      }
      const actionSummary = actions
        .map((a) => {
          const agent =
            (a.params?.agent as string) ??
            (a.params?.name as string) ??
            (a.params?.target as string) ??
            "";
          return agent ? `${a.type}(${agent})` : a.type;
        })
        .join(", ");
      lines.push(
        `- Tick ${dec.tick_number} (${dec.triggered_by}): ${actionSummary || "no actions"} [${dec.status}]`,
      );
    }
  }

  return lines.join("\n");
}
