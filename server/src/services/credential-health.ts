import { createLogger } from "../lib/logger.js";
import type { CredentialValidationResult } from "./credentials-crypto.js";

const log = createLogger("credential-health");

type CredentialHealthEntry = {
  agentName: string;
  username: string;
  status: "ok" | "auth_failed" | "network_error" | "no_credentials";
  checkedAt: number;
};

const credentialHealth = new Map<string, CredentialHealthEntry>();

function normalizeAgentName(agentName: string): string {
  return agentName.trim().toLowerCase();
}

export function recordCredentialValidationResult(result: CredentialValidationResult): void {
  const status = result.ok ? "ok" : result.reason;
  const key = normalizeAgentName(result.agentName);
  if (!key || key === "(unknown)") return;

  credentialHealth.set(key, {
    agentName: result.agentName,
    username: result.username,
    status,
    checkedAt: Date.now(),
  });

  if (status === "auth_failed") {
    log.error("credential auth failure recorded", {
      agent: result.agentName,
      username: result.username,
    });
  } else if (status === "ok") {
    log.info("credential health cleared", {
      agent: result.agentName,
      username: result.username,
    });
  }
}

export function recordCredentialAuthFailure(agentName: string, username: string): void {
  recordCredentialValidationResult({
    ok: false,
    agentName,
    username,
    reason: "auth_failed",
  });
}

export function recordCredentialSuccess(agentName: string, username: string): void {
  recordCredentialValidationResult({
    ok: true,
    agentName,
    username,
  });
}

export function getCredentialHealth(agentName: string): CredentialHealthEntry | undefined {
  return credentialHealth.get(normalizeAgentName(agentName));
}

export function getCredentialStartBlock(agentName: string): string | null {
  const entry = getCredentialHealth(agentName);
  if (entry?.status !== "auth_failed") return null;
  return `Refusing to start ${agentName}: credentials for username "${entry.username}" failed authentication. Update fleet-credentials, then restart validation or login once to clear the block.`;
}

export function clearCredentialHealthForTesting(): void {
  credentialHealth.clear();
}
