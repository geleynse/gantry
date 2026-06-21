import { describe, it, expect } from "bun:test";
import { detectBreakingChangelog, checkChangelogForBreaking } from "./changelog-watch.js";

describe("detectBreakingChangelog", () => {
  it("extracts the version from a 'Latest release:' line", () => {
    const scan = detectBreakingChangelog("Welcome back!\nLatest release: v0.417.2\n  - some note");
    expect(scan.version).toBe("0.417.2");
  });

  it("flags a note that removes/rejects a parameter (breaking)", () => {
    const text = [
      "Welcome back, Drifter! Session ID: abc123",
      "Latest release: v0.420.0",
      "  - The login endpoint now rejects any session_id parameter.",
      "  - Minor UI tweaks to the market screen.",
    ].join("\n");
    const scan = detectBreakingChangelog(text);
    expect(scan.version).toBe("0.420.0");
    expect(scan.breakingLines.length).toBe(1);
    expect(scan.breakingLines[0].toLowerCase()).toContain("rejects");
  });

  it("flags 'no longer' / 'deprecated' / 'now requires' phrasing", () => {
    const text = [
      "Latest release: v0.421.0",
      "  - get_recipes is deprecated; use catalog(type=recipes).",
      "  - jump now requires target_system instead of system_id.",
      "  - Stations no longer accept legacy dock payloads.",
    ].join("\n");
    const scan = detectBreakingChangelog(text);
    expect(scan.breakingLines.length).toBe(3);
  });

  it("returns no breaking lines for a purely additive changelog", () => {
    const text = [
      "Latest release: v0.417.4",
      "  - Stations short on power now post what they need faster.",
      "  - Added a new tanker hull.",
    ].join("\n");
    const scan = detectBreakingChangelog(text);
    expect(scan.breakingLines).toEqual([]);
  });

  it("strips bullet markers from the reported line", () => {
    const scan = detectBreakingChangelog("Latest release: v1.0.0\n  - install_mod removed the slot_idx parameter.");
    expect(scan.breakingLines[0].startsWith("-")).toBe(false);
  });

  it("handles empty / missing text without throwing", () => {
    expect(detectBreakingChangelog("").breakingLines).toEqual([]);
    expect(detectBreakingChangelog("" as unknown as string).version).toBeNull();
  });
});

describe("checkChangelogForBreaking (alert wiring)", () => {
  function makeDeps() {
    const alerts: Array<{ agent: string; severity: string; category: string | null; message: string }> = [];
    const recent = new Set<string>();
    return {
      alerts,
      recent,
      createAlert: (agent: string, severity: string, category: string | null, message: string) => {
        alerts.push({ agent, severity, category, message });
        if (category) recent.add(category);
        return alerts.length;
      },
      hasRecentAlert: (_agent: string, category: string) => recent.has(category),
    };
  }

  it("files one alert when breaking notes are present", () => {
    const deps = makeDeps();
    const text = "Latest release: v0.420.0\n  - login now rejects session_id.";
    checkChangelogForBreaking(text, deps);
    expect(deps.alerts.length).toBe(1);
    expect(deps.alerts[0].message).toContain("0.420.0");
    expect(deps.alerts[0].message.toLowerCase()).toContain("rejects");
  });

  it("dedups per version — a second call for the same version does not re-alert", () => {
    const deps = makeDeps();
    const text = "Latest release: v0.420.0\n  - login now rejects session_id.";
    checkChangelogForBreaking(text, deps);
    checkChangelogForBreaking(text, deps);
    expect(deps.alerts.length).toBe(1);
  });

  it("does not alert for an additive changelog", () => {
    const deps = makeDeps();
    checkChangelogForBreaking("Latest release: v0.417.4\n  - Added a hull.", deps);
    expect(deps.alerts.length).toBe(0);
  });
});
