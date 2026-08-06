#!/usr/bin/env bash
# Runs every test file in its own bun process, so cross-file global state
# (globalThis.fetch, module singletons, the shared DB handle) cannot leak.
# Exits 1 if any file fails.
#
# Why per-file processes: run as a single `bun test src/`, this suite is
# nondeterministic — 3 of 5 clean-tree runs went red with a DIFFERENT failing set
# each time. Every one of those failures was cross-file pollution, and per-file
# isolation removes the family outright. It costs about 60s over the
# single-process run. That is the price of a signal you can act on.
#
# Usage:
#   run-tests-isolated.sh                gating run over all discovered test files
#   run-tests-isolated.sh --quarantined  run ONLY the quarantined tests (informational)
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

# --- Quarantine ------------------------------------------------------------
# Tests excluded from the gate. Each entry is `<file>::<exact test name>`; bun's
# -t takes a PCRE, and a negative lookahead lets us skip a test without editing
# or deleting it. This array is the SINGLE SOURCE for both the exclusion and the
# separate non-gating "run only these" mode CI invokes with --quarantined, so
# the two can no longer drift apart.
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
  'src/services/log-streamer.test.ts::log-streamer multi-subscriber fan-out'
)

# Escape every character that is not alphanumeric, underscore or space, so a
# test name is matched LITERALLY by bun's -t PCRE. Without this a name
# containing `.` `(` `[` `*` `?` would silently exclude unrelated tests (or fail
# to exclude the intended one) the day someone adds such a name.
pcre_escape() {
  local s="$1" out="" c i
  for (( i = 0; i < ${#s}; i++ )); do
    c="${s:i:1}"
    case "$c" in
      [A-Za-z0-9_\ ]) out+="$c" ;;
      *)              out+="\\$c" ;;
    esac
  done
  printf '%s' "$out"
}

# Build a negative-lookahead PCRE: match every test name EXCEPT the quarantined.
build_filter() {
  local re='^'
  local entry name
  for entry in "${QUARANTINE[@]}"; do
    name="${entry##*::}"
    re+="(?!.*$(pcre_escape "$name"))"
  done
  printf '%s.*$' "$re"
}

export SKIP_API_SYNC=1

# --- Discovery -------------------------------------------------------------
# This MUST match what `bun test` itself considers a test file. When it does
# not, the gate reports success over a subset and the shortfall is invisible.
# That was not hypothetical: the previous glob was '*.test.ts' / '*.test.tsx'
# only, which silently skipped src/components/__tests__/add_agent_test.tsx —
# a real file with 5 real tests that bun runs and the gate did not.
#
# Bun's actual rule, measured against bun 1.3.9 rather than copied from docs:
#   <anything><. or _><test or spec>.<js|jsx|ts|tsx|mjs|cjs|mts|cts>
# matched case-INSENSITIVELY (`x.Test.TS` counts), recursively, with
# node_modules excluded. Hyphen is not a separator (`a-test.ts` is not a test),
# and a bare `test.ts` with no prefix is not one either.
#
# verify_discovery_matches_bun() below re-proves this against the installed bun
# on every run, so a bun upgrade that changes the rule fails the gate loudly
# instead of quietly shrinking it.
BUN_TEST_WORDS=(test spec)
BUN_TEST_EXTS=(js jsx ts tsx mjs cjs mts cts)

# Emit NUL-separated paths: filenames may legally contain spaces or newlines,
# and a newline-delimited `while read` loop would split such a name into two
# bogus paths (both of which would then "pass" by not existing).
discover_tests() {
  local root="$1"
  local -a name_expr=()
  local w e
  for w in "${BUN_TEST_WORDS[@]}"; do
    for e in "${BUN_TEST_EXTS[@]}"; do
      name_expr+=( -o -iname "*[._]${w}.${e}" )
    done
  done
  name_expr=( "${name_expr[@]:1}" )   # drop the leading -o
  # Grouping matters: prune node_modules FIRST, then match files. Without the
  # explicit \( \) around the name alternation, -o would bind loosely and
  # -type f would apply to only the first alternative.
  find "$root" \( -name node_modules -type d -prune \) -o \
       \( -type f \( "${name_expr[@]}" \) -print0 \) \
    | LC_ALL=C sort -z
}

# Prove our discovery agrees with the installed bun, by asking bun. Builds a
# fixture tree of names that should and should not match, runs a real `bun test`
# in it, and diffs bun's file list against ours. Cheap (one bun process, a dozen
# 2-line files) and it fails closed.
#
# Limitation, stated plainly: this proves parity over the fixture corpus below,
# not over every name bun might ever accept. Add a case here when you learn one.
verify_discovery_matches_bun() {
  local d
  d="$(mktemp -d -t gantry-discovery-XXXXXX)" || return 2
  mkdir -p "$d/nested/deep" "$d/node_modules/pkg"

  local body='import { test, expect } from "bun:test";
test("discovery probe", () => { expect(1).toBe(1); });'

  # Names bun SHOULD run (both separators, all extensions, mixed case, nested,
  # dotfile) followed by near-misses it should NOT run.
  local names=(
    a.test.ts b_test.tsx c.spec.js d_spec.jsx e.test.mjs f_test.cjs
    g.spec.mts h_spec.cts UPPER.TEST.TS Mixed_Spec.Tsx
    nested/deep/n.test.ts .hidden_test.ts
    plain.ts bare.ts test.ts spec.ts hyphen-test.ts plural.tests.ts
    notes.test.txt node_modules/pkg/skipme.test.ts
  )
  local n
  for n in "${names[@]}"; do printf '%s\n' "$body" > "$d/$n"; done

  # Authoritative: what bun itself collected.
  ( cd "$d" && bun test --reporter=junit --reporter-outfile=result.xml ) >/dev/null 2>&1
  grep -oE 'file="[^"]*"' "$d/result.xml" 2>/dev/null \
    | sed 's/file="//; s/"$//' | LC_ALL=C sort -u > "$d/bun.txt"

  # Ours, over the identical tree.
  ( cd "$d" && discover_tests . ) | tr '\0' '\n' | sed 's|^\./||' \
    | LC_ALL=C sort -u | sed '/^$/d' > "$d/ours.txt"

  if [ ! -s "$d/bun.txt" ]; then
    echo "ERROR: discovery self-test could not determine what bun runs (empty junit output)."
    echo "       Refusing to report success — the gate cannot verify its own coverage."
    rm -rf "$d"
    return 2
  fi

  if ! diff -u "$d/bun.txt" "$d/ours.txt"; then
    echo
    echo "ERROR: this script's test-file discovery does NOT match what 'bun test' runs."
    echo "       '-' lines are files bun runs that the gate would SKIP (a false green)."
    echo "       '+' lines are files the gate would run that bun does not."
    echo "       Fix BUN_TEST_WORDS / BUN_TEST_EXTS / discover_tests to match."
    rm -rf "$d"
    return 2
  fi
  rm -rf "$d"
  return 0
}

# --- Quarantined-only mode (non-gating; invoked by CI) ---------------------
if [ "${1:-}" = "--quarantined" ]; then
  if [ ${#QUARANTINE[@]} -eq 0 ]; then
    echo "No quarantined tests."
    exit 0
  fi
  rc=0
  for entry in "${QUARANTINE[@]}"; do
    qfile="${entry%%::*}"
    qname="${entry##*::}"
    echo "--- quarantined: $qname  ($qfile)"
    bun test "$qfile" -t "$(pcre_escape "$qname")" || rc=1
  done
  exit "$rc"
fi

# --- Gating run ------------------------------------------------------------
verify_discovery_matches_bun || exit 2

test_args=()
if [ ${#QUARANTINE[@]} -gt 0 ]; then
  test_args=(-t "$(build_filter)")
fi

log="$(mktemp -t gantry-test-XXXXXX.log)"
trap 'rm -f "$log"' EXIT

failed=()
skipped=()
count=0
while IFS= read -r -d '' f; do
  count=$((count + 1))
  if ! bun test "$f" "${test_args[@]}" > "$log" 2>&1; then
    failed+=("$f")
    echo "::group::FAIL $f"
    cat "$log"
    echo "::endgroup::"
  elif grep -q 'GANTRY_SKIPPED_UNBINDABLE' "$log"; then
    # A test that early-returns because it could not bind a local port passes
    # and is counted, which is indistinguishable from a real pass in suppressed
    # output. Surface it: same failure class as discovery omission.
    skipped+=("$f")
  fi
done < <(discover_tests src)

echo "ran $count files, ${#failed[@]} failed"

if [ ${#skipped[@]} -gt 0 ]; then
  echo
  echo "NOTICE: ${#skipped[@]} file(s) skipped integration coverage because a local"
  echo "        port could not be bound. These PASSED but tested less than they claim:"
  printf '  SKIPPED(unbindable): %s\n' "${skipped[@]}"
fi

# Guard against a vacuous green: if discovery breaks or the cwd is wrong we would
# otherwise "pass" having run nothing. This is not hypothetical — an early draft
# of this script cd'd one level too high and printed "ran 0 files, 0 failed" with
# exit 0, which is exactly the bug this whole change exists to remove.
#
# This floor only catches "the tree was not walked at all". The subtler failure —
# discovery walking the tree but matching too few NAME FORMS — is what
# verify_discovery_matches_bun() above covers; do not rely on this number for it.
#
# To update: run ./scripts/run-tests-isolated.sh, take the "ran N files" figure,
# and set this a little below it (current N = 292, 2026-08-05).
MIN_FILES=280
if [ "$count" -lt "$MIN_FILES" ]; then
  echo "ERROR: only $count test files discovered, expected >= $MIN_FILES. Refusing to report success."
  exit 2
fi

if [ ${#failed[@]} -gt 0 ]; then
  printf 'FAILED: %s\n' "${failed[@]}"
  exit 1
fi
exit 0
