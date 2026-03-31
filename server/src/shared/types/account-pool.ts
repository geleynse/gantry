/**
 * AccountPool shared types — account credential management.
 *
 * These types are used across multiple modules:
 * - proxy/account-pool.ts (AccountPool implementation)
 * - proxy/session-manager.ts (account pool integration)
 * - Web API endpoints (account queries)
 */

export type AccountStatus = "available" | "assigned" | "disabled";

export interface Account {
  id: string;
  username: string;
  password: string;
  status: AccountStatus;
  assignedTo: string | null;
  assignedAt: string | null;
  faction?: string;
  notes?: string;
  lastLogin?: string;
}

export interface AccountPoolConfig {
  autoAssign: boolean;
  matchFaction: boolean;
  releaseOnShutdown: boolean;
  maxAssignmentsPerAccount: number;
}

export interface AccountPoolFile {
  accounts: Account[];
  config?: Partial<AccountPoolConfig>;
}

/**
 * Account with password redacted (safe for public API responses).
 */
export type AccountPublic = Omit<Account, "password">;
