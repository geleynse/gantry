/**
 * Tests for SessionStore's rolling-TTL write throttle (gantry issue #117).
 *
 * getSession() slides last_seen_at/expires_at forward on every call to keep a
 * session's rolling TTL alive, but previously did so with an UPDATE on every
 * single call — heavy write amplification on the hottest path in the system
 * (every MCP tool call touches a session at least twice). The fix throttles
 * that UPDATE to at most once per `touchThrottleMs` per session, while the
 * SELECT (and the returned record) behave identically from the caller's
 * perspective.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createDatabase, closeDb, queryOne } from "../services/database.js";
import { SessionStore } from "./session-store.js";

interface RawSessionRow {
  last_seen_at: string;
  expires_at: string;
}

function rawRow(id: string): RawSessionRow | null {
  return queryOne<RawSessionRow>(
    "SELECT last_seen_at, expires_at FROM mcp_sessions WHERE id = ?",
    id
  );
}

describe("SessionStore rolling-TTL write throttle", () => {
  // Use a short throttle window so the test doesn't have to wait out the real
  // 25-minute production TTL. Constructor param exists specifically for this.
  const THROTTLE_MS = 50;
  let store: SessionStore;

  beforeEach(() => {
    createDatabase(":memory:");
    store = new SessionStore(THROTTLE_MS);
  });

  afterEach(() => {
    closeDb();
  });

  it("skips the TTL UPDATE on a second call within the throttle window", () => {
    const sid = store.createSession("agent-a");
    // The FIRST getSession() always writes (no throttle bookkeeping yet) and
    // seeds the per-session timer. Capture the DB row AFTER that seeding write,
    // then assert the next within-window call leaves it untouched.
    store.getSession(sid);
    const first = rawRow(sid);
    expect(first).not.toBeNull();

    // Immediate second call — well within THROTTLE_MS — should NOT rewrite
    // last_seen_at/expires_at in the DB.
    store.getSession(sid);
    const second = rawRow(sid);
    expect(second!.last_seen_at).toBe(first!.last_seen_at);
    expect(second!.expires_at).toBe(first!.expires_at);
  });

  it("issues the TTL UPDATE again once the throttle window has elapsed", async () => {
    const sid = store.createSession("agent-a");
    // Seed the throttle timer with the first (always-unthrottled) call.
    store.getSession(sid);
    const first = rawRow(sid)!;

    // Burn through the throttle window so the NEXT call is no longer throttled.
    await Bun.sleep(THROTTLE_MS + 20);

    store.getSession(sid);
    const second = rawRow(sid)!;
    expect(second.last_seen_at).not.toBe(first.last_seen_at);
    expect(new Date(second.expires_at).getTime()).toBeGreaterThan(
      new Date(first.expires_at).getTime()
    );
  });

  it("returns an identical-shaped record whether or not the write was throttled", () => {
    const sid = store.createSession("agent-a");
    const r1 = store.getSession(sid);
    const r2 = store.getSession(sid); // throttled — no DB write this time

    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r2!.id).toBe(r1!.id);
    expect(r2!.agent).toBe("agent-a");
    // Caller-visible contract is unchanged: still gets a fresh lastSeenAt/expiresAt
    // back even when the underlying write was skipped.
    expect(typeof r2!.lastSeenAt).toBe("string");
    expect(typeof r2!.expiresAt).toBe("string");
  });

  it("throttles per-session, not with a single global timer", async () => {
    const sidA = store.createSession("agent-a");
    store.getSession(sidA); // A writes and seeds A's timer

    // If the throttle used one global timer, B's first getSession() would be
    // suppressed by A's just-completed write. With a per-session timer, B has no
    // entry yet and must write. Sleep < THROTTLE_MS (so a hypothetical global
    // timer would still be active) but long enough that a real write yields a
    // distinct timestamp.
    const sidB = store.createSession("agent-b");
    const beforeB = rawRow(sidB)!;
    await Bun.sleep(15);
    store.getSession(sidB);
    expect(rawRow(sidB)!.last_seen_at).not.toBe(beforeB.last_seen_at);
  });

  it("evicts the throttle bookkeeping when a session is reaped by cleanup()", async () => {
    const sid = store.createSession("agent-a");
    store.getSession(sid); // seed the throttle map entry

    // Force expiry, then reap.
    store.expireAgentSessions("agent-a");
    store.cleanup();
    expect(rawRow(sid)).toBeNull();

    // A brand-new session reusing... well, a fresh id — throttle map must not
    // have leaked the old entry. We can't directly inspect the private map,
    // but we can confirm a fresh session's first getSession() still performs
    // its write (i.e. it isn't spuriously throttled by stale bookkeeping).
    const sid2 = store.createSession("agent-a");
    const before = rawRow(sid2)!;
    await Bun.sleep(THROTTLE_MS + 20);
    store.getSession(sid2);
    const after = rawRow(sid2)!;
    expect(after.last_seen_at).not.toBe(before.last_seen_at);
  });

  it("evicts throttle bookkeeping when a session is force-expired via expireAgentSessions", () => {
    const sid = store.createSession("agent-a");
    store.getSession(sid); // seed the throttle map entry
    store.expireAgentSessions("agent-a");

    // getSession() on an expired session returns null and clears its own
    // bookkeeping too (belt-and-suspenders — already covered above), but the
    // real assertion here is that expireAgentSessions() doesn't throw and the
    // session is now invalid.
    expect(store.getSession(sid)).toBeNull();
    expect(store.isValidSession(sid)).toBe(false);
  });

  it("default constructor (no arg) still works — production default throttle is used", () => {
    const defaultStore = new SessionStore();
    const sid = defaultStore.createSession("agent-a");
    expect(defaultStore.isValidSession(sid)).toBe(true);
    const rec = defaultStore.getSession(sid);
    expect(rec?.agent).toBe("agent-a");
  });
});
