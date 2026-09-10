---
name: systematic-debugging
description: "Root-cause-first debugging protocol. Use when encountering any bug, test failure, or unexpected behavior — before proposing any fix. Four phases: investigate root cause, analyze the pattern, form and test ONE hypothesis, implement with a failing test. Includes backward tracing through the call stack and the 3-fixes-then-question-the-architecture rule."
summary: 4-phase root-cause debugging (no fixes without investigation)
---

# Systematic debugging — root cause before fixes

Symptom fixes are failure. The single rule that matters:

```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

If you have not completed Phase 1, you cannot propose a fix. This is the same spirit as
`coding-standards` ("falsify, do not confirm", "after two rounds go structural") but as a
concrete protocol, not a principle.

Use this for ANY technical issue — test failures, production bugs, unexpected behavior,
performance problems, build failures, integration issues — and **especially** when under time
pressure (emergencies make guessing tempting), when "just one quick fix" seems obvious, or when
a previous fix did not work. Simple bugs have root causes too; systematic is faster than
thrashing.

## Phase 1 — Root cause investigation (before any fix)

1. **Read the error carefully.** Do not skip past errors or warnings; read the stack trace
   completely; note line numbers, file paths, error codes. They often contain the exact answer.
2. **Reproduce consistently.** Can you trigger it reliably? Exact steps? Every time? If not
   reproducible, gather more data — do not guess.
3. **Check recent changes.** Git diff, recent commits, new dependencies, config changes,
   environment differences.
4. **Gather evidence at component boundaries.** In a multi-component system (CI → build →
   signing; API → service → database), do not guess which layer breaks — instrument each
   boundary: log what enters, what exits, and the config/environment at each layer, run once,
   and let the evidence name the failing component before you investigate it.
5. **Trace data flow backward.** Where does the bad value originate? What called this with that
   value? Keep tracing up until you find the source. **Fix at the source, never at the symptom.**

### Backward tracing

When the error appears deep in the call stack, your instinct is to fix where it appears — that is
the symptom. Trace one level up at a time:

```
symptom:  git init failed in ~/project/packages/core
cause:    execFileAsync('git', ['init'], { cwd: projectDir })
← called by WorktreeManager.createSessionWorktree(projectDir)
← called by Session.create()
← called by the test at Project.create()
value:    projectDir = ''  → empty cwd resolves to process.cwd()
trigger:  context.tempDir accessed before beforeEach set it
```

If you cannot trace manually, add instrumentation **before** the dangerous operation (in tests
use `console.error`, not a logger that may be suppressed), capture the stack
(`new Error().stack`), run, and read the frames.

## Phase 2 — Pattern analysis

Before fixing, find the pattern:

- **Find working examples** of similar code in the same codebase. What works that resembles what
  is broken?
- **Compare against the reference** — if implementing a known pattern, read the reference
  implementation completely, not skimmed.
- **List every difference** between working and broken, however small. Do not assume "that can't
  matter".
- **Map dependencies** — what settings, config, environment, or assumptions does this need?

## Phase 3 — Hypothesis and minimal test

Scientific method, one variable at a time:

1. **Form ONE hypothesis**, stated specifically: "I think X is the root cause because Y." Write
   it down.
2. **Test minimally** — the smallest possible change to test it. Do not fix multiple things at
   once.
3. **Verify before continuing** — worked → Phase 4; did not → form a NEW hypothesis, do not stack
   another fix on top.
4. **When you do not know**, say "I do not understand X" — do not pretend to know.

## Phase 4 — Implementation

1. **Write a failing test first** — the simplest reproduction, automated where possible, a one-off
   script otherwise. It must exist before the fix. (Use the `test-driven-development` skill.)
2. **One single fix**, addressing the root cause. No "while I'm here" improvements, no bundled
   refactoring.
3. **Verify** — the test passes, no other tests broke, the issue is actually resolved. Then and
   only then claim success (`coding-standards`: verify what the user sees — a fix confirmed
   against a dev server or a self-report is not confirmed; rebuild/restart what the user actually
   looks at).
4. **If it does not work, count the fixes.** < 3 → return to Phase 1 with the new information.
   **≥ 3 → stop and question the architecture**, do not attempt fix #4.

### Three failed fixes = the architecture, not the parameters

This is the same rule as `coding-standards` "after two rounds of tuning, go structural". If each
fix reveals new shared state / coupling in a different place, if fixes require "massive
refactoring", or if each fix spawns new symptoms elsewhere, the mechanism is wrong for the
context. Stop and discuss fundamentals with the user rather than continuing to fix symptoms.

## Red flags — stop and return to Phase 1

- "Quick fix for now, investigate later" · "just try changing X and see"
- "It's probably X, let me fix that" (proposing solutions before tracing data flow)
- "I'll skip the test, I'll verify manually" · "add multiple changes, run tests"
- "One more fix attempt" when you have already tried 2+

All of these mean the same thing: you are guessing, not debugging. Return to Phase 1.

## If investigation finds no root cause

Complete the process first (95% of "no root cause" cases are incomplete investigation). If it is
genuinely environmental / timing-dependent / external: document what was investigated, implement
appropriate handling (retry, timeout, error message), and add monitoring for the next time.

## Contratto

- **produces:** a root cause (or a documented "external/timing" conclusion) plus a minimal, tested fix
- **consumes:** any bug, test failure, or unexpected behavior
- **delegates to:** `test-driven-development` for the failing test; `coding-standards` for the honesty/gate rules

## Provenienza

Idea distilled from `obra/superpowers` `systematic-debugging` (four phases, backward tracing) and
integrated with the existing `coding-standards` rules ("falsify", "after two rounds go
structural", "verify what the user sees") — no code copied.
