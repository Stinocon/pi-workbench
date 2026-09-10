---
name: delegate
description: "Cloud-first worker offload. The cloud primary agent offloads ONE bounded, verifiable subtask to a worker and validates the result inline. Default worker is the configured draft tier (a cheap, fast model) for prose → structured table/summary and small self-contained code drafts, always reviewed cell-by-cell; the configured local worker is the offline fallback. Never for deterministic extraction/enumeration/sort (grep/awk/python do those), analytical reconciliation, reasoning, security, infrastructure writes, or ambiguous work."
summary: bounded worker offload (cloud primary → draft worker / local fallback / cloud escalation)
---

# Delegate — bounded worker offload (cloud-first)

## Purpose

You are the **cloud primary** agent. Worker models are optional **bounded targets** for simple,
verifiable subtasks — they are **not** a reasoning authority and **not** a fallback for complex
or risky work. `delegate` sends ONE bounded subtask to a worker and returns the result inline, so
you can validate it and continue.

Three targets, in order of preference:

1. **`draft` (draft tier, default)** — a cheap, fast model you configure as the draft worker in
   `~/.pi/agent/workers.json` (see `workers.example.json`). For prose → structured table/summary
   and small self-contained code drafts.
2. **`local` (offline fallback)** — a local model configured as the offline fallback in
   `workers.json`. Weaker results; only for prose → table/summary when the draft worker is
   unavailable.
3. **cloud id** — a concrete cloud model (e.g. `<your-cloud-model>`) for a rare, justified
   escalation when a single subtask needs reasoning beyond the primary.

This is **not** a model switch, and it is **not** `dispatch`. `dispatch` decomposes a larger task
into parallel `miner-*` cloud workers. `delegate` is a single bounded task to a single worker.

## Routing policy (decide before offloading)

**Keep on CLOUD (yourself):**

- security-sensitive reasoning (assessment, threat modeling, authN/authZ, crypto, incident decisions)
- smart-home / infrastructure writes: modifying automations/scripts/scenes/dashboards/helpers, renaming entities
- complex code modification, architecture/design, security review
- ambiguous tasks, multi-component interactions, correctness-over-speed work
- cross-file / multi-source reconciliation (entity-ID or config consistency across firmware +
  config + docs): looks mechanical but worker models misclassify domains and miss entities
- destructive operations, external side effects, production systems

**MAY offload to the DRAFT worker (`model: "draft"`):**

- prose → structured table/summary (e.g. a troubleshooting doc into a symptom/cause/fix table)
- small self-contained code drafts (boilerplate, parsers, transformers — a function, not a system)
- both ONLY when genuinely faster than doing it yourself. Treat the output as a DRAFT to review
  cell-by-cell — never as final.

**LOCAL worker (`model: "local"`) — offline fallback ONLY:**

- prose → table/summary when the draft worker is rate-limited or unreachable. Same DRAFT rule.

**Do NOT offload to ANY worker (no LLM at all):**

- parsing, enumeration, string extraction, simple lookup, sorting, filtering → `grep`/`awk`/`jq`/
  `python` do it deterministically at zero cost and zero error; an LLM adds error, not value.
- YAML/JSON/XML parsing, entity/state enumeration, cross-file / multi-source reconciliation,
  section→domain mapping → empirically unreliable on every cheap worker. Keep on CLOUD or
  escalate to a cloud model via `delegate`.

Offload only when **all** hold: LLM-appropriate (draft, not deterministic) **and** bounded **and**
verifiable **and** genuinely faster than doing it by hand. **Uncertainty → CLOUD.**

## Draft delegation contract

When offloading to the draft worker, provide:

1. `objective` — the single bounded question.
2. `context` / `files` — the minimum data (relevant excerpts), never the whole repo/conversation.
3. `expectedOutput` — the exact shape of the result.
4. `constraints` — hard limits AND what the worker must NOT decide.

Example:

```text
delegate(
  model = "draft",
  objective = "Convert this troubleshooting doc into a symptom/cause/fix table",
  files = [ { path = "TROUBLESHOOTING.md", excerpt = "…" } ],
  constraints = ["do not modify anything", "do not invent entries not in the doc"],
  expectedOutput = "a markdown table with one row per problem",
)
```

## Validate the worker result (never trust blindly)

For every offload, classify verifiability:

- **directly verifiable** — compare against source (e.g. entity list vs YAML, JSON vs schema,
  run the generated code against test cases).
- **partially verifiable** — verify what you can; flag the rest.
- **not independently verifiable** — do the task yourself on CLOUD rather than accept an
  unverifiable claim.

If the result is ambiguous or wrong, do **not** retry the worker indefinitely. Do the task
yourself on CLOUD. Retries are bounded (0–1).

```text
worker failure → CLOUD takeover      (never worker → worker → … loop)
```

## Draft worker unavailable (credit exhausted / rate limited)

The draft tier is meant to degrade gracefully:

1. On **402 (credit exhausted)** / **429 (rate limit)** / auth failure, the tool returns a
   clear error — do the task inline on CLOUD (or `local` for prose→table).
2. **Never auto-retry the draft worker in a loop** — rate-limit windows are real, and the
   agent's own retries already amplify pressure. Space offloads; do not burst them.
3. **Privacy rule:** if the draft provider's plan trains on your inputs, never delegate content
   containing private/client data to it — only non-sensitive draft material. Check the
   provider's data policy before relying on it for anything sensitive.

## Empirical notes (verified, general pattern)

- **Deterministic extraction fails on cheap models.** A filter+sort task over a catalog came
  back wrong in two different ways from a cheap model — run 1 dropped rows (unrequested dedup);
  run 2 kept all rows but added false positives and ignored the sort entirely. Both runs: zero
  invented values, zero field errors. Verdict: extraction/enumeration/sort is not an LLM task —
  `grep`/`awk`/`python` only.
- **Draft models work where they should.** Prose→table came back correct with zero invention,
  and a small self-contained function draft passed its test cases on the first try. The draft
  tier is for prose→structure and small drafts — nothing else.
- **Local models are slow and weaker.** Expect minutes per call; never worth it for anything
  `grep`/`awk` answers. They can reproduce sections verbatim yet still drop the single most
  critical instruction and add small extrapolations — review every cell.
- **The bottleneck is the instruction class, not the specific model.** Cheap models do not
  reliably follow multi-clause deterministic instructions. That is why deterministic work stays
  with deterministic tools, at zero cost and zero error.

## Routing rule (the invariant)

The default offload target is the **draft worker** for prose → structured table/summary and
small self-contained code drafts, always reviewed. The local worker remains the offline
fallback only. Deterministic extraction/enumeration/sort is **never** an LLM task —
`grep`/`awk`/`python` only — because cheap models fail it while deterministic tools get it
right at zero cost. The cloud escalation path via `delegate` covers everything analytical.

## Data minimization (hard rule)

The worker receives **only** your brief — never the conversation, repository, unrelated files,
MCP state, environment variables, or credentials. Send relevant excerpts, not whole files. The
tool screens the brief before sending (definite secrets → refusal; probable spans → redaction).

## Permissions / isolation

Workers are tool-free by default (pure analysis of the brief). `allowRead: true` grants only
`read, ls, find, grep, glob` — never `bash`/`write`/`edit`/MCP/network. The worker can never
modify anything; you always apply the result yourself.

## Escalation to a stronger cloud model

`delegate` also accepts a concrete cloud model id (e.g. `<your-cloud-model>`) for a rare,
justified escalation when a single subtask needs reasoning beyond the primary. `model` is a
concrete id — `draft`, `local`, or a cloud catalog id — never a dispatch tier (`low…max`) or a
`miner-*` name. List targets with `delegate` and no `model`.

## Failure handling

The tool returns a clear error instead of pretending to succeed: unknown target, auth failure,
402 (credit exhausted), 429 (rate limit), timeout, empty output, oversized brief, or refusal.
On any worker failure, do the task yourself on CLOUD (or `local` for prose→table). A missing
cloud provider is a signal to report clearly — never silently fall back to a weaker worker for
complex work.

## Token economy

Keep the brief small: a good offload is a few hundred to a few thousand tokens. If the brief
keeps growing, you are doing the exploration you should have done yourself.
