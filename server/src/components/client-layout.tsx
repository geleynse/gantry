"use client";

import { StartupSplash } from "@/components/startup-splash";
import { FleetStatusProvider } from "@/hooks/use-fleet-status";

export function ClientLayout({ children }: { children: React.ReactNode }) {
  return <StartupSplash>{children}</StartupSplash>;
}

/**
 * Wraps client-only context providers that should span the entire app
 * (sidebar + top-bar + page content). Mounting the FleetStatusProvider here
 * means every page shares one `/api/status/stream` SSE subscription instead
 * of opening one per call to `useFleetStatus()`.
 */
export function ClientProviders({ children }: { children: React.ReactNode }) {
  return <FleetStatusProvider>{children}</FleetStatusProvider>;
}
