import type { Request } from "express";

export type AuthRole = "admin" | "viewer";

export interface AuthResult {
  role: AuthRole;
  identity?: string; // email, token name, etc.
}

export interface AuthAdapter {
  name: string;
  authenticate(req: Request): Promise<AuthResult | null>;
}

/** Auth configuration as stored in fleet-config.json */
export interface AuthConfig {
  adapter: string; // "none" | "token" | "cloudflare-access" | file path
  config?: Record<string, unknown>;
}
