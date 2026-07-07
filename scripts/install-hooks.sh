#!/usr/bin/env bash
# Point this clone's git hooks at the repo-tracked .githooks/ dir.
#
# core.hooksPath is a per-clone git config setting (it isn't picked up
# automatically from a committed file), so every clone/worktree needs to
# run this once.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd -P)"
repo_root="$(git -C "$script_dir" rev-parse --show-toplevel)"

chmod +x "$repo_root/.githooks/"*
git -C "$repo_root" config core.hooksPath .githooks

echo "Installed: core.hooksPath -> .githooks (pre-commit guards runtime data files, e.g. server/src/data/sessions.json)"
