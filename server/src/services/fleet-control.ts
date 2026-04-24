import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FLEET_DIR } from "../config.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("fleet-control");

export interface FleetDisabledState {
  disabled: boolean;
  reason?: string;
  disabledAt?: string;
}

function statePath(): string {
  return join(FLEET_DIR, "data", "fleet-disabled.json");
}

export function getFleetDisabledState(): FleetDisabledState {
  const path = statePath();
  if (!existsSync(path)) return { disabled: false };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as FleetDisabledState;
    return { ...parsed, disabled: true };
  } catch (err) {
    log.warn("failed to read fleet disabled state; treating fleet as disabled", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { disabled: true, reason: "invalid fleet-disabled state file" };
  }
}

export function isFleetDisabled(): boolean {
  return getFleetDisabledState().disabled;
}

export function disableFleet(reason: string): FleetDisabledState {
  const state: FleetDisabledState = {
    disabled: true,
    reason,
    disabledAt: new Date().toISOString(),
  };
  const path = statePath();
  mkdirSync(join(FLEET_DIR, "data"), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
  log.warn("fleet disabled", { reason });
  return state;
}

export function enableFleetState(reason: string): FleetDisabledState {
  enableFleet(reason);
  return getFleetDisabledState();
}

export function enableFleet(reason: string): void {
  const path = statePath();
  if (existsSync(path)) {
    unlinkSync(path);
    log.info("fleet enabled", { reason });
  }
}
