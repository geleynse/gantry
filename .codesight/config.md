# Config

## Environment Variables

- `BUILD_VERSION` **required** — server/build.ts
- `BUN_ENV` **required** — server/src/config/env.ts
- `CF_TUNNEL` **required** — server/src/web/auth/index.ts
- `DANGER_POLL_INTERVAL_MS` **required** — server/src/config/env.test.ts
- `FLEET_DIR` **required** — server/src/config/env.ts
- `GANTRY_AGENT_HOME` **required** — server/src/services/agent-manager.ts
- `GANTRY_AGENT_USER` **required** — server/src/services/agent-manager.ts
- `GANTRY_ENV` **required** — server/src/config/env.ts
- `GANTRY_EXTERNAL` **required** — server/src/web/auth/index.ts
- `GANTRY_HOST` **required** — server/src/index.ts
- `GANTRY_PORT` **required** — server/src/config/env.ts
- `GANTRY_PUBLIC_DIR` **required** — server/src/app.ts
- `GANTRY_SALT` **required** — server/src/services/crypto.ts
- `GANTRY_SECRET` **required** — server/src/services/crypto.test.ts
- `GANTRY_URL` **required** — server/src/web/routes/map.ts
- `GIT_COMMIT` **required** — server/build.ts
- `LOG_LEVEL` **required** — server/src/config/env.ts
- `MARKET_PRUNE_INTERVAL_MS` **required** — server/src/config/env.test.ts
- `MARKET_SCAN_INTERVAL_MS` **required** — server/src/config/env.test.ts
- `NODE_ENV` **required** — server/src/config/env.ts
- `PORT` **required** — server/src/config/env.ts
- `POSITION_POLL_INTERVAL_MS` **required** — server/src/config/env.test.ts
- `RUN_WS_INTEGRATION` **required** — server/src/web/websocket.test.ts
- `SCHEMA_TTL_MS` **required** — server/src/config/env.test.ts
- `SERVER_PROCESS_NAME` **required** — server/src/web/routes/action-proxy.ts
- `SKIP_API_SYNC` **required** — server/src/proxy/schema-drift.test.ts
- `TEST_LOGS` **required** — server/src/lib/logger.test.ts
- `TRUST_PROXY` **required** — server/src/app.ts
- `WATCHDOG_WEBHOOK_URL` **required** — server/src/proxy/doc-tools.ts

## Config Files

- `Dockerfile`
- `docker-compose.yml`
- `server/next.config.ts`
