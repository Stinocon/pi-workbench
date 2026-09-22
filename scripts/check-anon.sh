#!/usr/bin/env bash
# check-anon.sh — this repo's anon integration must be byte-identical to the live one.
#
# The guard, the skill and the runtime harness exist in three places: the live Pi config
# (~/.pi/agent/), the pi-customization repo, and this distribution repo. A distribution that drifts
# from the runtime is worse than no distribution: it ships a guard that is not the guard, and the
# difference is exactly what nobody re-reads. Comparing sha256 is the cheapest thing that cannot be
# argued with.
#
#   bash scripts/check-anon.sh          # compare (exit 1 on drift) — the gate
#   bash scripts/check-anon.sh --write  # copy the live files in
#
# The engine itself is NOT copied: it lives in the anon-tool repository and is installed at ~/.anon/.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIVE_PI="${LIVE_PI:-$HOME/.pi/agent}"
CANON_REPO="${CANON_REPO:-$DIR/../pi-customization}"
WRITE=0
[ "${1:-}" = "--write" ] && WRITE=1

declare -a PAIRS=(
  "extensions/anon-guard.ts:$LIVE_PI/extensions/anon-guard.ts"
  "skills/anon/SKILL.md:$LIVE_PI/skills/anon/SKILL.md"
  "scripts/check-anon-guard.cjs:$CANON_REPO/scripts/check-anon-guard.cjs"
)

drift=0
unverified=0
for pair in "${PAIRS[@]}"; do
  here="${pair%%:*}"
  there="${pair#*:}"
  if [ ! -f "$there" ]; then
    echo "SKIP  $here — canonical file not found at $there"
    unverified=$((unverified + 1))
    continue
  fi
  if [ "$WRITE" = "1" ]; then
    cp "$there" "$DIR/$here" && echo "WROTE $here <- $there"
    continue
  fi
  if [ "$(shasum -a 256 "$DIR/$here" | awk '{print $1}')" = "$(shasum -a 256 "$there" | awk '{print $1}')" ]; then
    echo "OK    $here"
  else
    echo "DRIFT $here  (differs from $there)"
    drift=$((drift + 1))
  fi
done

if [ "$WRITE" = "0" ]; then
  if [ ! -f "$HOME/.anon/anon.py" ]; then
    echo "NOTE  the engine is not installed at ~/.anon/anon.py — the guard fails open with a visible"
    echo "      indicator without it. Install the anon-tool repository (see skills/anon/SKILL.md)."
  fi
  if [ "$drift" -gt 0 ]; then
    echo "check-anon: $drift file(s) drifted from the live config — run: bash scripts/check-anon.sh --write"
    exit 1
  fi
  if [ "$unverified" -gt 0 ]; then
    echo "check-anon: $unverified file(s) could not be compared (not a silent pass — see SKIP above)"
  fi
  echo "check-anon: the local copy matches the live config"
fi
