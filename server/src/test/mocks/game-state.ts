// Local type definitions (mirrors src/hooks/use-game-state.ts)
// Defined inline to avoid importing React frontend hooks into server test context
export interface ShipModule {
  slot_type?: string;
  item_id?: string;
  item_name?: string;
}
export interface CargoItem {
  item_id?: string;
  name?: string;
  quantity?: number;
}
export interface SkillData {
  name?: string;
  level?: number;
  xp?: number;
  xp_to_next?: number;
}
export interface AgentShip {
  name: string;
  class: string;
  hull: number;
  max_hull: number;
  shield: number;
  max_shield: number;
  fuel: number;
  max_fuel: number;
  cargo_used: number;
  cargo_capacity: number;
  modules: ShipModule[];
  cargo: CargoItem[];
}
export interface AgentGameState {
  credits: number;
  current_system: string | null;
  current_poi: string | null;
  docked_at_base: string | null;
  ship: AgentShip | null;
  faction?: {
    tag?: string;
    storage_used?: number;
    storage_capacity?: number;
  };
  home_system?: string | null;
  home_poi?: string | null;
  skills: Record<string, SkillData>;
  data_age_s?: number;
  last_seen?: string;
}

export function createMockShipModule(overrides: Partial<ShipModule> = {}): ShipModule {
  return {
    slot_type: 'weapon',
    item_id: 'blaster_mk1',
    item_name: 'Blaster Mk I',
    ...overrides,
  };
}

export function createMockCargoItem(overrides: Partial<CargoItem> = {}): CargoItem {
  return {
    item_id: 'iron_ore',
    name: 'Iron Ore',
    quantity: 10,
    ...overrides,
  };
}

export function createMockShip(overrides: Partial<AgentShip> = {}): AgentShip {
  return {
    name: 'Stormhawk I',
    class: 'starter_mining',
    hull: 80,
    max_hull: 100,
    shield: 60,
    max_shield: 80,
    fuel: 50,
    max_fuel: 100,
    cargo_used: 20,
    cargo_capacity: 50,
    modules: [
      createMockShipModule(),
      createMockShipModule({ slot_type: 'defense', item_id: 'shield_gen', item_name: 'Shield Generator' }),
    ],
    cargo: [
      createMockCargoItem(),
      createMockCargoItem({ item_id: 'copper_ore', name: 'Copper Ore', quantity: 5 }),
    ],
    ...overrides,
  };
}

export function createMockGameState(overrides: Partial<AgentGameState> = {}): AgentGameState {
  return {
    credits: 12345,
    current_system: 'Solaria Prime',
    current_poi: 'Mining Belt Alpha',
    docked_at_base: null,
    ship: createMockShip(),
    skills: {
      mining: { name: 'Mining', level: 3, xp: 750, xp_to_next: 1000 },
      combat: { name: 'Combat', level: 1, xp: 100, xp_to_next: 500 },
    },
    ...overrides,
  };
}

export function createMockFleetGameState(
  agents: string[] = ['drifter-gale', 'sable-thorn'],
): Record<string, AgentGameState> {
  const result: Record<string, AgentGameState> = {};
  for (const name of agents) {
    result[name] = createMockGameState();
  }
  return result;
}
