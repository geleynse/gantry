# Session Expiry Fix Plan — 2026-05-30

**Problem:** Fleet-wide game-session expiry stalls Sonnet agents mid-turn. On the 2026-05-28 validation run (18 min), multiple agents hit `session_expired` repeatedly, burned whole turns re-authing, and some never completed a turn (sable-thorn T:0, drifter-gale T:1/14m). Haiku agents and the overseer were unaffected.

---

## 1. How the Proxy Currently Handles Game Auth / Session

### Session creation flow (traced from code)

1. **`HttpGameClientV2.login()`** (`http-game-client-v2.ts:474`) calls `mcpInitialize()` then `spacemolt_auth(action=login)`.
2. **`mcpInitialize()`** (`http-game-client-v2.ts:248`) does three things:
   - POSTs to `/api/v1/session` — gets back `{ session: { id, expires_at } }`. Stores `this.gameSessionId = session.id` and `this.sessionExpiresAt = new Date(session.expires_at).getTime()`.
   - POSTs MCP `initialize` RPC to `${mcpUrl}/v2?preset=${preset}` — captures `Mcp-Session-Id` response header as `this.mcpSessionId`.
   - POSTs `notifications/initialized`.
3. **`login()`** then calls `spacemolt_auth(action=login, session_id: this.mcpSessionId)`, parses `Session ID:` from the greeting, overwrites `this.gameSessionId` with the parsed value (or falls back to `mcpSessionId`).
4. After login, `handleLogin()` (`auth-handlers.ts:121`) primes the status cache, fires `runDiscovery`, and fetches skills.

### Session token storage

- **`gameSessionId`** — the canonical session token (string on the instance; null when not logged in). Auto-injected into every tool call's `args.session_id` except `spacemolt_catalog`.
- **`mcpSessionId`** — the MCP transport session ID sent via `Mcp-Session-Id` header. Distinct from `gameSessionId` but initially equal.
- **`sessionExpiresAt`** — local timestamp (ms) of game-server-reported expiry. Stored but **never checked proactively** — there is no pre-expiry refresh logic anywhere in the codebase.
- Credentials (username/password) are persisted to SQLite (`proxy_sessions` table) via `SessionManager.persistSessions()` so they survive gantry restarts.

### SESSION_EXPIRED detection and re-login

Detection lives in `execute()` (`http-game-client-v2.ts:624`):

```typescript
if (resp.error && isNotLoggedInError(resp.error) && this.credentials) {
  const renewed = await this.renewSession();
  if (renewed) {
    args.session_id = this.gameSessionId;
    const retryResp = await this.mcpToolCall(toolName, args, opts?.timeoutMs);
    return retryResp;
  }
  return resp;  // renewal failed — return the original expired error
}
```

`isNotLoggedInError()` matches codes: `session_expired`, `unauthorized`, `token_expired`, `invalid_session`, `session_invalid`, `not_logged_in`, or any message containing "not logged in".

**`renewSession()`** (`http-game-client-v2.ts:874`):
1. Calls `mcpInitialize()` — creates a NEW `/api/v1/session`, does a new MCP handshake.
2. Calls `spacemolt_auth(action=login, session_id: this.mcpSessionId)`.
3. Parses the greeting for a new `gameSessionId`.
4. Sets `this.authenticated = true`, increments `this.reconnectCount`.

### Where the agent is told to re-login (agent-visible prompt)

The proxy **does not tell the Sonnet agent to call `login`**. The proxy's `renewSession()` fires silently inside `execute()`. However, if renewal fails, the original `session_expired` error is returned to the agent — and Sonnet agents are interpreting that error as an instruction to call the proxy `login` tool explicitly, triggering a full agent-level re-auth loop on top of the proxy's own internal renewal.

---

## 2. Why Sessions Expire and Why the Re-login Loop Is Self-Inflicted

### Root cause A: No proactive session keepalive against the game server

`sessionExpiresAt` is stored at `http-game-client-v2.ts:299` but **never read** — no background timer refreshes the game session before it expires. The proxy keeps the *MCP transport session* alive via `startSessionKeepalive()` (`gantry-v2.ts:478`), which calls `sessionStore.getSession()` every 60s. This renews the Gantry-internal SQLite session TTL (25 min) — but does nothing to keep the SpaceMolt game server session alive.

Game sessions appear to have a TTL shorter than 18 minutes, which is why agents hitting a busy turn (many tool calls, slow game server) expire mid-turn. The `expires_at` from the API call is received but ignored beyond storage.

### Root cause B: renewSession() itself invalidates the session for concurrent calls

`renewSession()` calls `mcpInitialize()` which:
1. Creates a NEW game session (`/api/v1/session`) — gets a new `gameSessionId`.
2. Creates a NEW MCP session — gets a new `mcpSessionId`.

After renewal completes, `this.gameSessionId` is replaced. **But `execute()` holds a reference to the old `args.session_id` at the call site** — the re-injected `args.session_id = this.gameSessionId` at `http-game-client-v2.ts:631` happens correctly for the single re-tried call.

The deeper problem: `renewSession()` has **no single-flight lock**. If `refreshStatus()` fires two concurrent `execute()` calls (`get_status` + `get_location`, fanned out via `Promise.all` at `http-game-client-v2.ts:712`), both can detect session expiry simultaneously and both call `renewSession()`. The first renewal creates session S2, the second creates S3 — S2 is immediately orphaned. The agent then holds S3 but has already retried `get_status` with S2's credentials. Any subsequent call using S3 may also fail because the game server may interpret the rapid chained `spacemolt_auth(login)` calls as invalidating the previous session.

### Root cause C: Re-login thrash loop from Sonnet's prompt behavior

When `renewSession()` fails (or returns the original `session_expired` error), Sonnet agents see an error from the game tool saying the session is expired. Sonnet's trained behavior is to call the proxy `login` tool explicitly. This triggers `handleLogin()` in `auth-handlers.ts`. If the game client is already `isAuthenticated()` (internal state was reset by a concurrent renewSession that succeeded), `handleLogin()` returns early with `_reused_session: true`. If not, it runs the full login flow again.

The observed "logout/login thrash" (lumen-shoal, hollow-pyre) indicates:
1. Agent calls logout (burns a turn, also calls `renewSession` internally via the logout flow or the agent just calls `logout` explicitly).
2. Agent calls login. 
3. Session expires again because the real game session TTL is shorter than the inter-turn gap.
4. Repeat.

**The `captains_log_add -32001` memory note is consistent:** `renewSession()` creates a new game session mid-turn, but the passthrough path for `captains_log_add` still sends the old `session_id` header via `X-Session-Id` — because `args.session_id` is only re-injected for the specific retried call inside `execute()`, not flushed across the entire passthrough pipeline.

### Root cause D: Why Sonnet agents are uniquely affected (vs Haiku)

Sonnet turns are longer (more deliberate, more tool calls). A Haiku agent may finish its turn within the game session TTL. A Sonnet agent spending 14+ minutes per turn will almost certainly hit session expiry if the game TTL is ~15-18 minutes. This matches the observed pattern.

---

## 3. Fix Design

### Option A: Proxy-level single-flight re-auth with proactive refresh (recommended)

**Mechanism:**

1. **Single-flight lock on `renewSession()`**: Add a `private reauthPromise: Promise<boolean> | null = null` field. When `renewSession()` is called, if `reauthPromise` is non-null, await and return it instead of starting a second renewal. This eliminates session clobbering from concurrent `execute()` calls (e.g., `refreshStatus()` fan-out).

2. **Proactive game session refresh before expiry**: After each `mcpInitialize()` (login + every renewal), schedule a `setTimeout` to call `renewSession()` proactively when `sessionExpiresAt - 90_000` arrives (90s before game session expiry). Cancel on `close()` or logout. This prevents the mid-turn surprise expiry.

3. **Cap re-auth attempts per `execute()` call**: Currently `execute()` calls `renewSession()` once and retries the tool call. Keep that — but add a class-level `reconnectCount` cap (already exists; add a per-call `if reconnectCount >= MAX_RECONNECTS return original error without retry`). MAX_RECONNECTS = 5 is already tracked; use it as a circuit-breaker.

4. **Suppress the error to the agent**: When `renewSession()` succeeds, the re-tried call result is returned transparently. The agent never sees the expiry. When `renewSession()` fails, return a synthesized error code like `session_renewal_failed` with a message: "Session renewal failed — do NOT call logout/login. Retry your action in 30s." This directly suppresses the agent re-auth loop.

**Why preferred over Option B:**

This fixes the root cause (no session keepalive, no single-flight lock) rather than trying to prompt-patch Sonnet's response to seeing a session_expired error. Prompt rules can be ignored or forgotten; proxy-level handling is deterministic.

### Option B: Prompt-rule cap on re-login attempts (not recommended alone)

Add a directive (via `agentDeniedTools` or injected warning) that caps agent-level `login` calls per session to 1-2. Blocks the thrash loop symptom but doesn't fix the underlying session expiry or the concurrent renewal clobbering. Haiku agents would also be affected by the cap.

**Verdict:** Implement Option A. Add a lightweight variant of Option B (make the `session_expired` error message agent-hostile to re-auth) as defense-in-depth.

---

## 4. Exact Files and Functions to Change

### 4.1 `server/src/proxy/http-game-client-v2.ts`

**New private fields** (add near line 168):
```typescript
/** Single-flight lock: non-null while a renewSession() is in progress. */
private reauthPromise: Promise<boolean> | null = null;
/** Timer handle for proactive session refresh (cleared on close/logout). */
private sessionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
/** Max consecutive reconnects before giving up and returning error to agent. */
private static readonly MAX_RECONNECTS = 5;
```

**Modify `mcpInitialize()`** (after line 299 where `sessionExpiresAt` is set): schedule the proactive refresh.
```typescript
// Schedule proactive refresh 90s before game session expires.
this.scheduleSessionRefresh();
```

**New private method `scheduleSessionRefresh()`** (add after `renewSession()`):
```typescript
private scheduleSessionRefresh(): void {
  if (this.sessionRefreshTimer) {
    clearTimeout(this.sessionRefreshTimer);
    this.sessionRefreshTimer = null;
  }
  if (!this.sessionExpiresAt || !this.credentials) return;
  const msUntilExpiry = this.sessionExpiresAt - Date.now();
  const msUntilRefresh = msUntilExpiry - 90_000;
  if (msUntilRefresh <= 0) return; // Already near or past expiry — let on-demand handle it
  this.sessionRefreshTimer = setTimeout(async () => {
    if (!this.authenticated || !this.credentials) return;
    this.log(`proactive session refresh (${Math.round(msUntilExpiry / 1000)}s before expiry)`);
    await this.renewSession();
  }, msUntilRefresh);
}
```

**Modify `renewSession()`**: wrap with single-flight pattern.
```typescript
private async renewSession(): Promise<boolean> {
  // Single-flight: if a renewal is already in progress, wait for it.
  if (this.reauthPromise) {
    this.log("renewSession: waiting for in-progress renewal");
    return this.reauthPromise;
  }
  this.reauthPromise = this._doRenewSession();
  try {
    return await this.reauthPromise;
  } finally {
    this.reauthPromise = null;
  }
}

private async _doRenewSession(): Promise<boolean> {
  if (!this.credentials) return false;
  try {
    await this.mcpInitialize();
    const resp = await this.mcpToolCall("spacemolt_auth", {
      action: "login",
      username: this.credentials.username,
      password: this.credentials.password,
      session_id: this.mcpSessionId,
    });
    if (resp.error) return false;
    this.gameSessionId = this.parseSessionIdFromGreeting(resp.result) ?? this.mcpSessionId;
    this.authenticated = true;
    this.reconnectCount++;
    log.info("[proxy] session auto-reconnect succeeded (v2)", {
      agent: this.label, reconnectCount: this.reconnectCount,
    });
    this.log("MCP v2 session renewed successfully");
    return true;
  } catch {
    this.logError("MCP v2 session renewal failed");
    return false;
  }
}
```

**Modify `execute()` error branch** (lines 624-644): change the error returned on renewal failure to suppress agent re-login attempts.
```typescript
if (resp.error && isNotLoggedInError(resp.error) && this.credentials) {
  if (this.reconnectCount >= HttpGameClientV2.MAX_RECONNECTS) {
    this.log(`session renewal limit reached (${this.reconnectCount}/${HttpGameClientV2.MAX_RECONNECTS})`);
    return {
      error: {
        code: "session_renewal_exhausted",
        message: "Session renewal limit reached. Wait 60s, then logout and login once.",
      },
    };
  }
  this.log(`session expired (${resp.error.code}: ${resp.error.message}) — auto-re-login for ${this.label}`);
  const renewed = await this.renewSession();
  if (renewed) {
    if (toolName !== "spacemolt_catalog") {
      args.session_id = this.gameSessionId;
    }
    const retryResp = await this.mcpToolCall(toolName, args, opts?.timeoutMs);
    // metrics...
    return retryResp;
  }
  // Renewal failed — return a message that suppresses the agent re-auth loop
  return {
    error: {
      code: "session_renewal_failed",
      message: "Session renewal failed. Do NOT call logout or login — retry your action in 30 seconds.",
    },
  };
}
```

**Modify `close()` and `logout()`**: clear the refresh timer.
```typescript
async close(): Promise<void> {
  if (this.sessionRefreshTimer) {
    clearTimeout(this.sessionRefreshTimer);
    this.sessionRefreshTimer = null;
  }
  this.authenticated = false;
  this.gameSessionId = null;
  this.mcpSessionId = null;
  this.sessionExpiresAt = null;
}
```
Add same timer cleanup at the top of `logout()`.

**Modify `instability-hints.ts:SAFE_TOOLS`** (line 14): this is unrelated to session handling, no change needed.

### 4.2 `server/src/proxy/instability-hints.ts`

No changes needed. Session errors are already transparent to the instability gate.

### 4.3 `server/src/proxy/auth-handlers.ts`

No changes needed. `handleLogin()` already handles the `isAuthenticated()` short-circuit correctly; the fix is upstream in `HttpGameClientV2`.

### 4.4 (Optional defense-in-depth) Fleet config / agent prompt

Add to the system prompt or directives for Sonnet agents: "If you see `session_renewal_failed`, wait 30 seconds and retry — do not call logout or login." This can be added to `server/src/services/overseer-prompt.ts` or as a fleet directive. This is a low-priority backstop — the proxy-level fix should prevent agents from ever seeing an expired session error.

---

## 5. Tests to Add (bun test)

**File: `server/src/proxy/http-game-client-v2.test.ts`**

All tests use the existing `pushInitSequence` / `pushMcpToolResult` / `pushLoginSequence` helper pattern.

### Test 1: Single-flight lock on concurrent renewSession

```
"concurrent session expiry: second renewSession awaits the first, not a new login"
```
- After login, push two concurrent tool calls that both return `session_expired`.
- Use a mock that tracks how many times `mcpInitialize` is called.
- Verify `mcpInitialize` fires exactly once (not twice), and both calls return success after renewal.

### Test 2: Proactive refresh timer fires before expiry

```
"scheduleSessionRefresh: fires renewSession before sessionExpiresAt"
```
- Login with a session that expires in 200ms (mock `expires_at` timestamp).
- Disable `SessionCreateSpacing` for the test.
- Wait 150ms, verify `renewSession()` was called (inspect `reconnectCount` or fetch call count).

### Test 3: Proactive refresh does not fire if session not near expiry

```
"scheduleSessionRefresh: does not fire immediately when expiry is far out"
```
- Login with `expires_at` 30 minutes from now.
- Wait 50ms. Verify `reconnectCount === 0` (no proactive renewal).

### Test 4: execute() returns suppressed error after MAX_RECONNECTS

```
"execute: returns session_renewal_exhausted after MAX_RECONNECTS exceeded"
```
- After login, set `client.reconnectCount = 5` (via test accessor or internal direct set).
- Push a `session_expired` tool response.
- Call `execute("spacemolt", { action: "get_status" })`.
- Verify result is `{ error: { code: "session_renewal_exhausted", ... } }`.
- Verify `mcpInitialize` was NOT called again.

### Test 5: execute() returns session_renewal_failed with suppressive message when renewSession fails

```
"execute: returns session_renewal_failed (not original error) when renewal fails"
```
- After login, push `session_expired` response, then push a session creation error for the renewal attempt.
- Verify `execute()` returns `{ error: { code: "session_renewal_failed", message: /Do NOT call logout/ } }`.

### Test 6: logout() and close() clear the refresh timer (no timer leaks)

```
"close: clears sessionRefreshTimer on close"
```
- Login with near-expiry session.
- Call `close()` immediately.
- Wait past the refresh window.
- Verify no additional fetch calls happen after close (timer did not fire).

### Test 7: renewSession clears and re-schedules the proactive timer after successful renewal

```
"renewSession: schedules new refresh timer after renewal succeeds"
```
- Login, force `renewSession()` to trigger.
- Verify `sessionExpiresAt` is updated from the new session response.
- Verify the timer is rescheduled (indirect: `sessionRefreshTimer` is non-null after renewal).

---

## 6. Definition of Done

- [ ] `renewSession()` wrapped with single-flight: concurrent calls share one renewal, not N.
- [ ] `scheduleSessionRefresh()` fires 90s before `sessionExpiresAt` on every successful `mcpInitialize()`.
- [ ] `execute()` returns `session_renewal_failed` (not `session_expired`) when renewal fails — message explicitly tells agent not to call logout/login.
- [ ] `execute()` short-circuits with `session_renewal_exhausted` when `reconnectCount >= MAX_RECONNECTS`.
- [ ] `close()` and `logout()` cancel the refresh timer.
- [ ] All 7 new tests pass with `bun test server/src/proxy/http-game-client-v2.test.ts`.
- [ ] Full test suite passes: `bun test server/src` with no regressions.
- [ ] `SessionCreateSpacing` still disabled in tests (no sleep introduced).

---

## 7. Verification Checklist (post-deploy)

- [ ] **Log check — proactive refresh fires**: In production logs, look for `proactive session refresh` entries appearing ~90s before session expiry, with no `session expired` errors following them.
- [ ] **Log check — no concurrent renewals**: Grep for `renewSession: waiting for in-progress renewal` — these entries are expected during refreshStatus fan-out; verify no double `[proxy] session auto-reconnect succeeded` for the same agent within 5 seconds.
- [ ] **Fleet run — Sonnet turn completion rate**: Run 18-minute validation fleet. Target: all Sonnet agents complete >2 turns (vs T:0-1 on 2026-05-28 run). No `session_expired` errors visible in agent turn logs.
- [ ] **reconnectCount**: After a normal 18-min run, `reconnectCount` should be 0 for all agents (proactive refresh prevented reactive renewals). If > 0, proactive timing needs tuning.
- [ ] **captains_log_add -32001**: Should not appear in logs after fix, since proactive refresh prevents session expiry that was causing stale `session_id` in the passthrough layer.
- [ ] **Concurrent agent stress**: Deploy with 8+ agents running simultaneously; verify no `session_renewal_exhausted` errors appear in normal operation (those should only appear after a genuine game-server outage + 5 failed renewal attempts).

---

## 8. Risk Notes

- **Game session TTL unknown**: The game server's actual session TTL is not documented. If it is shorter than 90s, the proactive refresh window needs to be tuned. Set an initial 90s buffer; if proactive refreshes still miss, reduce to 60s.
- **Re-login invalidation hypothesis**: The memory note (`captains-log-session-expiry.md`) says re-login mid-turn causes `-32001` on subsequent calls. This is consistent with the concurrent renewal clobbering root cause (B). The single-flight fix directly addresses it.
- **`SessionCreateSpacing` interaction**: `renewSession()` calls `mcpInitialize()`, which calls `awaitSessionCreateSlot()`. With the single-flight fix, only one renewal fires at a time — spacing is respected. Proactive renewal (single agent, no concurrent pressure) also goes through spacing normally.
- **No change to auth-handlers.ts login path**: The `handleLogin()` short-circuit on `isAuthenticated()` stays as-is. It already prevents agent-called `login` from doing a redundant game login if the proxy already holds a valid session.
