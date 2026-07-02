---
name: build-and-dev
description: Use when building Gantry (server or dashboard), running the dev loop, seeing a UI change "not show up" after editing a .tsx file, producing the standalone binary, or running the built server locally without a live fleet.
---

# Build and Dev — Gantry Server

Gantry is a Bun project (not Node). All commands below run from `server/` unless noted.

## Setup

```bash
cd server
bun install
```

## Build Commands

| Command | What it does |
|---|---|
| `bun run build:server` | Runs `bun run build.ts` — esbuild bundles `src/index.ts` → `dist/index.js` (ESM, node22 target, sourcemaps on) |
| `bun run build:client` | Runs `bun run next build` — Next.js 15 static export → `dist/public/` |
| `bun run build` | `build:server` then `build:client` — full build |
| `bun run build:binary` | `build:client` then `bun run build.ts --binary` — standalone binary, see below |
| `bun run dev` | `bun run build.ts --watch` — esbuild watch mode, **server only** |
| `bun run dev:client` | `bun run next dev --port 3001` — Next.js dev server on a separate port |
| `bun run start` | `bun dist/index.js` — run the already-built server |

`build.ts` reads `package.json` version and `git rev-parse HEAD` (short hash) at build time and bakes them in via esbuild `define` as `process.env.BUILD_VERSION` / `process.env.GIT_COMMIT`, so the compiled bundle has real values even with no `.git` or `package.json` on the deploy target.

### `build:server` esbuild config (`server/build.ts`)

| Option | Value |
|---|---|
| `entryPoints` | `src/index.ts` |
| `bundle` | `true` |
| `platform` / `target` | `node` / `node22` |
| `format` | `esm` |
| `outfile` | `dist/index.js` |
| `sourcemap` | `true` |
| `external` | `node:*`, `bun:sqlite`, `ws`, `socks` — left unbundled, resolved at runtime by Bun/Node |

In `--watch` mode (`bun run dev`), the same config runs via `esbuild.context(...).watch()` instead of a one-shot `esbuild.build(...)`.

## CRITICAL: `bun run dev` does not rebuild the dashboard

`bun run dev` only watches and rebuilds the **server** bundle (`build.ts` in `--watch` mode, esbuild). It does **not** touch `dist/public/`.

If you edit a `.tsx` file under `src/app/` or `src/components/` and need to see it in a browser:

```bash
bun run build:client   # or bun run build for server+client
```

Without this, the server keeps serving the stale `dist/public/` bundle regardless of your source edits — the symptom is "I fixed it but the browser still shows the old behavior." This is the single most common build-loop trap in this repo (see `server/CLAUDE.md`).

`bun run dev:client` (Next dev server on :3001) is a separate live-reload option for pure frontend iteration, but it does not proxy `/api/*` or `/mcp*` — use it only for component/styling work in isolation, not for verifying integration with the server.

## Two tsconfigs

| File | Scope | Notes |
|---|---|---|
| `tsconfig.json` | Server code (esbuild input): everything under `src/**/*.ts`, `src/**/*.tsx` | `moduleResolution: bundler`, `jsx: react-jsx`, `noEmit: true` |
| `tsconfig.next.json` | Next.js/React only: `src/app/`, `src/components/`, `src/hooks/`, `src/lib/` | Excludes `src/proxy/**`, `src/web/**`, `src/shared/**`, `src/client/**`, `src/config.ts`, `src/app.ts`, `src/index.ts`, `src/test/**`, all `*.test.ts(x)` / `*.spec.ts(x)`. `jsx: preserve`, has the `next` TS plugin. |

There is **no dedicated `typecheck` npm script**. Type errors surface via `bun run build` (esbuild does not type-check, but `next build` does type-check the client tree) — treat `bun run build` as the closest thing to a project-wide type gate. If you need an explicit check, run `bunx tsc --noEmit -p tsconfig.json` or `-p tsconfig.next.json` directly.

## Binary build (`bun run build:binary`)

1. `build:client` runs first — `dist/public/` must exist before packaging.
2. `build.ts --binary`:
   - Globs every file under `dist/public/**/*`.
   - Generates `dist/_embedded-assets.ts`, one `import fN from "./public/..." with { type: "file" }` per asset, plus a `export default [f0, f1, ...]`. This is Bun's supported mechanism for embedding arbitrary files (including `.html`) into a compiled binary.
   - Runs `bun build --compile --target=bun` with `--define:process.env.BUILD_VERSION=...` / `--define:process.env.GIT_COMMIT=...`, entry points `src/index.ts` + the generated manifest, `--outfile=dist/gantry`.
3. Output: `dist/gantry`, a standalone Linux x86-64 binary (~200MB) with the frontend embedded — no Bun runtime needed on the target.
4. At runtime, `src/app.ts` checks `globalThis.Bun.embeddedFiles` (empty array when not running as a compiled binary) to decide whether to serve static assets from memory (compiled binary) or from disk (`dev`/esbuild mode).
5. First-run scaffolding for a binary deploy: `bun scripts/gantry-setup.ts <install-dir>` (defaults to cwd). Idempotent — creates `<install-dir>/data/pids/`, `<install-dir>/logs/`, and writes a default `<install-dir>/gantry.json` (skips if one already exists).

## Running the built server locally without a live fleet

Do **not** point a local run at a real fleet/game account just to sanity-check a build. Use mock mode instead:

```bash
GANTRY_MOCK=1 bun dist/index.js
```

This swaps in `MockGameClient` — canned responses, simulated credits/fuel/cargo, no network connection or game account required. See the `mock-mode` skill (and `docs/mock-mode.md`) for configuration details (`mockMode` key in `gantry.json`, `responsesFile`, `initialState`, precedence rules).

## Quick verification loop

```bash
bun run build:server   # fast — proxy/server-only changes
bun run build          # full — before verifying anything in the browser
bun test <file>        # see the testing skill
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Browser shows old UI after editing `.tsx` | `bun run dev` doesn't rebuild the client | `bun run build:client` (or `bun run build`), then restart/refresh |
| `dist/gantry` binary build fails at the `bun build --compile` step with a missing-file error | `dist/public/` doesn't exist yet | Run `bun run build:client` first, or just use `bun run build:binary` (does it for you) |
| Compiled binary serves 404s for static assets | Ran an old `build.ts --binary` against a stale `dist/public/` | Rebuild client before rebuilding the binary — asset list is captured at binary-build time via `Glob('dist/public/**/*')` |
| `next build` fails with type errors under `src/app/` or `src/components/` | `tsconfig.next.json` type-checks that tree; esbuild does not | Fix the type error — there's no way to skip `next build`'s type check short of `bun run build:server` alone (server-only, doesn't touch the client) |
| First-run on a bare deploy directory has no `gantry.json` / `data/` / `logs/` | Scaffolding not run yet | `bun scripts/gantry-setup.ts <install-dir>` — idempotent, safe to re-run |
