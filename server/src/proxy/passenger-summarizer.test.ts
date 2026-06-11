/**
 * passenger-summarizer.test.ts
 *
 * Unit tests for the passenger-transport summarizers. Mirrors the style of
 * summarizers.test.ts — feed representative game JSON, assert the compact shape.
 */

import { describe, it, expect } from "bun:test";
import { PASSENGER_SUMMARIZERS } from "./passenger-summarizer.js";

describe("passenger summarizers", () => {
  describe("list_station_passengers", () => {
    const s = PASSENGER_SUMMARIZERS.list_station_passengers;

    it("renders name, class, destination station+system, fare, time remaining", () => {
      const raw = {
        station: "sol_central",
        system: "Sol",
        passengers: [
          {
            name: "Citizen Vale",
            class: "first",
            destination: "altair_hub",
            destination_system: "Altair",
            estimated_fare: 1200,
            time_remaining: 40,
            // noise the summarizer should drop:
            sprite: "npc_07",
            flavor_text: "A weary traveler",
          },
        ],
      };
      const out = s(raw) as Record<string, unknown>;
      expect(out.station).toBe("sol_central");
      expect(out.system).toBe("Sol");
      expect(out.count).toBe(1);
      const p = (out.passengers as Record<string, unknown>[])[0];
      expect(p.name).toBe("Citizen Vale");
      expect(p.class).toBe("first");
      expect(p.destination).toBe("altair_hub");
      expect(p.destination_system).toBe("Altair");
      expect(p.fare).toBe(1200);
      expect(p.time_remaining).toBe(40);
      // noise dropped
      expect(p).not.toHaveProperty("sprite");
      expect(p).not.toHaveProperty("flavor_text");
    });

    it("clamps to 30 passengers", () => {
      const passengers = Array.from({ length: 50 }, (_, i) => ({ name: `p${i}` }));
      const out = s({ passengers }) as Record<string, unknown>;
      expect((out.passengers as unknown[]).length).toBe(30);
      expect(out.count).toBe(30);
    });

    it("handles a bare array result", () => {
      const out = s([{ name: "Solo", destination: "x" }]) as Record<string, unknown>;
      expect(out.count).toBe(1);
      expect((out.passengers as Record<string, unknown>[])[0].name).toBe("Solo");
    });

    it("surfaces an empty-state message", () => {
      const out = s({ passengers: [], message: "No passengers waiting." }) as Record<string, unknown>;
      expect(out.count).toBe(0);
      expect(out.message).toBe("No passengers waiting.");
    });
  });

  describe("list_passengers (aboard)", () => {
    const s = PASSENGER_SUMMARIZERS.list_passengers;

    it("renders the fare breakdown (base + speed bonus) and time remaining", () => {
      const raw = {
        berths_free: 2,
        berths_total: 6,
        passengers: [
          {
            name: "Dr. Oren",
            class: "business",
            destination: "vega_port",
            destination_system: "Vega",
            fare: 1800,
            base_fare: 1200,
            speed_bonus: 600,
            time_remaining: 12,
          },
        ],
      };
      const out = s(raw) as Record<string, unknown>;
      expect(out.berths_free).toBe(2);
      expect(out.berths_total).toBe(6);
      const p = (out.passengers as Record<string, unknown>[])[0];
      expect(p.fare).toBe(1800);
      expect(p.base_fare).toBe(1200);
      expect(p.speed_bonus).toBe(600);
      expect(p.time_remaining).toBe(12);
    });
  });

  describe("load_passenger", () => {
    const s = PASSENGER_SUMMARIZERS.load_passenger;

    it("reports who boarded and free berths", () => {
      const raw = {
        destination: "altair_hub",
        berths_free: 3,
        loaded: [
          { name: "A", class: "economy", destination: "altair_hub", fare: 400 },
          { name: "B", class: "economy", destination: "altair_hub", fare: 420 },
        ],
        message: "2 passengers boarded.",
      };
      const out = s(raw) as Record<string, unknown>;
      expect(out.destination).toBe("altair_hub");
      expect(out.berths_free).toBe(3);
      expect(out.loaded_count).toBe(2);
      expect((out.loaded as unknown[]).length).toBe(2);
      expect(out.message).toBe("2 passengers boarded.");
    });
  });

  describe("unload_passenger", () => {
    const s = PASSENGER_SUMMARIZERS.unload_passenger;

    it("reports delivered vs stranded + fare earned", () => {
      const raw = {
        delivered: ["Dr. Oren"],
        stranded: [],
        fare_earned: 1800,
        standing_change: 2,
        message: "Delivered Dr. Oren (+1800cr).",
      };
      const out = s(raw) as Record<string, unknown>;
      expect(out.delivered).toEqual(["Dr. Oren"]);
      expect(out.fare_earned).toBe(1800);
      expect(out.standing_change).toBe(2);
    });

    it("falls back to the raw object when no known fields are present", () => {
      const raw = { ok: true, weird_field: 1 };
      const out = s(raw) as Record<string, unknown>;
      expect(out.ok).toBe(true);
      expect(out.weird_field).toBe(1);
    });
  });
});
