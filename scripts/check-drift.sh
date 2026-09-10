#!/usr/bin/env bash
# check-drift.sh — READ-ONLY drift scan across the git repos under a base tree.
#
# For each git repo reports: branch, dirty tracked+untracked files, staged changes,
# unpushed commits (ahead), behind upstream, and missing upstream tracking.
# Exits 0 if nothing is out of sync, nonzero if any repo is dirty, staged, or ahead
# (has content GitHub does not yet have).
#
# This is deliberately read-only and NEVER commits/pushes. Development repos carry
# intentional WIP; reconciling them is a deliberate, gate-approved decision. The
# point of this scanner is to make "content drift" observable, not to auto-fix it.
#
# Scope default: $HOME (git-managed, GitHub-publishable repos).
# Override with DRIFT_BASE, or pass explicit repo paths as arguments.
set -uo pipefail

BASE="${DRIFT_BASE:-$HOME}"

declare -a REPOS=()
if [ "$#" -gt 0 ]; then
	REPOS=("$@")
else
	for d in "$BASE"/*/; do
		[ -d "$d" ] || continue
		[ -d "$d/.git" ] || continue   # skip non-git dirs
		REPOS+=("${d%/}")
	done
fi

drift=0
for repo in "${REPOS[@]}"; do
	name="$(basename "$repo")"
	[ -d "$repo/.git" ] || continue
	if ! git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1; then continue; fi

	br=$(git -C "$repo" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")

	staged=0 dirty_t=0 untracked=0 ahead=0 behind=0 nousp=0
	git -C "$repo" diff --cached --quiet 2>/dev/null || staged=1
	while IFS= read -r line; do
		[ -z "$line" ] && continue   # empty here-string line from empty status
		case "$line" in
			"?? "*) untracked=$((untracked+1)) ;;
			*) dirty_t=$((dirty_t+1)) ;;
		esac
	done <<< "$(git -C "$repo" status --porcelain 2>/dev/null)"

	if upstream=$(git -C "$repo" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null); then
		ahead=$(git -C "$repo" rev-list --count "@{upstream}..HEAD" 2>/dev/null || echo 0)
		behind=$(git -C "$repo" rev-list --count "HEAD..@{upstream}" 2>/dev/null || echo 0)
	else
		# auto upstream for default push target, if any
		tgt=$(git -C "$repo" rev-parse --abbrev-ref '@{push}' 2>/dev/null) && {
			ahead=$(git -C "$repo" rev-list --count "@{push}..HEAD" 2>/dev/null || echo 0)
		} || nousp=1
	fi

	flag="OK"
	# hard drift = content GitHub does not yet have: modified tracked file, staged, or unpushed
	if [ "$dirty_t" -gt 0 ] || [ "$staged" = 1 ] || [ "${ahead:-0}" != 0 ]; then
		drift=1; flag="DRIFT"
	else
		[ "$untracked" -gt 0 ] && flag="UNTRACKED"
	fi

	echo "${flag}  ${name}  branch=${br}  mod=${dirty_t} staged=${staged} untracked=${untracked} ahead=${ahead} behind=${behind}$([ "$nousp" = 1 ] && echo ' no-upstream') | $(git -C "$repo" status --porcelain 2>/dev/null | tr '\n' ';')"
done

if [ "$drift" = 1 ]; then
	echo ""
	echo ">>> DRIFT FOUND: one or more repos have content GitHub does not have yet."
	echo "    Reconcile deliberately (these are dev repos with intentional WIP)."
	exit 1
fi
exit 0