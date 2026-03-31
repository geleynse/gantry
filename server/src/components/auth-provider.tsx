"use client";

import { AuthContext, useAuthFetch } from "@/hooks/use-auth";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const auth = useAuthFetch();
  return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>;
}
