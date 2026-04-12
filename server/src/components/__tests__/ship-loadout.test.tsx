import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import { ShipLoadout } from '../ship-loadout';
import { createMockGameState, createMockShip } from '@/test/mocks/game-state';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Stub ShipImage to avoid CDN/image loading
mock.module('../ShipImage', () => ({
  ShipImage: ({
    shipClass,
    alt,
    onClick,
  }: {
    shipClass: string;
    alt?: string;
    onClick?: () => void;
  }) => (
    <img
      data-testid="ship-image"
      data-ship-class={shipClass}
      alt={alt}
      onClick={onClick}
    />
  ),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ShipLoadout', () => {
  // ---------------------------------------------------------------------------
  // Null/empty state
  // ---------------------------------------------------------------------------

  it('shows empty state when gameState is null', () => {
    render(<ShipLoadout gameState={null} />);
    expect(screen.getByText('No ship data available.')).toBeInTheDocument();
  });

  it('shows empty state when gameState has no ship', () => {
    const gameState = createMockGameState({ ship: null });
    render(<ShipLoadout gameState={gameState} />);
    expect(screen.getByText('No ship data available.')).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Ship header
  // ---------------------------------------------------------------------------

  it('displays ship name', () => {
    const gameState = createMockGameState({
      ship: createMockShip({ name: 'Stormhawk I' }),
    });
    render(<ShipLoadout gameState={gameState} />);
    expect(screen.getByText('Stormhawk I')).toBeInTheDocument();
  });

  it('displays ship class', () => {
    const gameState = createMockGameState({
      ship: createMockShip({ class: 'starter_mining' }),
    });
    render(<ShipLoadout gameState={gameState} />);
    expect(screen.getByText('starter_mining')).toBeInTheDocument();
  });

  it('renders ship images', () => {
    const gameState = createMockGameState({
      ship: createMockShip({ class: 'mining_barge' }),
    });
    render(<ShipLoadout gameState={gameState} />);
    const images = screen.getAllByTestId('ship-image');
    // Two images: mobile thumbnail + desktop large
    expect(images.length).toBeGreaterThanOrEqual(1);
    expect(images[0]).toHaveAttribute('data-ship-class', 'mining_barge');
  });

  // ---------------------------------------------------------------------------
  // Ship vitals panel
  // ---------------------------------------------------------------------------

  it('displays ship vitals panel with hull/shield/fuel/cargo bars', () => {
    render(<ShipLoadout gameState={createMockGameState()} />);
    expect(screen.getByText('Ship Vitals')).toBeInTheDocument();
    expect(screen.getByText('Hull')).toBeInTheDocument();
    expect(screen.getByText('Shield')).toBeInTheDocument();
    expect(screen.getByText('Fuel')).toBeInTheDocument();
    expect(screen.getByText('Cargo')).toBeInTheDocument();
  });

  it('shows health bar values from ship data', () => {
    const gameState = createMockGameState({
      ship: createMockShip({ hull: 75, max_hull: 100 }),
    });
    render(<ShipLoadout gameState={gameState} />);
    expect(screen.getByText('75/100')).toBeInTheDocument();
  });

  it('shows cargo hold full warning when cargo is full', () => {
    const gameState = createMockGameState({
      ship: createMockShip({ cargo_used: 50, cargo_capacity: 50 }),
    });
    render(<ShipLoadout gameState={gameState} />);
    expect(screen.getByText(/Cargo hold full/i)).toBeInTheDocument();
  });

  it('does not show cargo full warning when cargo is not full', () => {
    const gameState = createMockGameState({
      ship: createMockShip({ cargo_used: 20, cargo_capacity: 50 }),
    });
    render(<ShipLoadout gameState={gameState} />);
    expect(screen.queryByText(/Cargo hold full/i)).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Module slots panel
  // ---------------------------------------------------------------------------

  it('shows module slots panel', () => {
    render(<ShipLoadout gameState={createMockGameState()} />);
    expect(screen.getByText('Module Slots')).toBeInTheDocument();
  });

  it('displays weapon modules by name', () => {
    const gameState = createMockGameState({
      ship: createMockShip({
        modules: [
          { slot_type: 'weapon', item_id: 'blaster_mk2', item_name: 'Blaster Mk II' },
        ],
      }),
    });
    render(<ShipLoadout gameState={gameState} />);
    expect(screen.getByText('Blaster Mk II')).toBeInTheDocument();
  });

  it('shows modules with undefined slot_type in Unknown category', () => {
    const gameState = createMockGameState({
      ship: createMockShip({
        modules: [
          { slot_type: undefined, item_id: 'ab4007e5f47f61bc4a1fe05646f10528', item_name: 'Mining Laser I' },
        ],
      }),
    });
    render(<ShipLoadout gameState={gameState} />);
    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.getByText('Mining Laser I')).toBeInTheDocument();
  });

  it('does not show Unknown category when all modules have recognized slot types', () => {
    const gameState = createMockGameState({
      ship: createMockShip({
        modules: [
          { slot_type: 'weapon', item_id: 'gun_1', item_name: 'Blaster I' },
        ],
      }),
    });
    render(<ShipLoadout gameState={gameState} />);
    expect(screen.queryByText('Unknown')).not.toBeInTheDocument();
  });

  it('shows empty state for module categories with no modules', () => {
    const gameState = createMockGameState({
      ship: createMockShip({ modules: [] }),
    });
    render(<ShipLoadout gameState={gameState} />);
    expect(screen.getByText('No module data available')).toBeInTheDocument();
  });

  it('hides item_id from display when item_name is present', () => {
    const gameState = createMockGameState({
      ship: createMockShip({
        modules: [
          { slot_type: 'weapon', item_id: 'blaster_mk1', item_name: 'Blaster Mk I' },
        ],
      }),
    });
    render(<ShipLoadout gameState={gameState} />);
    expect(screen.getByText('Blaster Mk I')).toBeInTheDocument();
    expect(screen.queryByText('(blaster_mk1)')).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Cargo manifest panel
  // ---------------------------------------------------------------------------

  it('shows cargo manifest panel', () => {
    render(<ShipLoadout gameState={createMockGameState()} />);
    expect(screen.getByText('Cargo Manifest')).toBeInTheDocument();
  });

  it('displays cargo items with name and quantity', () => {
    const gameState = createMockGameState({
      ship: createMockShip({
        cargo: [
          { item_id: 'iron_ore', name: 'Iron Ore', quantity: 15 },
        ],
      }),
    });
    render(<ShipLoadout gameState={gameState} />);
    expect(screen.getByText('Iron Ore')).toBeInTheDocument();
    expect(screen.getByText('x15')).toBeInTheDocument();
  });

  it('shows cargo free space', () => {
    const gameState = createMockGameState({
      ship: createMockShip({ cargo_used: 20, cargo_capacity: 50 }),
    });
    render(<ShipLoadout gameState={gameState} />);
    expect(screen.getByText('30 free')).toBeInTheDocument();
  });

  it('shows used/capacity summary', () => {
    const gameState = createMockGameState({
      ship: createMockShip({ cargo_used: 20, cargo_capacity: 50 }),
    });
    render(<ShipLoadout gameState={gameState} />);
    expect(screen.getByText('20 / 50 units used')).toBeInTheDocument();
  });

  it('shows empty cargo hold message when no cargo', () => {
    const gameState = createMockGameState({
      ship: createMockShip({ cargo: [] }),
    });
    render(<ShipLoadout gameState={gameState} />);
    expect(screen.getByText('Cargo hold is empty')).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Skills panel
  // ---------------------------------------------------------------------------

  it('shows skills panel', () => {
    render(<ShipLoadout gameState={createMockGameState()} />);
    expect(screen.getByText('Skills')).toBeInTheDocument();
  });

  it('displays skill name and level', () => {
    const gameState = createMockGameState({
      skills: { mining: { name: 'Mining', level: 3, xp: 750, xp_to_next: 1000 } },
    });
    render(<ShipLoadout gameState={gameState} />);
    expect(screen.getByText('Mining')).toBeInTheDocument();
    expect(screen.getByText('Lvl 3')).toBeInTheDocument();
  });

  it('displays XP progress for a skill', () => {
    const gameState = createMockGameState({
      skills: { mining: { name: 'Mining', level: 3, xp: 750, xp_to_next: 1000 } },
    });
    render(<ShipLoadout gameState={gameState} />);
    expect(screen.getByText('750 / 1000 XP')).toBeInTheDocument();
  });

  it('shows "No skills unlocked" when skills are empty', () => {
    const gameState = createMockGameState({ skills: {} });
    render(<ShipLoadout gameState={gameState} />);
    expect(screen.getByText('No skills unlocked')).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Lightbox
  // ---------------------------------------------------------------------------

  it('opens lightbox when ship image is clicked', () => {
    const gameState = createMockGameState({
      ship: createMockShip({ class: 'starter_mining', name: 'Test Ship' }),
    });
    render(<ShipLoadout gameState={gameState} />);
    const openBtns = screen.getAllByTestId('open-lightbox');
    fireEvent.click(openBtns[0]);

    // Lightbox should appear with Close button
    expect(screen.getByRole('button', { name: /Close lightbox/i })).toBeInTheDocument();
  });

  it('closes lightbox when close button is clicked', () => {
    const gameState = createMockGameState({
      ship: createMockShip({ class: 'starter_mining', name: 'Test Ship' }),
    });
    render(<ShipLoadout gameState={gameState} />);
    const openBtns = screen.getAllByTestId('open-lightbox');
    fireEvent.click(openBtns[0]);

    const closeBtn = screen.getByRole('button', { name: /Close lightbox/i });
    fireEvent.click(closeBtn);
    expect(screen.queryByRole('button', { name: /Close lightbox/i })).not.toBeInTheDocument();
  });
});

  // ---------------------------------------------------------------------------
  // Module UUID formatting
  // ---------------------------------------------------------------------------

  it('formats raw 32-char hex UUID module hashes as "Module (xxxx…)"', () => {
    const gameState = createMockGameState({
      ship: createMockShip({
        modules: [
          { slot_type: 'weapon', item_id: '1aa16e807736f14db436567c737255a6', item_name: '1aa16e807736f14db436567c737255a6' },
        ],
      }),
    });
    render(<ShipLoadout gameState={gameState} />);
    expect(screen.getByText('Module (1aa1…)')).toBeInTheDocument();
    expect(screen.queryByText('1aa16e807736f14db436567c737255a6')).not.toBeInTheDocument();
  });

  it('formats module with numeric item_id as hex UUID when item_name is also hex', () => {
    const gameState = createMockGameState({
      ship: createMockShip({
        modules: [
          { slot_type: 'defense', item_id: 'ab4007e5f47f61bc4a1fe05646f10528', item_name: 'ab4007e5f47f61bc4a1fe05646f10528' },
        ],
      }),
    });
    render(<ShipLoadout gameState={gameState} />);
    expect(screen.getByText('Module (ab40…)')).toBeInTheDocument();
  });
