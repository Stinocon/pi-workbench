---
name: test-driven-development
description: Strict red-green-refactor protocol. Use when implementing any feature or bugfix — write the failing test first, watch it fail, write the minimal code to pass, refactor only after green. Use before writing implementation code. Complements the testing section of coding-standards with the concrete cycle.
summary: TDD red-green-refactor (failing test before production code)
---

# Test-driven development — red, green, refactor

Write the test first. Watch it fail. Write the minimal code to pass. Refactor only when green.

The core principle: **if you did not watch the test fail, you do not know if it tests the right
thing.** This is the concrete cycle behind the `coding-standards` testing section (which says
"add tests when changing non-trivial behaviour" but does not pin the cycle).

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

Wrote code before the test? Delete it and start over — no "keep as reference", no "adapt it
while writing tests". Implement fresh from the test.

## When to use

Always: new features, bug fixes, refactoring, behavior changes.

Exceptions (only with the user's explicit agreement): throwaway prototypes, generated code,
configuration files. "Skip TDD just this once" is rationalization.

## The cycle

### RED — write the failing test

One minimal test showing what should happen: one behavior, a clear name, real code (mocks only
when unavoidable). A vague name or a test that asserts on mock behavior does not count.

### Verify RED — watch it fail

Run it. Confirm it fails for the right reason (feature missing), not a typo, not an error in the
test itself. If it passes, you are testing existing behavior — fix the test. If it errors, fix
the error until it fails correctly. This step is mandatory; skipping it is the same as not doing
TDD.

### GREEN — minimal code

The simplest code that makes the test pass. No features beyond the test, no refactoring of other
code, no "while I'm here" improvements, no speculative options/parameters (YAGNI).

### Verify GREEN — watch it pass

Run it. Confirm the test passes, the other tests still pass, and the output is clean. Test fails?
Fix the code, not the test. Other tests broke? Fix them now.

### REFACTOR — only after green

Remove duplication, improve names, extract helpers. Keep the tests green and add no behavior.

Then the next failing test for the next behavior.

## Good vs bad tests

| | Good | Bad |
|---|---|---|
| Minimal | one thing; "and" in the name → split it | one test covering five cases |
| Clear | name describes the behavior | `test('test1')` |
| Intent | demonstrates the desired API | obscures what the code should do |
| Honest | asserts real behavior | asserts on mock behavior |

Before writing a test, name the production change that would make it fail. A test you cannot
describe that way tests nothing.

## Bug fixes

A bug found is a missing test: write the failing test that reproduces the bug, watch it fail,
then fix. The test both proves the fix and prevents regression. Never fix a bug without a test.

## Common rationalizations (all wrong)

- "Too simple to test" — simple code breaks too; the test takes 30 seconds.
- "I'll test after" — a test written after passes immediately, which proves nothing: it may test
  the implementation instead of the behavior, or miss the edge case you forgot.
- "Already manually tested" — manual testing is ad-hoc, has no re-runnable record, and is easy to
  forget under pressure.
- "Keep as reference, write tests first" — you will adapt it; that is testing after. Delete means
  delete.
- "TDD will slow me down" — the shortcut is debugging in production, which is slower.

## When stuck

| Problem | It usually means |
|---|---|
| Don't know how to test | Write the wished-for API; write the assertion first |
| Test too complicated | The design is too complicated — simplify the interface |
| Must mock everything | The code is too coupled — use dependency injection |
| Test setup is huge | Extract helpers; if still complex, simplify the design |

A hard-to-test interface is a hard-to-use interface: the test is telling you something about the
design, not about the test.

## Verification checklist

Before marking work complete, every box:

- [ ] Every new function/method has a test
- [ ] Each test was watched failing before implementation, for the expected reason
- [ ] Minimal code written to pass each test (no YAGNI creep)
- [ ] All tests pass, output clean (no errors/warnings)
- [ ] Real code tested; mocks only where unavoidable
- [ ] Edge cases and error paths covered

Cannot tick all boxes? You skipped TDD. Start over.

In Python projects the test command runs through `uv` (`uv run pytest …`), per
`coding-standards` — never a bare `python`/`pytest` that runs a different environment.

## Contratto

- **produces:** tested behavior — each production change backed by a test that failed first
- **consumes:** a feature or bugfix to implement
- **delegates to:** `systematic-debugging` when a failure needs root-causing before a test can be written; `coding-standards` for what to test and the skip-vs-pass rule

## Provenienza

The red-green-refactor cycle follows the standard TDD discipline (failing test first, minimal
code to pass, refactor after green), aligned with the `coding-standards` testing rules
(behavior not implementation, skip-vs-pass, `uv` runner) — no external code copied.
