#!/usr/bin/env bash
# check-config-docs.sh — READ-ONLY consistency gate between the docs and the real dirs.
#
# README.md (structure tree + "Global skills" section) and docs/FRESH_START.md enumerate
# skills/extensions/agents by hand. When a skill/extension/agent is added or renamed without
# updating those lists, they silently drift — a fresh machine restored from FRESH_START.md
# would miss entries, and the README would describe a superseded state. This script
# cross-checks the docs against the directories and exits nonzero on any mismatch, so drift
# is observable (run by poll-sync.sh into the drift report) instead of discovered by hand.
#
# Read-only: never modifies anything.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR" || exit 2

fail=0
bad() { printf '    - DRIFT: %s\n' "$*"; fail=1; }

# --- actual sets (the single source of truth) ----------------------------
real_skills=$(for d in skills/*/;   do basename "$d"; done | sort -u)
real_ext=$(for f in extensions/*.ts; do [ -e "$f" ] && basename "$f" .ts; done | sort -u)
real_extdirs=$(for d in extensions/*/; do [ -e "${d}index.ts" ] && basename "$d"; done | sort -u)
real_agents=$(for f in agents/*.md; do [ -e "$f" ] && basename "$f" .md; done | sort -u)

# --- what the README declares (tree + prose) -----------------------------
# Tree sections are bounded, so a nested extension directory (`── plan-mode/`)
# is not mistaken for a skill.
agents_block=$(sed -n '/^agents\//,/^extensions\/$/p' README.md)
ext_block=$(sed -n '/^extensions\/$/,/^subagent\//p' README.md)
skills_block=$(sed -n '/^skills\/$/,/^```/p' README.md)

tree_skills=$(echo "$skills_block" | grep -oE '── [a-z0-9-]+/' | sed -E 's/── ([a-z0-9-]+)\//\1/' | sort -u)
tree_ext=$(echo "$ext_block" | grep -oE '── [a-z0-9-]+\.ts' | sed -E 's/── ([a-z0-9-]+)\.ts/\1/' | sort -u)
tree_extdirs=$(echo "$ext_block" | grep -oE '── [a-z0-9-]+/' | sed -E 's/── ([a-z0-9-]+)\//\1/' | sort -u)
tree_agents=$(echo "$agents_block" | grep -oE '── [a-z0-9-]+\.md' | sed -E 's/── ([a-z0-9-]+)\.md/\1/' | sort -u)
prose_skills=$(sed -n '/^## Global skills/,/^## /p' README.md | sed '$d' \
  | grep -oE '^- \*\*[a-z0-9-]+\*\*' | sed -E 's/^- \*\*([a-z0-9-]+)\*\*/\1/' | sort -u)

echo "config-doc consistency:"

for s in $real_skills; do
  echo "$tree_skills"  | grep -qx "$s" || bad "README tree: skill '$s' not listed"
  echo "$prose_skills" | grep -qx "$s" || bad "README 'Global skills': '$s' not described"
done
for s in $tree_skills; do
  echo "$real_skills" | grep -qx "$s" || bad "README tree lists non-existent skill '$s'"
done
for s in $prose_skills; do
  echo "$real_skills" | grep -qx "$s" || bad "README 'Global skills' describes non-existent '$s'"
done
for e in $real_ext; do
  echo "$tree_ext" | grep -qx "$e" || bad "README tree: extension '$e.ts' not listed"
done
for e in $tree_ext; do
  echo "$real_ext" | grep -qx "$e" || bad "README tree lists non-existent extension '$e.ts'"
done
for e in $real_extdirs; do
  echo "$tree_extdirs" | grep -qx "$e" || bad "README tree: extension dir '$e/' not listed"
done
for e in $tree_extdirs; do
  echo "$real_extdirs" | grep -qx "$e" || bad "README tree lists non-existent extension dir '$e/'"
done
for a in $real_agents; do
  echo "$tree_agents" | grep -qx "$a" || bad "README tree: agent '$a.md' not listed"
done
for a in $tree_agents; do
  echo "$real_agents" | grep -qx "$a" || bad "README tree lists non-existent agent '$a.md'"
done

if grep -qE 'for s in .*; do' docs/FRESH_START.md; then
  bad "docs/FRESH_START.md hardcodes a skills loop — use 'cp -r skills/*/'"
fi
if ! grep -qE 'cp -r skills/\*/' docs/FRESH_START.md; then
  bad "docs/FRESH_START.md does not restore skills via glob 'cp -r skills/*/'"
fi

if [ "$fail" = 1 ]; then
  echo ">>> DOC DRIFT — fix the doc (or the directory), then re-run: bash scripts/check-config-docs.sh"
  exit 1
fi
echo "  OK: docs and directories are consistent."
exit 0
