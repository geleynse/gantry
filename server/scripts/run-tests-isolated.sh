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
#
# Environment:
#   GANTRY_ALLOW_UNBINDABLE=1  downgrade "a file skipped its integration coverage
#                              because localhost could not be bound" from an error
#                              to a notice. See the SKIPPED(unbindable) block below.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

# --- Quarantine ------------------------------------------------------------
# Tests excluded from the gate. Each entry is `<file>::<exact test name>`; bun's
# -t takes a PCRE, and a negative lookahead lets us skip a test without editing
# or deleting it. This array is the SINGLE SOURCE for both the exclusion and the
# separate non-gating "run only these" mode CI invokes with --quarantined, so
# the two can no longer drift apart.
#
# The `<file>` half is LOAD-BEARING on both sides: an entry's name pattern is
# applied ONLY when running the file that entry names. It used to be decorative
# on the exclusion side — one negative-lookahead PCRE built from every name was
# passed to all 292 files — which meant an entry like `foo.test.ts::handles
# errors` would have silently disabled every test named "handles errors" in the
# whole suite while re-running it in exactly one file. That is the same
# silent-coverage-loss class this script exists to remove, so the invariant is
# now enforced structurally by verify_quarantine_partition() below rather than
# left to be noticed.
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

# Emit the quarantined test names that belong to file $1, one per line.
# Nothing on stdout means "this file has no quarantine entries".
quarantine_names_for() {
  local entry
  for entry in "${QUARANTINE[@]}"; do
    [ "${entry%%::*}" = "$1" ] || continue
    printf '%s\n' "${entry##*::}"
  done
}

# The distinct files named by the quarantine list, one per line.
quarantine_files() {
  local entry
  for entry in "${QUARANTINE[@]}"; do printf '%s\n' "${entry%%::*}"; done \
    | LC_ALL=C sort -u
}

# Negative-lookahead PCRE for file $1: match every test name in that file EXCEPT
# the ones quarantined FOR THAT FILE. Returns 1 (and prints nothing) when the
# file has no entries, which is the caller's signal to pass no -t at all.
build_exclusion_filter() {
  local re='' name
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    re+="(?!.*$(pcre_escape "$name"))"
  done < <(quarantine_names_for "$1")
  [ -n "$re" ] || return 1
  printf '^%s.*$' "$re"
}

# The exact complement of build_exclusion_filter for file $1: match ONLY that
# file's quarantined names. Returns 1 when the file has no entries.
build_inclusion_filter() {
  local alts='' name
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    [ -n "$alts" ] && alts+='|'
    alts+="$(pcre_escape "$name")"
  done < <(quarantine_names_for "$1")
  [ -n "$alts" ] || return 1
  printf '(?:%s)' "$alts"
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

# --- Discovery root --------------------------------------------------------
# The gating walk starts at `src`. Nothing verifies that choice:
# verify_discovery_matches_bun() proves the NAME rule against bun, but its
# fixture hands both sides the same root, so a wrong root is invisible to it,
# and MIN_FILES cannot see a shortfall of one or two files. The pre-existing CI
# step was `bun test` from `server/`, which walked all of `server/` — so a test
# file added at `server/foo.test.ts` used to run and would now be silently
# ungated.
#
# This guard closes that by walking `server/` itself and failing on any test
# file outside the gating root. Build output and data directories are excluded
# by an explicit list rather than by pruning inside discover_tests(), because
# discover_tests() must keep matching bun's rule exactly for the self-test above
# to mean anything.
DISCOVERY_ROOT=src
NON_SOURCE_PREFIXES=('./dist/' './.next/' './data/' './public/' './coverage/' './docs/')

verify_discovery_root() {
  local stray=() f p skip
  while IFS= read -r -d '' f; do
    case "$f" in "./$DISCOVERY_ROOT/"*) continue ;; esac
    skip=0
    for p in "${NON_SOURCE_PREFIXES[@]}"; do
      case "$f" in "$p"*) skip=1; break ;; esac
    done
    [ "$skip" -eq 1 ] || stray+=("$f")
  done < <(discover_tests .)

  [ ${#stray[@]} -eq 0 ] && return 0

  echo "ERROR: test file(s) found outside the gating root '$DISCOVERY_ROOT/':"
  printf '  %s\n' "${stray[@]}"
  echo "       The gate walks '$DISCOVERY_ROOT' only, so these would never run."
  echo "       Move them under '$DISCOVERY_ROOT/', or widen DISCOVERY_ROOT and MIN_FILES."
  return 2
}

# --- Quarantine partition --------------------------------------------------
# Report how many tests bun collected, from a captured `bun test` transcript.
# Prints 0 when bun printed no summary line (a crash, or a -t that matched
# nothing — bun errors out in that case rather than reporting zero).
test_count_from_log() {
  local n
  n="$(sed -n 's/^Ran \([0-9][0-9]*\) tests across.*/\1/p' "$1" | tail -1)"
  [ -n "$n" ] || n=0
  printf '%s' "$n"
}

count_tests() {
  local f="$1"; shift
  local tmp
  tmp="$(mktemp -t gantry-count-XXXXXX.log)" || return 2
  bun test "$f" "$@" > "$tmp" 2>&1
  test_count_from_log "$tmp"
  rm -f "$tmp"
}

# Make the file-scoping invariant structural instead of observed. For every file
# with quarantine entries:
#
#   gated tests (exclusion filter) + quarantined tests (inclusion filter)
#     == tests the file collects with no filter at all
#
# If those two filters ever stop being exact complements — a hand-edited PCRE, a
# regex metacharacter that escapes the escaper, a rename that leaves the entry
# matching a different set — the sum stops matching the total and the gate stops
# instead of quietly running a subset. Today: 17 = 12 + 5 for log-streamer.
#
# Each individual entry must also match at least one test in its own file. An
# entry whose test was renamed or deleted otherwise sits there forever excluding
# nothing, and the sum alone cannot see it (the exclusion and the inclusion both
# miss the same zero tests).
verify_quarantine_partition() {
  local f total gated quar entry name n rc=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if [ ! -f "$f" ]; then
      echo "ERROR: quarantine names '$f', which does not exist."
      rc=2
      continue
    fi
    total="$(count_tests "$f")"
    gated="$(count_tests "$f" -t "$(build_exclusion_filter "$f")")"
    quar="$(count_tests "$f" -t "$(build_inclusion_filter "$f")")"

    for entry in "${QUARANTINE[@]}"; do
      [ "${entry%%::*}" = "$f" ] || continue
      name="${entry##*::}"
      n="$(count_tests "$f" -t "$(pcre_escape "$name")")"
      if [ "$n" -eq 0 ]; then
        echo "ERROR: quarantine entry '$entry' matches no test in that file."
        echo "       A stale entry excludes nothing and hides nothing — delete it."
        rc=2
      fi
    done

    if [ "$((gated + quar))" -ne "$total" ]; then
      echo "ERROR: quarantine does not partition '$f'."
      echo "       gated=$gated + quarantined=$quar = $((gated + quar)), but the file has $total tests."
      echo "       The exclusion and inclusion filters must be exact complements;"
      echo "       a difference means tests are being dropped by both, or run by both."
      rc=2
    else
      echo "quarantine partition OK: $f -> $gated gated + $quar quarantined = $total"
    fi
  done < <(quarantine_files)
  return "$rc"
}

# --- Filter inspection (debugging) -----------------------------------------
# Print the -t filter the gate would apply to one file, and nothing at all when
# that file is unquarantined. This exists so the file-scoping property is
# directly observable rather than inferred from a 3-minute run: for any file not
# named in QUARANTINE this MUST print nothing, whatever names other entries use.
if [ "${1:-}" = "--filter-for" ]; then
  [ -n "${2:-}" ] || { echo "usage: $0 --filter-for <test file>" >&2; exit 2; }
  build_exclusion_filter "$2" && echo
  exit 0
fi

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
verify_discovery_root || exit 2
if [ ${#QUARANTINE[@]} -gt 0 ]; then
  verify_quarantine_partition || exit 2
fi

log="$(mktemp -t gantry-test-XXXXXX.log)"
trap 'rm -f "$log"' EXIT

failed=()
skipped=()
notests=()
count=0
tests_total=0
while IFS= read -r -d '' f; do
  count=$((count + 1))
  # Per-file: only this file's quarantine entries are excluded, and only when
  # it has any. build_exclusion_filter returns non-zero for an unquarantined
  # file, so the overwhelming majority of files run with no -t at all.
  file_args=()
  if filter="$(build_exclusion_filter "$f")"; then
    file_args=(-t "$filter")
  fi
  if ! bun test "$f" "${file_args[@]}" > "$log" 2>&1; then
    failed+=("$f")
    echo "::group::FAIL $f"
    cat "$log"
    echo "::endgroup::"
  else
    n="$(test_count_from_log "$log")"
    tests_total=$((tests_total + n))
    if [ "$n" -eq 0 ]; then
      # `bun test` on a file that collects zero tests exits 0 (measured, bun
      # 1.3.9). So a commit that guts a file's bodies, or an `if (false)` around
      # a describe, passes the gate and still counts toward MIN_FILES. The gate
      # counts files; this is where it also counts tests.
      notests+=("$f")
    fi
    if grep -q 'GANTRY_SKIPPED_UNBINDABLE' "$log"; then
      # A test that early-returns because it could not bind a local port passes
      # and is counted, which is indistinguishable from a real pass in suppressed
      # output. Surface it: same failure class as discovery omission.
      skipped+=("$f")
    fi
  fi
done < <(discover_tests "$DISCOVERY_ROOT")

echo "ran $count files, ${#failed[@]} failed, $tests_total tests"

# Print the failure list here, before the gate-integrity checks below, so a real
# test failure is never swallowed by a check that exits first. Exit CODES are
# ordered the other way round on purpose: integrity problems (2) win over test
# failures (1), because a gate that cannot account for its own coverage has no
# standing to report an ordinary pass/fail verdict at all.
if [ ${#failed[@]} -gt 0 ]; then
  printf 'FAILED: %s\n' "${failed[@]}"
fi

if [ ${#notests[@]} -gt 0 ]; then
  echo
  echo "ERROR: ${#notests[@]} file(s) collected ZERO tests. bun exits 0 for these, so"
  echo "       they pass the gate and count toward MIN_FILES while testing nothing:"
  printf '  NO TESTS: %s\n' "${notests[@]}"
  echo "       Delete the file or restore its tests."
  exit 2
fi

if [ ${#skipped[@]} -gt 0 ]; then
  echo
  echo "${#skipped[@]} file(s) skipped integration coverage because a local port"
  echo "could not be bound. These PASSED but tested less than they claim:"
  printf '  SKIPPED(unbindable): %s\n' "${skipped[@]}"
  # Deliberate choice: this FAILS the gate. Every CI runner and dev machine we
  # support can bind loopback, so a non-zero skip count means the environment is
  # not what the suite assumes — and a silently-skipped integration test under a
  # green tick is precisely the failure this marker was added to expose. Leaving
  # it advisory would have re-created it one level up: a NOTICE nobody opens is
  # not different from no notice.
  #
  # Set GANTRY_ALLOW_UNBINDABLE=1 to run anyway in a genuinely network-less
  # sandbox. That is an explicit, greppable decision to accept reduced coverage,
  # which is the property the default is protecting.
  if [ "${GANTRY_ALLOW_UNBINDABLE:-0}" = "1" ]; then
    echo "  (GANTRY_ALLOW_UNBINDABLE=1 — accepted, not failing)"
  else
    echo "       Set GANTRY_ALLOW_UNBINDABLE=1 to accept this explicitly."
    exit 2
  fi
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

# Same guard one level down. MIN_FILES cannot see a change that keeps every file
# but empties most of them; the per-file NO TESTS check above cannot see a file
# that drops from 40 tests to 1. Set well below the real figure — this is a
# floor against collapse, not a ratchet against ordinary churn.
#
# To update: take the "N tests" figure from the same run (current N = 5514,
# 2026-08-05) and set this comfortably below it.
MIN_TESTS=5200
if [ "$tests_total" -lt "$MIN_TESTS" ]; then
  echo "ERROR: only $tests_total tests collected across $count files, expected >= $MIN_TESTS."
  echo "       Files can pass while collecting nothing; refusing to report success."
  exit 2
fi

[ ${#failed[@]} -gt 0 ] && exit 1
exit 0
