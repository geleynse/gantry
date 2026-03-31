/**
 * Backwards-compatible re-export shim.
 * All config logic lives in config/ submodules; this file ensures
 * existing `from '../config.js'` imports continue to resolve.
 */
export * from "./config/index.js";
