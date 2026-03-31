"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";

export type AuthRole = "admin" | "viewer";

export interface AuthState {
  role: AuthRole;
  identity: string | null;
  loading: boolean;
  isAdmin: boolean;
}

const defaultState: AuthState = {
  role: "viewer",
  identity: null,
  loading: true,
  isAdmin: false,
};

export const AuthContext = createContext<AuthState>(defaultState);

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

function parseAuthResponse(data: unknown): Pick<AuthState, "role" | "identity" | "isAdmin"> {
  if (!data || typeof data !== "object") {
    throw new Error("Invalid auth payload");
  }

  const payload = data as { role?: unknown; identity?: unknown };
  if (payload.role !== "admin" && payload.role !== "viewer") {
    throw new Error("Invalid auth role");
  }

  return {
    role: payload.role,
    identity: typeof payload.identity === "string" ? payload.identity : null,
    isAdmin: payload.role === "admin",
  };
}

/**
 * Fetch auth state from /api/auth/me.
 * Used by AuthProvider to populate context.
 */
export function useAuthFetch(): AuthState {
  const [state, setState] = useState<AuthState>(defaultState);

  useEffect(() => {
    const controller = new AbortController();

    apiFetch<unknown>("/auth/me", { signal: controller.signal })
      .then((data) => {
        setState({ ...parseAuthResponse(data), loading: false });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        // On error, assume viewer (safe default)
        setState({ role: "viewer", identity: null, loading: false, isAdmin: false });
      });

    return () => {
      controller.abort();
    };
  }, []);

  return state;
}
