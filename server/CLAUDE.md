# CLAUDE.md — Gantry Server

See [AGENTS.md](AGENTS.md) for full codebase context (architecture, modules, build commands, conventions, gotchas). Everything below is Claude Code-specific.

## Claude-Specific Notes

- **Process management**: In-memory `ChildProcess` tracking (authoritative) replaces PID-file-only tracking. PID files still written for external tooling but not used for liveness checks. `scanOrphanedProcesses()` finds untracked bun processes.
- **Single-binary deployment**: `bun run build:binary` compiles via `bun build --compile`. Static assets embedded via `Bun.embeddedFiles`. Use `bun scripts/gantry-setup.ts /opt/gantry` for first-run scaffolding.
- **Two tsconfigs**: `tsconfig.json` (server/esbuild), `tsconfig.next.json` (React/Next.js — excludes proxy/web/shared dirs).
- **Auth default**: `loopback` (127.0.0.1 only). Token adapter uses `config.token` (not `config.secret`), accepts only `Authorization: Bearer`.
- **Running locally**: `bun run dev` in `server/` for watch mode, or `bun run build && bun dist/index.js` for production.
