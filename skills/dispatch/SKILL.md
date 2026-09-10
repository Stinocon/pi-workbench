---
name: dispatch
description: Calibrate effort before executing a non-trivial task. Split the request into sub-tasks, classify each against the miner-* tier rubric (low/medium/high/xhigh/max model+effort), hand the mechanical slices to parallel miner-* cloud workers, keep the correctness-critical core inline, and confirm the plan to the user before starting.
summary: the effort-dispatch classification skill (task -> tier)
---

# Dispatch — calibrated effort delegation for non-trivial requests

## Purpose

The `miner-*` workers (model+effort pinned in `~/.pi/agent/agents/`) exist to be exploited, not
admired. A non-trivial request should be split into sub-tasks, graded by difficulty, delegated
where it is independent and mechanical, and kept inline only where shared-context or
correctness should stay with the orchestrator.

Built mechanisms that go unused are pure waste. Delegating tightly-coupled work to a cold
worker can cost more than the tier it saves — that is the only legitimate reason to keep a slice
inline, and it must be stated, not used as an alibi to run everything on the main loop.

The orchestrator is the **cloud primary** agent. The `miner-*` workers run **cloud** models; the
local model is **not** a dispatch worker — it is the bounded offload target of the
`delegate` tool, not a rung on this tier ladder.

## dispatch vs delegate (do not confuse)

- **`dispatch` (this skill)** = split a **larger task** into multiple independent work units and
  run the mechanical/routine slices on parallel `miner-*` cloud workers (via the `subagent`
  tool), keeping the correctness-critical core inline.
- **`delegate` (the tool)** = offload **ONE** bounded, mechanically-verifiable subtask to a
  worker (default the draft worker; `local` is the offline fallback) and validate the result inline.

When you need one bounded draft subtask done (prose → table, a small self-contained code
function), use `delegate` to the draft worker — do not spin up a dispatch plan. A
parse/extract/enumerate need is **not** a `delegate` job at all: `grep`/`awk`/`python` do it
deterministically. When the task needs decomposition into parallel work units, use `dispatch` —
do not cram it into one `delegate` call. They are different mechanisms for different situations,
not aliases.

## Contract

- **produces:** a calibrated effort plan (task → tier/model → worker + core-inline split), confirmed with the user
- **consumes:** a non-trivial request to decompose

## Protocol — at the opening of every non-trivial request, before executing

1. **Classify.** Split the request into sub-tasks against the miner-* rubric below. Name the
   tier for each slice.

2. **Delegate.** Hand the mechanical / retrieval / routine / independent slices to the matching
   `miner-*` worker in a parallel `subagent` batch (or a chain when one depends on the last).
   Keep inline only the high-shared-context or correctness-critical core.

3. **Consider context.** If the session is long or approaching saturation, propose `/handoff`
   instead of grinding on.

4. **Confirm to the user, compactly.** task → tier/model, what is delegated, what is kept inline
   and why, context status. Then proceed.

An explicit effort request from the user overrides the rubric.

## Tier rubric

| Worker | Effort | Thinking level | Model (pin in agents/miner-*.md) | Use for |
|--------|--------|----------------|----------------------------------|---------|
| `miner-low` | low | `minimal` | `<your-fast-model>` | pure routine, retrieval, extraction, reformatting, mechanical grep/lookup |
| `miner-medium` | medium | `medium` | `<your-mid-model>` | straightforward changes, porting, docs, mid work not correctness-critical |
| `miner-high` | high | `high` | `<your-primary-model>` | code that must be correct (business logic, edge cases, error paths, parsing) — the default for real code |
| `miner-xhigh` | xhigh | `xhigh` | `<your-review-model>` | adversarial review, audit, cross-source consistency, numeric accuracy, security |
| `miner-max` | max | `max` | `<your-max-model>` | the longest, highest-stakes reasoning; only when no cheaper tier is sufficient |

## Tiers are abstract — models are concrete

A **tier** (`low`…`max`) is an abstract *difficulty / routing class*. A **model** is a concrete
provider id (`<your-fast-model>`, `<your-mid-model>`, …). The rubric maps a tier to a `miner-*`
**worker**, and each worker's frontmatter (`agents/miner-*.md`) pins the concrete `model:` to
run. You route by tier; the worker file supplies the model.

Never hand a tier name to the `delegate` tool. `delegate` requires a concrete model id (list
them with `delegate` and no `model`). `high` → `miner-high` is a *worker* name, not a model id.
The model ids in this table are placeholders — edit `agents/miner-*.md` to pin your own, and
trust the worker file, not memory.

## Dispatch rules

- **Do not use a stronger tier when a weaker one suffices.** Mechanical work does not run on a
  frontier model — efficiency outranks symmetry ("do not use miner-max when less will do").
- **Correctness-critical work does not drop below `miner-high`.** A wrong number or broken edge
  case produced cheaply is not cheap.
- **Classify asymmetric: when in doubt, go one tier up, not one tier down.** Savings are safe only
  when the slice truly belongs to the tier it is sent to. If a slice's difficulty is uncertain,
  route it to the higher of the two plausible tiers — the costly error is misrouting *downward*
  (a degraded, reworked result), not a few spare tokens *upward*. `miner-low` is strictly for work
  you can point to as mechanical.
- **Model is overridable at use-time.** The pin is a default keyed on difficulty. If what matters
  is a model's specific competence (language, domain, output shape) rather than difficulty,
  override it for that call.
- **Parallel fan-outs over shared files run with care.** After a parallel batch, read each real
  diff, merge deliberately, and run the gate once on the integrated result — a green worker does
  not mean the combination is green. Do not leave a worker's file referencing keys or data not
  written elsewhere.
- **A tool's system prompt is the contract.** Each worker already carries its tier's mandates
  (miner-low: no design decisions; miner-high: correctness from line one; miner-xhigh: adversarial;
  miner-max: first principles, honest). Delegate accordingly, don't restate.

## Delegation

Use the `subagent` tool with a `tasks` array for parallel batches, or `chain` for sequential
dependencies (`{previous}` paste), or `agent` + `task` for a single delegated slice.

```text
scout/analyze/retrieve  -> miner-low (or miner-medium)
implement code          -> miner-high
port/reformat/simple    -> miner-medium
adversarial review      -> miner-xhigh
hardest reasoning       -> miner-max
```

## Domain workers (different axis: domain, not difficulty)

The `miner-*` ladder classifies by *difficulty*. A **domain worker** classifies by *bounded
domain* with self-contained output: it carries a distilled skill as its system prompt and a
model/thinking level tuned to that domain. Use one only when the task is well-bounded and needs
no live session/tool state — never for tool-heavy, tightly-coupled work (e.g. smart-home control
stays inline; a cold worker lacks the live MCP tools and charged skill context).

Current domain workers:
- `repo-builder` — repository scaffolding / publication hygiene (LICENSE, README, NOTICE.md,
  .gitignore, doc-sync, pre-publish scan). Escalates license changes and publish decisions to
  the user.

A domain worker is a probe, not a fixture: if it is not being cited by actual use, remove it.

## Close

Every dispatch closes the same way: inspect the real diffs from the workers, integrate
deliberately, **then run the comprehensive doc-sync sweep (HARD RULE — see `coding-standards`)**
to align every doc affected by the change, in the same commit, and run the project's gate green
before commit/push. A worker's self-report is a PR to review, not a verdict.