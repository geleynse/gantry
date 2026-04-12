# UI

> **Navigation aid.** Component inventory and prop signatures extracted via AST. Read the source files before adding props or modifying component logic.

**68 components** (react)

## Client Components

- **ActivityPage** — `server/src/app/activity/page.tsx`
- **AgentDetailClient** — `server/src/app/agent/[name]/client.tsx`
- **LifetimeStatsPanel** — props: label, color, bucket, defaultOpen — `server/src/app/agent/lifetime-stats.tsx`
- **AlertsPage** — `server/src/app/alerts/page.tsx`
- **AnalyticsPage** — `server/src/app/analytics/page.tsx`
- **CombatPage** — `server/src/app/combat/page.tsx`
- **CommsPage** — props: onOrderCreated, agentNames — `server/src/app/comms/page.tsx`
- **ItemTooltip** — props: itemId, className — `server/src/app/components/ItemTooltip.tsx`
- **ShipComparison** — props: current, target, compact, className — `server/src/app/components/ShipComparison.tsx`
- **DiagnosticsPage** — `server/src/app/diagnostics/page.tsx`
- **FacilitiesPage** — `server/src/app/facilities/page.tsx`
- **BroadcastPage** — `server/src/app/fleet/broadcast/page.tsx`
- **CredentialsPage** — `server/src/app/fleet/credentials/page.tsx`
- **FleetPage** — `server/src/app/fleet/page.tsx`
- **LeaderboardPage** — `server/src/app/leaderboard/page.tsx`
- **MapPage** — `server/src/app/map/page.tsx`
- **MissionsPage** — `server/src/app/missions/page.tsx`
- **NotesPage** — `server/src/app/notes/page.tsx`
- **NotesSearchPage** — `server/src/app/notes/search/page.tsx`
- **OverseerPage** — `server/src/app/overseer/page.tsx`
- **DashboardPage** — `server/src/app/page.tsx`
- **PromptsPageWrapper** — `server/src/app/prompts/page.tsx`
- **RateLimitsPage** — `server/src/app/rate-limits/page.tsx`
- **SystemPopup** — props: data, screenPos — `server/src/components/SystemPopup.tsx`
- **ActivityFeed** — `server/src/components/activity-feed.tsx`
- **AgentActions** — props: agent, isAdmin — `server/src/components/agent-card-actions.tsx`
- **RoleTypeBadge** — props: agent — `server/src/components/agent-card-status.tsx`
- **AgentCard** — props: agent, gameState, name, compact — `server/src/components/agent-card.tsx`
- **AgentControls** — props: agentName, agent — `server/src/components/agent-controls.tsx`
- **CostChart** — props: active, payload — `server/src/components/analytics-charts.tsx`
- **AuthProvider** — `server/src/components/auth-provider.tsx`
- **ClientLayout** — `server/src/components/client-layout.tsx`
- **ControlsPanel** — props: agentName — `server/src/components/controls-panel.tsx`
- **CredentialDashboard** — `server/src/components/credential-dashboard.tsx`
- **CreditChart** — props: active, payload — `server/src/components/credit-chart.tsx`
- **DiaryViewer** — props: agentName — `server/src/components/diary-viewer.tsx`
- **EconomyPanel** — props: agentName — `server/src/components/economy-panel.tsx`
- **EncounterCard** — props: encounter, expanded, onToggle, events — `server/src/components/encounter-card.tsx`
- **EnrollmentForm** — props: onClose, onSuccess — `server/src/components/enrollment-form.tsx`
- **FleetCapacity** — props: label, sortK, activeSortKey, asc, onSort — `server/src/components/fleet-capacity.tsx`
- **FleetStatusSummary** — props: agents — `server/src/components/fleet-status-summary.tsx`
- **OverlayBar** — props: active, onClick, title — `server/src/components/galaxy-map-overlays.tsx`
- **MapTooltip** — props: node, pos — `server/src/components/galaxy-map-tooltip.tsx`
- **GalaxyMap** — props: nodes, graphRef, containerWidth, containerHeight — `server/src/components/galaxy-map.tsx`
- **HealthBar** — props: value, max, label, size, invert — `server/src/components/health-bar.tsx`
- **HealthMetricsCard** — props: agent, latency, errorRate, connectionStatus — `server/src/components/health-metrics-card.tsx`
- **HealthMonitorPanel** — `server/src/components/health-monitor-panel.tsx`
- **LeaderboardSkeleton** — props: entries, statKey, statLabel, loading, nameKey — `server/src/components/leaderboard-table.tsx`
- **LogPane** — props: agents, defaultAgent — `server/src/components/log-pane.tsx`
- **LogStream** — props: agentName — `server/src/components/log-stream.tsx`
- **OutboundReviewPanel** — props: msg, onApprove, onReject, isPending — `server/src/components/outbound-review.tsx`
- **PromptViewer** — props: agentName — `server/src/components/prompt-viewer.tsx`
- **RateLimitPanel** — `server/src/components/rate-limit-panel.tsx`
- **ServerLogStream** — `server/src/components/server-log-stream.tsx`
- **ServerStatusWidget** — `server/src/components/server-status-widget.tsx`
- **ServiceWorkerRegistrar** — `server/src/components/service-worker-registrar.tsx`
- **ShipLoadout** — props: gameState — `server/src/components/ship-loadout.tsx`
- **StartupSplash** — `server/src/components/startup-splash.tsx`
- **SurvivabilityPanel** — props: agentName, currentSystem — `server/src/components/survivability-panel.tsx`
- **SystemView** — props: system, systemNames, agentPositions — `server/src/components/system-view.tsx`
- **ToolCallFeed** — props: agentName — `server/src/components/tool-call-feed.tsx`
- **TopBar** — `server/src/components/top-bar.tsx`

## Components

- **AgentDetailPage** — `server/src/app/agent/[name]/page.tsx`
- **RootLayout** — `server/src/app/layout.tsx`
- **OutboundReviewPage** — `server/src/app/outbound-review/page.tsx`
- **ShipImage** — props: shipClass, size, onClick, className, alt, lazy, rounded, onError, onLoad, chromaKey — `server/src/components/ShipImage.tsx`
- **ShipImageFallback** — props: shipClass, width, height, className, style — `server/src/components/ShipImageFallback.tsx`
- **StatusBadge** — props: state, size, subLabel — `server/src/components/status-badge.tsx`

---
_Back to [overview.md](./overview.md)_