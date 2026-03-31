export type Severity = "info" | "warning" | "error" | "critical" | string;

export function getSeverityClasses(severity: Severity): string {
  switch (severity) {
    case "info":
      return "bg-blue-500/20 text-blue-400 border border-blue-500/30";
    case "warning":
      return "bg-amber-500/20 text-amber-400 border border-amber-500/30";
    case "error":
      return "bg-red-500/20 text-red-400 border border-red-500/30";
    case "critical":
      return "bg-red-600/30 text-red-300 border border-red-500/50 animate-pulse";
    default:
      return "bg-secondary text-muted-foreground border border-border";
  }
}

interface AlertItem {
  agent: string;
  severity: string;
  acknowledged: number;
  created_at: string;
}

export function sortAlerts<T extends AlertItem>(data: T[]): T[] {
  return [...data].sort((a, b) => {
    if (a.acknowledged !== b.acknowledged) return a.acknowledged - b.acknowledged;
    return b.created_at.localeCompare(a.created_at);
  });
}

export function filterAlerts<T extends AlertItem>(
  alerts: T[],
  agentFilter: string,
  severityFilter: string
): T[] {
  return alerts.filter((a) => {
    if (agentFilter !== "all" && a.agent !== agentFilter) return false;
    if (severityFilter !== "all" && a.severity !== severityFilter) return false;
    return true;
  });
}
