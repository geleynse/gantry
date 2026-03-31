// Storage caps from common-rules.txt
// Lockbox 100k, Warehouse 200k, Depot 300k, Stronghold 500k
export const FACTION_STORAGE_CAPS: Record<string, number> = {
  "Lockbox": 100000,
  "Warehouse": 200000,
  "Depot": 300000,
  "Stronghold": 500000,
};

// Threshold for alerting (e.g., 90% full)
const ALERT_THRESHOLD = 0.9;

export interface StorageAlert {
  item_id?: string;
  used: number;
  capacity: number;
  percent: number;
  message: string;
}

/**
 * FactionMonitor — Logic for monitoring faction-specific limits and status.
 */
export function checkStorageLimits(used: number, capacity: number): StorageAlert | null {
  if (capacity <= 0) return null;
  
  const percent = used / capacity;
  if (percent >= ALERT_THRESHOLD) {
    const remaining = capacity - used;
    return {
      used,
      capacity,
      percent,
      message: `Faction storage is ${Math.round(percent * 100)}% full (${remaining.toLocaleString()} units remaining). Sell or withdraw items to avoid blocking deposits.`
    };
  }
  
  return null;
}

/**
 * Get capacity based on faction tier name.
 */
export function getCapacityForTier(tierName: string): number {
  return FACTION_STORAGE_CAPS[tierName] || 100000; // Default to lowest tier
}
