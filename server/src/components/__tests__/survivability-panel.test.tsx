import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import React from "react";
import { SurvivabilityPanel } from "../survivability-panel";
import { AuthContext } from "@/hooks/use-auth";
import type { AuthState } from "@/hooks/use-auth";

// ---------------------------------------------------------------------------
// Mocks — DO NOT mock.module @/hooks/use-auth or @/lib/api.
// mock.module persists per-process and poisons downstream tests.
// Instead: wrap component in AuthContext.Provider for auth, mock global.fetch
// for apiFetch (which delegates to fetch('/api' + path)).
// ---------------------------------------------------------------------------

mock.module("@/lib/utils", () => ({
  cn: (...classes: (string | undefined | false | null)[]) => classes.filter(Boolean).join(" "),
}));

// Auth state controlled per-test
let mockIsAdmin = false;

// apiFetch responses controlled per-test via global state
let mockResponses: Record<string, unknown> = {};

/** Wrap component with AuthContext.Provider */
function renderWithAuth(ui: React.ReactElement) {
  const authState: AuthState = {
    role: mockIsAdmin ? "admin" : "viewer",
    identity: mockIsAdmin ? "test-admin" : null,
    loading: false,
    isAdmin: mockIsAdmin,
  };
  return render(
    <AuthContext.Provider value={authState}>{ui}</AuthContext.Provider>,
  );
}

/** Set up global.fetch to serve mockResponses keyed by URL fragment */
function installFetchMock(extraHandler?: (path: string, options?: RequestInit) => unknown | undefined) {
  const originalFetch = global.fetch;
  global.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    // Check extra handler first (for POST overrides etc.)
    if (extraHandler) {
      const result = extraHandler(url, init);
      if (result !== undefined) {
        return { ok: true, status: 200, json: async () => result, text: async () => JSON.stringify(result) } as Response;
      }
    }
    for (const key of Object.keys(mockResponses)) {
      if (url.includes(key)) {
        const data = mockResponses[key];
        return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) } as Response;
      }
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
  return originalFetch;
}

let restoreFetch: typeof fetch;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const threatData = {
  system: "Kestrel-4",
  level: "high",
  score: 70,
  reasons: ["8 recorded pirate encounters"],
};

const policyData = {
  agent: "rust-vane",
  roleType: "trader",
  role: "Trader",
  autoCloakEnabled: true,
  override: null,
};

const modsData = {
  agent: "rust-vane",
  roleType: "trader",
  recommendations: [
    { mod_type: "shield_booster", priority: "high", reason: "Fragile hull" },
    { mod_type: "fuel_optimizer", priority: "medium", reason: "Long hauls" },
  ],
};

const cloakStatsData = {
  windowHours: 24,
  stats: [
    { agent: "rust-vane", cloakActivations: 3, threatsDetected: 5, threatsAvoided: 3 },
  ],
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockIsAdmin = false;
  mockResponses = {
    "/survivability/threat/": threatData,
    "/survivability/policy/": policyData,
    "/survivability/mods/": modsData,
    "/survivability/cloak-stats": cloakStatsData,
  };
  restoreFetch = installFetchMock();
});

afterEach(() => {
  global.fetch = restoreFetch;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SurvivabilityPanel", () => {
  it("renders threat level badge for the current system", async () => {
    renderWithAuth(<SurvivabilityPanel agentName="rust-vane" currentSystem="Kestrel-4" />);
    await waitFor(() => {
      // "high" appears in both threat badge and mod priority — confirm at least one exists
      expect(screen.getAllByText("high").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("displays threat score", async () => {
    renderWithAuth(<SurvivabilityPanel agentName="rust-vane" currentSystem="Kestrel-4" />);
    await waitFor(() => {
      expect(screen.getByText(/70\/100/)).toBeInTheDocument();
    });
  });

  it("shows 'Agent location unknown' when currentSystem is null", () => {
    renderWithAuth(<SurvivabilityPanel agentName="rust-vane" currentSystem={null} />);
    expect(screen.getByText(/Agent location unknown/i)).toBeInTheDocument();
  });

  it("renders cloak policy role and status", async () => {
    renderWithAuth(<SurvivabilityPanel agentName="rust-vane" currentSystem="Kestrel-4" />);
    await waitFor(() => {
      expect(screen.getByText("trader")).toBeInTheDocument();
      expect(screen.getByText("Auto (role-based)")).toBeInTheDocument();
    });
  });

  it("renders mod recommendations", async () => {
    renderWithAuth(<SurvivabilityPanel agentName="rust-vane" currentSystem="Kestrel-4" />);
    await waitFor(() => {
      expect(screen.getByText("shield booster")).toBeInTheDocument();
      expect(screen.getByText("fuel optimizer")).toBeInTheDocument();
    });
  });

  it("renders cloak activation stats", async () => {
    renderWithAuth(<SurvivabilityPanel agentName="rust-vane" currentSystem="Kestrel-4" />);
    await waitFor(() => {
      // cloakActivations = 3, threatsDetected = 5, threatsAvoided = 3
      expect(screen.getByText("Activations")).toBeInTheDocument();
      expect(screen.getByText("Threats Detected")).toBeInTheDocument();
      expect(screen.getByText("Threats Avoided")).toBeInTheDocument();
    });
  });

  it("does not render admin toggle buttons for viewer", async () => {
    mockIsAdmin = false;
    renderWithAuth(<SurvivabilityPanel agentName="rust-vane" currentSystem="Kestrel-4" />);
    await waitFor(() => {
      expect(screen.queryByText("Force Enable")).toBeNull();
      expect(screen.queryByText("Force Disable")).toBeNull();
    });
  });

  it("renders admin toggle buttons for admin users", async () => {
    mockIsAdmin = true;
    renderWithAuth(<SurvivabilityPanel agentName="rust-vane" currentSystem="Kestrel-4" />);
    await waitFor(() => {
      expect(screen.getByText("Force Enable")).toBeInTheDocument();
      expect(screen.getByText("Force Disable")).toBeInTheDocument();
      expect(screen.getByText("Clear Override")).toBeInTheDocument();
    });
  });

  it("shows 'No cloak activity recorded' when agent not in stats", async () => {
    mockResponses = {
      ...mockResponses,
      "/survivability/cloak-stats": {
        windowHours: 24,
        stats: [{ agent: "other-agent", cloakActivations: 1, threatsDetected: 1, threatsAvoided: 1 }],
      },
    };
    renderWithAuth(<SurvivabilityPanel agentName="rust-vane" currentSystem="Kestrel-4" />);
    await waitFor(() => {
      expect(screen.getByText("No cloak activity recorded.")).toBeInTheDocument();
    });
  });

  it("shows force-enabled state when override is true", async () => {
    mockResponses = {
      ...mockResponses,
      "/survivability/policy/": { ...policyData, override: true },
    };
    renderWithAuth(<SurvivabilityPanel agentName="rust-vane" currentSystem="Kestrel-4" />);
    await waitFor(() => {
      expect(screen.getByText("Force-enabled")).toBeInTheDocument();
    });
  });

  it("calls cloak-policy POST when admin clicks Force Disable", async () => {
    mockIsAdmin = true;
    let postCalled = false;
    // Reinstall fetch mock with POST handler for this test
    global.fetch = restoreFetch;
    restoreFetch = installFetchMock((url, init) => {
      if (init?.method === "POST" && url.includes("cloak-policy")) {
        postCalled = true;
        return { ok: true };
      }
      return undefined;
    });

    renderWithAuth(<SurvivabilityPanel agentName="rust-vane" currentSystem="Kestrel-4" />);
    await waitFor(() => {
      expect(screen.getByText("Force Disable")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Force Disable"));
    await waitFor(() => {
      expect(postCalled).toBe(true);
    });
  });
});
