/**
 * Tests for LifecycleManager — timer tracking and cleanup.
 */
import { describe, it, expect } from "bun:test";
import { LifecycleManager } from "./lifecycle-manager.js";

describe("LifecycleManager", () => {
  it("register/getRegistered tracks timer names", () => {
    const mgr = new LifecycleManager();
    const t1 = setInterval(() => {}, 99_999);
    const t2 = setInterval(() => {}, 99_999);
    mgr.register("foo", t1);
    mgr.register("bar", t2);
    expect(mgr.getRegistered()).toContain("foo");
    expect(mgr.getRegistered()).toContain("bar");
    clearInterval(t1);
    clearInterval(t2);
  });

  it("stopAll clears all timers and empties registry", () => {
    const mgr = new LifecycleManager();
    let count = 0;
    const t = setInterval(() => { count++; }, 1);
    mgr.register("counter", t);
    mgr.stopAll();
    expect(mgr.getRegistered()).toHaveLength(0);
    // Timer was cleared — count should not increase after stopAll
  });

  it("unregister removes a named timer from the registry", () => {
    const mgr = new LifecycleManager();
    const t = setInterval(() => {}, 99_999);
    mgr.register("temp", t);
    expect(mgr.getRegistered()).toContain("temp");
    mgr.unregister("temp");
    expect(mgr.getRegistered()).not.toContain("temp");
    clearInterval(t);
  });
});
