/**
 * PrayerLang ExecState checkpoint/resume.
 *
 * Lets a running prayer survive a Gantry server restart. The executor can be
 * configured (via `ExecutorDeps.checkpoint`) to dump the current `ExecState`
 * to disk on every step boundary. On startup, callers can call
 * `loadCheckpoint(agentName)` to retrieve the last snapshot, hydrate it back
 * into an `ExecState`, and pass it to the executor instead of letting it
 * initialize a fresh state.
 *
 * Storage: `<dir>/<agentName>.json` — written atomically (temp file + rename).
 * Default `<dir>` is `<FLEET_DIR>/data/prayer-state/` if `FLEET_DIR` is set,
 * otherwise `<server-cwd>/data/prayer-state/`. Override via
 * `setPrayerStateDir(path)` (used by tests).
 *
 * Format: plain JSON. Maps are encoded as `{__map: [[k, v], ...]}`. Anything
 * non-trivially-JSONable (closures, undefined) is dropped — the executor
 * never holds those on `ExecState`, so this is fine in practice.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "../../lib/atomic-write.js";
import { createLogger } from "../../lib/logger.js";
import type { ExecState, SubToolCall } from "./types.js";

const log = createLogger("prayer-checkpoint");

let _stateDir: string | null = null;

/** Override the directory checkpoints are written to. Mostly for tests. */
export function setPrayerStateDir(dir: string | null): void {
  _stateDir = dir;
}

/** Returns the current checkpoint directory, ensuring it exists on disk. */
export function getPrayerStateDir(): string {
  const dir = _stateDir ?? defaultStateDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    log.warn("could not create prayer-state dir", { dir, error: String(err) });
  }
  return dir;
}

function defaultStateDir(): string {
  const fleetDir = process.env.FLEET_DIR;
  const base = fleetDir && fleetDir.length > 0 ? fleetDir : process.cwd();
  return join(base, "data", "prayer-state");
}

function checkpointPath(agentName: string): string {
  // Sanitize: agent names are alphanumeric + dash in practice, but defend
  // against path traversal anyway.
  const safe = agentName.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(getPrayerStateDir(), `${safe}.json`);
}

interface SerializedExecState {
  version: 1;
  stepsExecuted: number;
  startedAt: number;
  transientRetriesUsed: number;
  log: SubToolCall[];
  cargoBaseline: { __map: Array<[string, number]> };
  haltRequested: boolean;
  interrupt: { reason: string } | null;
  /** Wall-clock time the checkpoint was written (epoch ms). */
  checkpointedAt: number;
}

/** Serialize `state` to a JSON string. Maps are encoded as `{__map: ...}`. */
export function serialize(state: ExecState): string {
  const payload: SerializedExecState = {
    version: 1,
    stepsExecuted: state.stepsExecuted,
    startedAt: state.startedAt,
    transientRetriesUsed: state.transientRetriesUsed,
    log: state.log,
    cargoBaseline: { __map: [...state.cargoBaseline.entries()] },
    haltRequested: state.haltRequested,
    interrupt: state.interrupt,
    checkpointedAt: Date.now(),
  };
  return JSON.stringify(payload);
}

/**
 * Deserialize a JSON string back into an `ExecState`. Throws if the payload
 * is malformed; callers (e.g. `loadCheckpoint`) catch and treat as no-op.
 */
export function deserialize(serialized: string): ExecState {
  const raw = JSON.parse(serialized) as Partial<SerializedExecState>;
  if (!raw || typeof raw !== "object") {
    throw new Error("checkpoint payload is not an object");
  }
  if (raw.version !== 1) {
    throw new Error(`unknown checkpoint version: ${String(raw.version)}`);
  }
  const cargoBaseline = decodeMap<string, number>(raw.cargoBaseline);
  return {
    stepsExecuted: numberOr(raw.stepsExecuted, 0),
    startedAt: numberOr(raw.startedAt, Date.now()),
    transientRetriesUsed: numberOr(raw.transientRetriesUsed, 0),
    log: Array.isArray(raw.log) ? raw.log as SubToolCall[] : [],
    cargoBaseline,
    haltRequested: Boolean(raw.haltRequested),
    interrupt: raw.interrupt ?? null,
  };
}

function numberOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function decodeMap<K, V>(value: unknown): Map<K, V> {
  if (!value || typeof value !== "object") return new Map();
  const tagged = value as { __map?: unknown };
  if (!Array.isArray(tagged.__map)) return new Map();
  const result = new Map<K, V>();
  for (const entry of tagged.__map) {
    if (Array.isArray(entry) && entry.length === 2) {
      result.set(entry[0] as K, entry[1] as V);
    }
  }
  return result;
}

/**
 * Write `state` to `<stateDir>/<agentName>.json` atomically. Failures are
 * logged and swallowed — checkpointing is best-effort.
 */
export function saveCheckpoint(agentName: string, state: ExecState): void {
  try {
    atomicWriteFileSync(checkpointPath(agentName), serialize(state));
  } catch (err) {
    log.warn("saveCheckpoint failed", { agent: agentName, error: String(err) });
  }
}

/**
 * Read and decode the last-written checkpoint for `agentName`. Returns `null`
 * if no checkpoint exists or if the file is corrupt (logged as a warning).
 */
export function loadCheckpoint(agentName: string): ExecState | null {
  const path = checkpointPath(agentName);
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    log.warn("loadCheckpoint read failed", { agent: agentName, path, error: String(err) });
    return null;
  }
  try {
    return deserialize(raw);
  } catch (err) {
    log.warn("loadCheckpoint deserialize failed; ignoring corrupt file", {
      agent: agentName,
      path,
      error: String(err),
    });
    return null;
  }
}

/** Delete an agent's checkpoint. Idempotent — missing-file is not an error. */
export function clearCheckpoint(agentName: string): void {
  const path = checkpointPath(agentName);
  if (!existsSync(path)) return;
  try {
    unlinkSync(path);
  } catch (err) {
    log.warn("clearCheckpoint unlink failed", { agent: agentName, path, error: String(err) });
  }
}
