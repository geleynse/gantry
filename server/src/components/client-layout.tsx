"use client";

import { StartupSplash } from "@/components/startup-splash";

export function ClientLayout({ children }: { children: React.ReactNode }) {
  return <StartupSplash>{children}</StartupSplash>;
}
