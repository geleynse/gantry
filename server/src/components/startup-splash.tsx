"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";

interface StartupStatus {
  serverUptime: number;
  agentsConnected: number;
  agentsTotal: number;
  serverReady: boolean;
  services: { name: string; ready: boolean; detail?: string }[];
}

export function StartupSplash({ children }: { children: React.ReactNode }) {
  const [dismissed, setDismissed] = useState(false);
  const [fadeOut, setFadeOut] = useState(false);
  const [status, setStatus] = useState<StartupStatus | null>(null);
  const [visibleServices, setVisibleServices] = useState(0);

  // Skip splash if already dismissed this session
  useEffect(() => {
    if (typeof window !== "undefined" && sessionStorage.getItem("gantry-splash-dismissed")) {
      setDismissed(true);
    }
  }, []);

  // Poll startup status
  useEffect(() => {
    if (dismissed) return;
    let active = true;
    const poll = async () => {
      try {
        const data = await apiFetch<StartupStatus>("/status/startup");
        if (active) setStatus(data);
      } catch {
        // Server not ready yet
      }
    };
    poll();
    const id = setInterval(poll, 1000);
    return () => { active = false; clearInterval(id); };
  }, [dismissed]);

  // Reveal services one at a time
  useEffect(() => {
    if (dismissed || !status) return;
    const total = status.services.length;
    if (visibleServices >= total) return;
    const tid = setTimeout(() => setVisibleServices((v) => v + 1), 400);
    return () => clearTimeout(tid);
  }, [dismissed, status, visibleServices]);

  // Auto-dismiss when ready or after timeout
  useEffect(() => {
    if (dismissed) return;
    if (status?.serverReady) {
      const tid = setTimeout(() => {
        setFadeOut(true);
        setTimeout(() => {
          sessionStorage.setItem("gantry-splash-dismissed", "1");
          setDismissed(true);
        }, 600);
      }, 800);
      return () => clearTimeout(tid);
    }
    // Hard timeout: dismiss after 10s regardless
    const tid = setTimeout(() => {
      setFadeOut(true);
      setTimeout(() => {
        sessionStorage.setItem("gantry-splash-dismissed", "1");
        setDismissed(true);
      }, 600);
    }, 10000);
    return () => clearTimeout(tid);
  }, [dismissed, status?.serverReady]);

  if (dismissed) return <>{children}</>;

  return (
    <>
      {children}
      <div
        className={cn(
          "fixed inset-0 z-50 bg-background flex flex-col items-center justify-center transition-opacity duration-500",
          fadeOut ? "opacity-0 pointer-events-none" : "opacity-100",
        )}
      >
        {/* Branding */}
        <h1 className="text-3xl font-bold text-primary uppercase tracking-[0.3em] mb-1">
          SpaceMolt
        </h1>
        <p className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground mb-10">
          Gantry Control
        </p>

        {/* Service checklist */}
        <div className="w-64 space-y-3">
          {status?.services.map((svc, i) => (
            <div
              key={svc.name}
              className={cn(
                "flex items-center gap-3 text-xs transition-all duration-500",
                i < visibleServices ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2",
              )}
            >
              <span className={cn(
                "w-4 h-4 flex items-center justify-center shrink-0 border",
                svc.ready
                  ? "border-success text-success"
                  : "border-muted-foreground/30 text-muted-foreground/30",
              )}>
                {svc.ready && <Check className="w-3 h-3" />}
              </span>
              <span className={cn(
                "uppercase tracking-wider",
                svc.ready ? "text-foreground" : "text-muted-foreground",
              )}>
                {svc.name}
              </span>
              {svc.detail && (
                <span className="text-[9px] text-muted-foreground ml-auto tabular-nums">
                  {svc.detail}
                </span>
              )}
            </div>
          ))}
        </div>

        {/* Systems online message */}
        {status?.serverReady && visibleServices >= (status?.services.length ?? 0) && (
          <p className="mt-8 text-[9px] uppercase tracking-[0.2em] text-success animate-pulse">
            Systems Online
          </p>
        )}

        {/* Loading dots */}
        {!status?.serverReady && (
          <div className="flex gap-1.5 mt-10">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="w-2 h-2 rounded-full bg-primary/60 animate-bounce"
                style={{ animationDelay: `${-0.3 + i * 0.15}s` }}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
