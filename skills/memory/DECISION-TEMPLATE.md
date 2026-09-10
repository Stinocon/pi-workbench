---
id: DEC-0000
type: decision            # decision | invariant | constraint
status: proposed          # proposed | validated | superseded | deprecated | temporary | unknown
scope: project            # project | global
statement: <one-line statement of the decision / invariant / constraint>
reason: <why this was decided; the rationale that must not be lost>
evidence:                 # L0 pointers, relative to the project root (or absolute)
  - docs/architecture.md
  - src/example.py
authority: high           # high | medium | low
mutable: false            # false = protected once validated (append-only, supersede to change)
verify: read              # auto | read | human
verify_anchor: "example"  # for read: text/symbol that must appear in evidence; for auto: optional output match
# verify_command: "grep -q example src/example.py"   # REQUIRED when verify: auto (read-only, deterministic)
created: 2026-09-08
validated_at: 2026-09-08
supersedes: null          # id of the decision this one replaces (set only in a NEW file)
---

# DEC-0000 — <short title>

## Statement

<The decision in one sentence — already in `statement`, expanded here if needed.>

## Reason

<Why. The reasoning that must survive the session.>

## Context / relations

<Optional: what this depends on, what it affects, other decisions it relates to.>

## Evidence

<Optional prose expansion of the `evidence` pointers: what to check to confirm this is still true.>
