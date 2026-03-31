"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Eye,
  Factory,
  Gauge,
  LayoutDashboard,
  Map,
  Radio,
  ScrollText,
  Search,
  ShieldCheck,
  FileText,
  Skull,
  StickyNote,
  Timer,
  Target,
  Trophy,
  Users,
  Warehouse,
  RadioTower,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useFleetStatus } from "@/hooks/use-fleet-status";
import { useAgentNames } from "@/hooks/use-agent-names";
import { useAuth } from "@/hooks/use-auth";
import { useOutboundPendingCount } from "@/components/outbound-review";

// ---------------------------------------------------------------------------
// Alert count hook — used by Sidebar for the badge
// ---------------------------------------------------------------------------

function useAlertCount(pollIntervalMs = 30_000): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const fetchCount = async () => {
      try {
        const res = await fetch("/api/alerts/count");
        if (!res.ok) return;
        const data = await res.json() as { count: number };
        if (!cancelled) setCount(data.count);
      } catch {
        // Non-fatal: badge stays at last known value
      }
    };
    fetchCount();
    const interval = setInterval(fetchCount, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [pollIntervalMs]);

  return count;
}

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  adminOnly?: boolean;
  badgeKey?: "alertCount";
}

interface NavSection {
  label: string;
  items: NavItem[];
}

const NAV_SECTIONS: NavSection[] = [
  {
    label: "Operations",
    items: [
      { href: "/", label: "Dashboard", icon: LayoutDashboard },
      { href: "/fleet", label: "Fleet", icon: Warehouse },
      { href: "/activity", label: "Activity", icon: Activity },
      { href: "/alerts", label: "Alerts", icon: AlertTriangle, badgeKey: "alertCount" },
      { href: "/logs", label: "Logs", icon: ScrollText },
    ],
  },
  {
    label: "Intelligence",
    items: [
      { href: "/map", label: "Map", icon: Map },
      { href: "/analytics", label: "Analytics", icon: BarChart3 },
      { href: "/diagnostics", label: "Diagnostics", icon: Gauge },
      { href: "/rate-limits", label: "Rate Limits", icon: Timer },
    ],
  },
  {
    label: "Game",
    items: [
      { href: "/combat", label: "Combat", icon: Skull },
      { href: "/facilities", label: "Facilities", icon: Factory },
      { href: "/leaderboard", label: "Leaderboard", icon: Trophy },
      { href: "/missions", label: "Missions", icon: Target },
      { href: "/notes", label: "Notes", icon: StickyNote },
      { href: "/notes/search", label: "Memory Search", icon: Search },
      { href: "/comms", label: "Comms", icon: Radio },
    ],
  },
  {
    label: "Fleet Control",
    items: [
      { href: "/fleet/broadcast", label: "Broadcast", icon: RadioTower, adminOnly: true },
    ],
  },
  {
    label: "Admin",
    items: [
      { href: "/prompts", label: "Prompts", icon: FileText, adminOnly: true },
      { href: "/overseer", label: "Overseer", icon: Eye, adminOnly: true },
    ],
  },
];

const STORAGE_KEY = "fleet-sidebar-collapsed";
const SECTIONS_STORAGE_KEY = "fleet-sidebar-sections";

function SidebarContent({
  collapsed,
  toggleCollapsed,
  onNavigate,
}: {
  collapsed: boolean;
  toggleCollapsed: () => void;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const { data: fleetStatus } = useFleetStatus();
  const fleetName = fleetStatus?.fleetName;
  const agentNames = useAgentNames();
  const [agentsOpen, setAgentsOpen] = useState(true);
  const { isAdmin } = useAuth();
  const pendingCount = useOutboundPendingCount();
  const alertCount = useAlertCount();

  // Track which sections are expanded (all default to true)
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const stored = localStorage.getItem(SECTIONS_STORAGE_KEY);
      return stored ? JSON.parse(stored) : {};
    } catch {
      return {};
    }
  });

  const isSectionExpanded = (label: string) => expandedSections[label] !== false;

  const toggleSection = (label: string) => {
    setExpandedSections((prev) => {
      const next = { ...prev, [label]: !isSectionExpanded(label) };
      localStorage.setItem(SECTIONS_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  };

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  };

  const isAgentActive = (slug: string) => pathname === `/agent/${slug}` || pathname === `/agent/${slug}/`;

  const getBadgeCount = (badgeKey?: NavItem["badgeKey"]): number => {
    if (badgeKey === "alertCount") return alertCount;
    return 0;
  };

  const renderNavLink = (item: NavItem) => {
    const Icon = item.icon;
    const badge = getBadgeCount(item.badgeKey);
    return (
      <li key={item.href}>
        <Link
          href={item.href}
          onClick={onNavigate}
          className={cn(
            "flex items-center gap-3 px-2 py-1.5 text-sm transition-colors",
            "hover:bg-secondary hover:text-foreground",
            isActive(item.href)
              ? "bg-primary/10 text-primary font-medium border-l-2 border-l-primary"
              : "text-muted-foreground border-l-2 border-l-transparent"
          )}
          title={collapsed ? item.label : undefined}
        >
          <span className="relative shrink-0">
            <Icon className="w-4 h-4" />
            {collapsed && badge > 0 && (
              <span className="absolute -top-1 -right-1 w-2 h-2 bg-destructive rounded-full" />
            )}
          </span>
          {!collapsed && (
            <>
              <span className="truncate flex-1">{item.label}</span>
              {badge > 0 && (
                <span className="bg-destructive text-destructive-foreground text-xs px-1.5 py-0.5 rounded-full font-bold leading-none">
                  {badge}
                </span>
              )}
            </>
          )}
        </Link>
      </li>
    );
  };

  return (
    <>
      {/* Logo / brand row */}
      <div
        className={cn(
          "flex items-center h-12 border-b border-border shrink-0 px-3",
          collapsed ? "justify-center" : "justify-between"
        )}
      >
        {!collapsed && (
          <div className="flex flex-col min-w-0">
            <span className="text-primary font-semibold tracking-widest uppercase text-xs truncate">
              Gantry
            </span>
            {fleetName && (
              <span className="text-[9px] text-muted-foreground tracking-wider uppercase truncate">
                {fleetName}
              </span>
            )}
          </div>
        )}
        <button
          onClick={toggleCollapsed}
          className="hidden md:flex items-center justify-center w-7 h-7 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? (
            <ChevronRight className="w-4 h-4" />
          ) : (
            <ChevronLeft className="w-4 h-4" />
          )}
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden py-2">
        {NAV_SECTIONS.map((section) => {
          const visibleItems = section.items.filter(({ adminOnly }) => !adminOnly || isAdmin);
          if (visibleItems.length === 0) return null;

          const expanded = isSectionExpanded(section.label);

          return (
            <div key={section.label} className="mb-1">
              {/* Section header */}
              {!collapsed ? (
                <button
                  onClick={() => toggleSection(section.label)}
                  className="flex w-full items-center gap-1 px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                >
                  <ChevronRight
                    className={cn(
                      "w-3 h-3 shrink-0 transition-transform",
                      expanded && "rotate-90"
                    )}
                  />
                  <span>{section.label}</span>
                </button>
              ) : (
                <div className="mx-2 my-1 border-t border-border/50" />
              )}

              {/* Section items */}
              {(collapsed || expanded) && (
                <ul className="space-y-0.5 px-1">
                  {visibleItems.map(renderNavLink)}
                </ul>
              )}
            </div>
          );
        })}

        {/* Outbound review link — admin only, shows pending badge */}
        {isAdmin && (
          <ul className="space-y-0.5 px-1">
            <li key="/outbound-review">
              <Link
                href="/outbound-review"
                onClick={onNavigate}
                className={cn(
                  "flex items-center gap-3 px-2 py-1.5 text-sm transition-colors",
                  "hover:bg-secondary hover:text-foreground",
                  isActive("/outbound-review")
                    ? "bg-primary/10 text-primary font-medium border-l-2 border-l-primary"
                    : "text-muted-foreground border-l-2 border-l-transparent"
                )}
                title={collapsed ? "Review" : undefined}
              >
                <ShieldCheck className="w-4 h-4 shrink-0" />
                {!collapsed && (
                  <>
                    <span className="truncate flex-1">Review</span>
                    {pendingCount > 0 && (
                      <span className="bg-warning text-warning-content text-xs px-1.5 py-0.5 rounded-full font-bold leading-none">
                        {pendingCount}
                      </span>
                    )}
                  </>
                )}
                {collapsed && pendingCount > 0 && (
                  <span className="absolute top-0.5 right-0.5 w-2 h-2 bg-warning rounded-full" />
                )}
              </Link>
            </li>
          </ul>
        )}

        {/* Agents group */}
        <div className="mt-2 px-1">
          <button
            onClick={() => setAgentsOpen((o) => !o)}
            className={cn(
              "flex w-full items-center gap-3 px-2 py-1.5 text-sm transition-colors",
              "hover:bg-secondary hover:text-foreground text-muted-foreground"
            )}
            title={collapsed ? "Agents" : undefined}
          >
            <Users className="w-4 h-4 shrink-0" />
            {!collapsed && (
              <>
                <span className="flex-1 text-left truncate">Agents</span>
                <ChevronRight
                  className={cn(
                    "w-3 h-3 shrink-0 transition-transform",
                    agentsOpen && "rotate-90"
                  )}
                />
              </>
            )}
          </button>

          {agentsOpen && !collapsed && agentNames.length > 0 && (
            <ul className="mt-0.5 space-y-0.5">
              {agentNames.map((name) => (
                <li key={name}>
                  <Link
                    href={`/agent/${name}`}
                    onClick={onNavigate}
                    className={cn(
                      "flex items-center gap-2 pl-9 pr-2 py-1.5 text-sm transition-colors",
                      "hover:bg-secondary hover:text-foreground",
                      isAgentActive(name)
                        ? "bg-primary/10 text-primary font-medium border-l-2 border-l-primary"
                        : "text-muted-foreground border-l-2 border-l-transparent"
                    )}
                  >
                    {name === "overseer" && (
                      <Eye className="w-3.5 h-3.5 shrink-0 text-primary/70" />
                    )}
                    <span className="truncate">{name}</span>
                    {name === "overseer" && (
                      <span className="text-[9px] font-mono font-semibold uppercase tracking-wider text-primary/60 shrink-0">
                        overseer
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {/* Collapsed agent links: show individual icons with tooltip */}
          {collapsed && agentNames.length > 0 && (
            <ul className="mt-0.5 space-y-0.5 px-1">
              {agentNames.map((name) => (
                <li key={name}>
                  <Link
                    href={`/agent/${name}`}
                    title={name}
                    className={cn(
                      "flex items-center justify-center w-8 h-7 mx-auto text-xs transition-colors",
                      "hover:bg-secondary hover:text-foreground font-mono",
                      isAgentActive(name)
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground"
                    )}
                  >
                    {name === "overseer" ? (
                      <Eye className="w-3.5 h-3.5" />
                    ) : (
                      name.slice(0, 2).toUpperCase()
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </nav>
    </>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Restore collapsed state from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored !== null) {
      setCollapsed(stored === "true");
    }
  }, []);

  // Close mobile drawer on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // Listen for open events from TopBar hamburger
  useEffect(() => {
    const handler = () => setMobileOpen(true);
    document.addEventListener("sidebar:open", handler);
    return () => document.removeEventListener("sidebar:open", handler);
  }, []);

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  }

  return (
    <>
      {/* Desktop sidebar */}
      <aside
        className={cn(
          "hidden md:flex flex-col h-screen bg-card border-r border-border shrink-0 transition-[width] duration-200 overflow-hidden",
          collapsed ? "w-[56px]" : "w-[240px]"
        )}
      >
        <SidebarContent collapsed={collapsed} toggleCollapsed={toggleCollapsed} />
      </aside>

      {/* Mobile overlay + drawer */}
      {mobileOpen && (
        <>
          <div
            className="sidebar-mobile-overlay md:hidden fixed inset-0 bg-black/50 z-40"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="sidebar-mobile-drawer md:hidden fixed inset-y-0 left-0 w-[260px] bg-card border-r border-border z-50 flex flex-col">
            <div className="flex items-center justify-end h-12 border-b border-border px-3">
              <button
                onClick={() => setMobileOpen(false)}
                className="flex items-center justify-center w-7 h-7 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                aria-label="Close menu"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <SidebarContent
              collapsed={false}
              toggleCollapsed={toggleCollapsed}
              onNavigate={() => setMobileOpen(false)}
            />
          </aside>
        </>
      )}
    </>
  );
}
