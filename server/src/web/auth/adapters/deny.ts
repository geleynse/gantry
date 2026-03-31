/**
 * DenyAdapter — Rejects all requests.
 * Used when auth is not configured but the server is externally accessible.
 * Enforces fail-closed behavior.
 */

import type { AuthAdapter } from "../types.js";

export const createDenyAdapter = (): AuthAdapter => {
  return {
    name: "deny",
    authenticate: async () => null,
  };
};
