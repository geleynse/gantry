"use client";

import { useEffect } from "react";

/**
 * Registers the PWA service worker on mount.
 * Rendered in the root layout so it runs once on app load.
 * No-ops in browsers that don't support service workers.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .catch(() => {
        // SW registration failure is non-fatal — dashboard works without it
      });
  }, []);

  return null;
}
