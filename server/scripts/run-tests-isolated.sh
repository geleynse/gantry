#!/usr/bin/env bash
# Runs every test file in its own bun process, so cross-file global state
# (globalThis.fetch, module singletons, the shared DB handle) cannot leak.
# Exits 1 if any file fails.
#
# Why per-file processes: run as a single `bun test src/`, this suite is
# nondeterministic — 3 of 5 clean-tree runs went red with a DIFFERENT failing set
# each time. Every one of those failures was cross-file pollution, and per-file
# isolation removes the family outright (291 files, 0 failures, 3 passes running).
# It costs about 60s over the single-process run. That is the price of a signal
# you can act on.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

# --- Quarantine ------------------------------------------------------------
# Tests excluded from the gate by NAME (bun's -t takes a PCRE, and negative
# lookahead lets us skip a test without editing or deleting it). They still run
# in CI's separate non-gating "Quarantined flaky tests" step, so a quarantined
# test that starts failing ALWAYS is still visible.
#
# Keep this list as short as the evidence allows. Every entry needs a measured
# flake rate and a named fix. Do not widen it to make a red build green.
#
#   log-streamer multi-subscriber fan-out (src/services/log-streamer.test.ts)
#     2/15 failures in fresh, fully isolated processes — NOT pollution.
#     Two different tests in the block fail on different runs, so per-test
#     quarantine would be whack-a-mole. Measured 2026-08-05: this is NOT an
#     under-budgeted timeout. Raising the block's waitFor budget from 3000ms to
#     15000ms (with bun's per-test ceiling lifted to 30s) converted ZERO
#     failures into passes — bad runs burned the full 15075ms and still failed.
#     The awaited condition never becomes true, so the real defect is a lost
#     event/race in the shared-tail fan-out against a real `tail` subprocess.
#     FIX: root-cause that race; do not just raise the timeout. Then delete
#     this entry.
QUARANTINE=(
  'log-streamer multi-subscriber fan-out'
)

# Build a negative-lookahead PCRE: match every test name EXCEPT the quarantined.
build_filter() {
  local re='^'
  local q
  for q in "${QUARANTINE[@]}"; do
    re+="(?!.*${q})"
  done
  printf '%s.*$' "$re"
}

export SKIP_API_SYNC=1

test_args=()
if [ ${#QUARANTINE[@]} -gt 0 ]; then
  test_args=(-t "$(build_filter)")
fi

log="$(mktemp -t gantry-test-XXXXXX.log)"
trap 'rm -f "$log"' EXIT

failed=()
count=0
while IFS= read -r f; do
  count=$((count + 1))
  if ! bun test "$f" "${test_args[@]}" > "$log" 2>&1; then
    failed+=("$f")
    echo "::group::FAIL $f"
    cat "$log"
    echo "::endgroup::"
  fi
done < <(find src \( -name '*.test.ts' -o -name '*.test.tsx' \) | sort)

echo "ran $count files, ${#failed[@]} failed"

# Guard against a vacuous green: if the glob breaks or the cwd is wrong we would
# otherwise "pass" having run nothing. This is not hypothetical — an early draft
# of this script cd'd one level too high and printed "ran 0 files, 0 failed" with
# exit 0, which is exactly the bug this whole change exists to remove. The floor
# sits below the current file count (291) so adding or removing a few test files
# does not trip it.
MIN_FILES=250
if [ "$count" -lt "$MIN_FILES" ]; then
  echo "ERROR: only $count test files discovered, expected >= $MIN_FILES. Refusing to report success."
  exit 2
fi

if [ ${#failed[@]} -gt 0 ]; then
  printf 'FAILED: %s\n' "${failed[@]}"
  exit 1
fi
exit 0
