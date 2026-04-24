export function getPlayer(data: Record<string, unknown>): Record<string, unknown> {
  return objectAt(data, "player");
}

export function getShip(data: Record<string, unknown>): Record<string, unknown> {
  return objectAt(data, "ship");
}

export function getCargo(data: Record<string, unknown>): Array<Record<string, unknown>> {
  const ship = getShip(data);
  const cargo = ship.cargo;
  return Array.isArray(cargo) ? cargo.filter((item): item is Record<string, unknown> => !!item && typeof item === "object") : [];
}

export function cargoByItem(data: Record<string, unknown>): Map<string, number> {
  const result = new Map<string, number>();
  for (const item of getCargo(data)) {
    const id = String(item.item_id ?? item.id ?? "");
    if (!id) continue;
    const quantity = Number(item.quantity ?? item.qty ?? 0);
    result.set(id, (result.get(id) ?? 0) + (Number.isFinite(quantity) ? quantity : 0));
  }
  return result;
}

export function cargoQuantity(data: Record<string, unknown>, itemId: string): number {
  return cargoByItem(data).get(itemId) ?? 0;
}

export function cargoItemsForTool(data: Record<string, unknown>): Array<{ item_id: string; quantity: number }> {
  return [...cargoByItem(data)].filter(([, quantity]) => quantity > 0).map(([item_id, quantity]) => ({ item_id, quantity }));
}

export function cargoPct(data: Record<string, unknown>): number {
  const ship = getShip(data);
  const used = Number(ship.cargo_used ?? ship.cargoUsed ?? ship.cargo_volume ?? 0);
  const capacity = Number(ship.cargo_capacity ?? ship.cargoCapacity ?? ship.cargo_max ?? ship.cargoMax ?? 0);
  if (Number.isFinite(used) && Number.isFinite(capacity) && capacity > 0) {
    return Math.round((used / capacity) * 100);
  }
  const cargoTotal = [...cargoByItem(data).values()].reduce((sum, qty) => sum + qty, 0);
  return cargoTotal > 0 && Number.isFinite(capacity) && capacity > 0 ? Math.round((cargoTotal / capacity) * 100) : 0;
}

export function currentSystem(data: Record<string, unknown>): string | null {
  const player = getPlayer(data);
  return asString(player.current_system ?? player.system_id ?? player.location ?? data.current_system ?? data.system_id);
}

export function currentPoi(data: Record<string, unknown>): string | null {
  const player = getPlayer(data);
  return asString(player.current_poi ?? player.poi_id ?? player.docked_at ?? player.docked_at_base ?? data.current_poi);
}

export function homeDestination(data: Record<string, unknown>): string | null {
  const player = getPlayer(data);
  return asString(player.home_poi ?? player.home_system);
}

export function dockedFlag(data: Record<string, unknown>): boolean {
  const player = getPlayer(data);
  return Boolean(player.docked ?? player.docked_at ?? player.docked_at_base);
}

export function numberAt(data: Record<string, unknown>, path: string[]): number {
  let value: unknown = data;
  for (const key of path) {
    if (!value || typeof value !== "object") return 0;
    value = (value as Record<string, unknown>)[key];
  }
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function objectAt(data: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = data[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
