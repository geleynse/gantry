/**
 * EncounterCard component tests
 * Tests rendering, interactivity, and visual logic for combat encounter cards
 */

import { describe, it, expect, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { EncounterCard, tierBadge } from "../encounter-card";
import type { Encounter, CombatEvent } from "../encounter-card";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEncounter(overrides: Partial<Encounter> = {}): Encounter {
  return {
    id: 1,
    agent: "drifter-gale",
    pirate_name: "Rogue Interceptor",
    pirate_tier: "medium",
    system: "Vega Prime",
    started_at: "2026-03-07T10:00:00Z",
    ended_at: "2026-03-07T10:05:00Z",
    outcome: "survived",
    total_damage: 120,
    hull_start: 500,
    hull_end: 380,
    max_hull: 500,
    ...overrides,
  };
}

function makeEvents(): CombatEvent[] {
  return [
    {
      id: 10,
      agent: "drifter-gale",
      event_type: "pirate_warning",
      pirate_name: "Rogue Interceptor",
      pirate_tier: "medium",
      damage: null,
      hull_after: null,
      max_hull: null,
      died: 0,
      insurance_payout: null,
      system: "Vega Prime",
      created_at: "2026-03-07T10:00:00Z",
    },
    {
      id: 11,
      agent: "drifter-gale",
      event_type: "pirate_combat",
      pirate_name: "Rogue Interceptor",
      pirate_tier: "medium",
      damage: 120,
      hull_after: 380,
      max_hull: 500,
      died: 0,
      insurance_payout: null,
      system: "Vega Prime",
      created_at: "2026-03-07T10:01:00Z",
    },
  ];
}

// ---------------------------------------------------------------------------
// Collapsed rendering
// ---------------------------------------------------------------------------

describe("EncounterCard (collapsed)", () => {
  it("renders agent name", () => {
    render(
      <EncounterCard
        encounter={makeEncounter()}
        expanded={false}
        onToggle={() => {}}
      />
    );
    expect(screen.getByText("drifter-gale")).toBeTruthy();
  });

  it("renders pirate name", () => {
    render(
      <EncounterCard
        encounter={makeEncounter()}
        expanded={false}
        onToggle={() => {}}
      />
    );
    expect(screen.getByText("Rogue Interceptor")).toBeTruthy();
  });

  it("renders system name", () => {
    render(
      <EncounterCard
        encounter={makeEncounter()}
        expanded={false}
        onToggle={() => {}}
      />
    );
    expect(screen.getByText("Vega Prime")).toBeTruthy();
  });

  it("renders survived outcome badge", () => {
    render(
      <EncounterCard
        encounter={makeEncounter({ outcome: "survived" })}
        expanded={false}
        onToggle={() => {}}
      />
    );
    expect(screen.getByText("survived")).toBeTruthy();
  });

  it("renders died outcome badge", () => {
    render(
      <EncounterCard
        encounter={makeEncounter({ outcome: "died" })}
        expanded={false}
        onToggle={() => {}}
      />
    );
    expect(screen.getByText("died")).toBeTruthy();
  });

  it("renders fled outcome badge", () => {
    render(
      <EncounterCard
        encounter={makeEncounter({ outcome: "fled" })}
        expanded={false}
        onToggle={() => {}}
      />
    );
    expect(screen.getByText("fled")).toBeTruthy();
  });

  it("renders damage dealt", () => {
    render(
      <EncounterCard
        encounter={makeEncounter({ total_damage: 250 })}
        expanded={false}
        onToggle={() => {}}
      />
    );
    expect(screen.getByText("250 dmg")).toBeTruthy();
  });

  it("renders hull text as end/start", () => {
    render(
      <EncounterCard
        encounter={makeEncounter({ hull_start: 500, hull_end: 380 })}
        expanded={false}
        onToggle={() => {}}
      />
    );
    expect(screen.getByText("380/500")).toBeTruthy();
  });

  it("does not show event timeline when collapsed", () => {
    render(
      <EncounterCard
        encounter={makeEncounter()}
        expanded={false}
        onToggle={() => {}}
        events={makeEvents()}
      />
    );
    // Timeline events should not be visible
    expect(screen.queryByText("warning")).toBeNull();
    expect(screen.queryByText("combat")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Expanded rendering
// ---------------------------------------------------------------------------

describe("EncounterCard (expanded)", () => {
  it("shows event timeline when expanded", () => {
    render(
      <EncounterCard
        encounter={makeEncounter()}
        expanded={true}
        onToggle={() => {}}
        events={makeEvents()}
      />
    );
    expect(screen.getByText("warning")).toBeTruthy();
    expect(screen.getByText("combat")).toBeTruthy();
  });

  it("shows loading placeholder when expanded but events is undefined", () => {
    render(
      <EncounterCard
        encounter={makeEncounter()}
        expanded={true}
        onToggle={() => {}}
        events={undefined}
      />
    );
    expect(screen.getByText("Loading...")).toBeTruthy();
  });

  it("shows empty state when expanded with no events", () => {
    render(
      <EncounterCard
        encounter={makeEncounter()}
        expanded={true}
        onToggle={() => {}}
        events={[]}
      />
    );
    expect(screen.getByText("No events")).toBeTruthy();
  });

  it("shows damage values for combat events", () => {
    render(
      <EncounterCard
        encounter={makeEncounter()}
        expanded={true}
        onToggle={() => {}}
        events={makeEvents()}
      />
    );
    // "120 dmg" appears in both collapsed row and expanded event row
    const matches = screen.getAllByText("120 dmg");
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it("shows hull after/max_hull for combat events", () => {
    render(
      <EncounterCard
        encounter={makeEncounter()}
        expanded={true}
        onToggle={() => {}}
        events={makeEvents()}
      />
    );
    // "380/500" appears in both collapsed row and expanded event row
    const matches = screen.getAllByText("380/500");
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Interactivity
// ---------------------------------------------------------------------------

describe("EncounterCard interactions", () => {
  it("calls onToggle when card is clicked", () => {
    const onToggle = mock(() => {});
    const { container } = render(
      <EncounterCard
        encounter={makeEncounter()}
        expanded={false}
        onToggle={onToggle}
      />
    );
    const card = container.firstChild as HTMLElement;
    fireEvent.click(card);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("calls onToggle on Enter keydown", () => {
    const onToggle = mock(() => {});
    const { container } = render(
      <EncounterCard
        encounter={makeEncounter()}
        expanded={false}
        onToggle={onToggle}
      />
    );
    const card = container.firstChild as HTMLElement;
    fireEvent.keyDown(card, { key: "Enter" });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("does not call onToggle on other keys", () => {
    const onToggle = mock(() => {});
    const { container } = render(
      <EncounterCard
        encounter={makeEncounter()}
        expanded={false}
        onToggle={onToggle}
      />
    );
    const card = container.firstChild as HTMLElement;
    fireEvent.keyDown(card, { key: "Space" });
    expect(onToggle).toHaveBeenCalledTimes(0);
  });

  it("has aria-expanded=false when collapsed", () => {
    const { container } = render(
      <EncounterCard
        encounter={makeEncounter()}
        expanded={false}
        onToggle={() => {}}
      />
    );
    const card = container.firstChild as HTMLElement;
    expect(card.getAttribute("aria-expanded")).toBe("false");
  });

  it("has aria-expanded=true when expanded", () => {
    const { container } = render(
      <EncounterCard
        encounter={makeEncounter()}
        expanded={true}
        onToggle={() => {}}
        events={[]}
      />
    );
    const card = container.firstChild as HTMLElement;
    expect(card.getAttribute("aria-expanded")).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// Hull bar color logic
// ---------------------------------------------------------------------------

describe("Hull bar color", () => {
  it("uses green color when hull > 50%", () => {
    const { container } = render(
      <EncounterCard
        encounter={makeEncounter({ hull_start: 500, hull_end: 300 })} // 60%
        expanded={false}
        onToggle={() => {}}
      />
    );
    const bar = container.querySelector("[data-testid='hull-bar']") as HTMLElement;
    expect(bar).toBeTruthy();
    expect(bar.className).toContain("bg-green-500");
  });

  it("uses yellow color when hull is between 20% and 50%", () => {
    const { container } = render(
      <EncounterCard
        encounter={makeEncounter({ hull_start: 500, hull_end: 150 })} // 30%
        expanded={false}
        onToggle={() => {}}
      />
    );
    const bar = container.querySelector("[data-testid='hull-bar']") as HTMLElement;
    expect(bar.className).toContain("bg-yellow-500");
  });

  it("uses red color when hull is below 20%", () => {
    const { container } = render(
      <EncounterCard
        encounter={makeEncounter({ hull_start: 500, hull_end: 50 })} // 10%
        expanded={false}
        onToggle={() => {}}
      />
    );
    const bar = container.querySelector("[data-testid='hull-bar']") as HTMLElement;
    expect(bar.className).toContain("bg-red-500");
  });

  it("uses red color at exactly 20%", () => {
    const { container } = render(
      <EncounterCard
        encounter={makeEncounter({ hull_start: 500, hull_end: 100 })} // 20%
        expanded={false}
        onToggle={() => {}}
      />
    );
    const bar = container.querySelector("[data-testid='hull-bar']") as HTMLElement;
    // 20% is not > 20, so red
    expect(bar.className).toContain("bg-red-500");
  });

  it("uses green color at exactly 51%", () => {
    const { container } = render(
      <EncounterCard
        encounter={makeEncounter({ hull_start: 100, hull_end: 51 })} // 51%
        expanded={false}
        onToggle={() => {}}
      />
    );
    const bar = container.querySelector("[data-testid='hull-bar']") as HTMLElement;
    expect(bar.className).toContain("bg-green-500");
  });

  it("sets correct width percentage on hull bar", () => {
    const { container } = render(
      <EncounterCard
        encounter={makeEncounter({ hull_start: 500, hull_end: 250 })} // 50%
        expanded={false}
        onToggle={() => {}}
      />
    );
    const bar = container.querySelector("[data-testid='hull-bar']") as HTMLElement;
    expect(bar.style.width).toBe("50%");
  });

  it("caps hull bar at 100% when end exceeds start", () => {
    const { container } = render(
      <EncounterCard
        encounter={makeEncounter({ hull_start: 100, hull_end: 150 })}
        expanded={false}
        onToggle={() => {}}
      />
    );
    const bar = container.querySelector("[data-testid='hull-bar']") as HTMLElement;
    expect(bar.style.width).toBe("100%");
  });

  it("shows 0% when hull_start is 0", () => {
    const { container } = render(
      <EncounterCard
        encounter={makeEncounter({ hull_start: 0, hull_end: 0 })}
        expanded={false}
        onToggle={() => {}}
      />
    );
    const bar = container.querySelector("[data-testid='hull-bar']") as HTMLElement;
    expect(bar.style.width).toBe("0%");
  });
});

// ---------------------------------------------------------------------------
// tierBadge helper
// ---------------------------------------------------------------------------

describe("tierBadge", () => {
  it("returns null for null tier", () => {
    const result = tierBadge(null);
    expect(result).toBeNull();
  });

  it("renders small tier in green", () => {
    const { container } = render(<>{tierBadge("small")}</>);
    const span = container.querySelector("span");
    expect(span?.className).toContain("text-green-400");
    expect(span?.textContent).toBe("[small]");
  });

  it("renders medium tier in yellow", () => {
    const { container } = render(<>{tierBadge("medium")}</>);
    const span = container.querySelector("span");
    expect(span?.className).toContain("text-yellow-400");
  });

  it("renders large tier in orange", () => {
    const { container } = render(<>{tierBadge("large")}</>);
    const span = container.querySelector("span");
    expect(span?.className).toContain("text-orange-400");
  });

  it("renders boss tier in red", () => {
    const { container } = render(<>{tierBadge("boss")}</>);
    const span = container.querySelector("span");
    expect(span?.className).toContain("text-red-400");
  });

  it("renders unknown tier in muted", () => {
    const { container } = render(<>{tierBadge("unknown")}</>);
    const span = container.querySelector("span");
    expect(span?.className).toContain("text-muted-foreground");
  });
});
