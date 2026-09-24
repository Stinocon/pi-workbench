---
name: delegate
description: "Cloud-first worker offload. The cloud primary agent offloads ONE bounded, verifiable subtask to a worker and validates the result inline. Default worker is the Mistral draft tier (codestral-latest) for prose → structured table/summary and small self-contained code drafts, always reviewed cell-by-cell; the local MTPLX/Qwen worker is the offline fallback. Never for deterministic extraction/enumeration/sort (grep/awk/python do those), analytical reconciliation, reasoning, security, HA writes, or ambiguous work."
summary: bounded worker offload (cloud primary → Mistral draft / local fallback / cloud escalation)
---

# Delegate — bounded worker offload (cloud-first)

## Purpose

You are the **cloud primary** agent. Worker models are optional **bounded targets** for simple,
verifiable subtasks — they are **not** a reasoning authority and **not** a fallback for complex
or risky work. `delegate` sends ONE bounded subtask to a worker and returns the result inline, so
you can validate it and continue.

Three targets, in order of preference:

1. **`mistral` (draft tier, default)** — `codestral-latest` on the user's Mistral account. For
   prose → structured table/summary and small self-contained code drafts. Cheap (~$0.0007/call).
2. **`local` (offline fallback)** — MTPLX/Qwen 3.5 9B, free and local. Weaker results; only for
   prose → table/summary when Mistral is unavailable.
3. **cloud id** — a concrete OpenCode Go model (e.g. `deepseek-v4-pro`) for a rare, justified
   escalation when a single subtask needs reasoning beyond the primary.

This is **not** a model switch, and it is **not** `dispatch`. `dispatch` decomposes a larger task
into parallel `miner-*` cloud workers. `delegate` is a single bounded task to a single worker.

## Routing policy (decide before offloading)

**Keep on CLOUD (yourself):**

- security-sensitive reasoning (assessment, threat modeling, authN/authZ, crypto, incident decisions)
- Home Assistant writes: modifying automations/scripts/scenes/dashboards/helpers, renaming entities
- complex code modification, architecture/design, security review
- ambiguous tasks, multi-component interactions, correctness-over-speed work
- cross-file / multi-source reconciliation (entity-ID or config consistency across firmware +
  config + docs): looks mechanical but worker models misclassify domains and miss entities
- destructive operations, external side effects, production systems

**MAY offload to the MISTRAL draft worker (`model: "mistral"`):**

- prose → structured table/summary (e.g. a troubleshooting doc into a symptom/cause/fix table)
- small self-contained code drafts (boilerplate, parsers, transformers — a function, not a system)
- prose → structure is MANDATORY, not a judgement call: `offload-rules.json` carries it as a standing
  directive, because a conversion done inline is a conversion nobody reviewed. Treat the output as a
  DRAFT to review cell-by-cell; the other rows are still only worth it when genuinely faster.
  cell-by-cell — never as final.

**LOCAL worker (`model: "local"`) — offline fallback ONLY:**

- prose → table/summary when Mistral is rate-limited or unreachable. Same DRAFT rule.

**Do NOT offload to ANY worker (no LLM at all):**

- parsing, enumeration, string extraction, simple lookup, sorting, filtering → `grep`/`awk`/`jq`/
  `python` do it deterministically at zero cost and zero error; an LLM adds error, not value.
  (Empirically reproduced on codestral-latest too, see Empirical notes.)
- YAML/JSON/XML parsing, entity/state enumeration, cross-file / multi-source reconciliation,
  section→domain mapping → empirically unreliable on every cheap worker. Keep on CLOUD or
  escalate to a cloud model via `delegate`.

Offload only when **all** hold: LLM-appropriate (draft, not deterministic) **and** bounded **and**
verifiable **and** genuinely faster than doing it by hand. **Uncertainty → CLOUD.**

## Mistral draft delegation contract

When offloading to the Mistral draft worker, provide:

1. `objective` — the single bounded question.
2. `context` / `files` — the minimum data (relevant excerpts), never the whole repo/conversation.
3. `expectedOutput` — the exact shape of the result.
4. `constraints` — hard limits AND what the worker must NOT decide.

Example:

```text
delegate(
  model = "mistral",
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

## Mistral credit exhaustion → free tier (graceful degradation)

The Mistral tier is designed to keep working when the €10 pay-as-you-go credit runs out:

1. **Switch the Mistral workspace to the "Experiment" free tier** in the console. Same API key,
   same endpoint, same model ids — **no change in Pi config**.
2. The free tier covers the model range but with **tighter rate limits** (~1 req/s,
   ~500k tokens/min, ~1B tokens/month — live numbers in Admin Console → Limits win) and
   **training consent**: on the free tier your inputs may be used to train models.
3. **Privacy rule:** while on the free tier, never delegate content containing private/client
   data to Mistral — only non-sensitive draft material. (The pay-as-you-go plan does not train
   on your data.)
4. On **402 (credit exhausted)** / **429 (rate limit)** the tool returns a clear error; do the
   task inline on CLOUD (or `local` for prose→table). Never auto-retry the Mistral worker in a
   loop — the 429 recovery window is ~90 s and pi's own retries already amplify rate-limit
   pressure.

## Empirical notes (verified, 2026-08 / 2026-09)

- **`allowRead` path redaction — FIXED in `delegate.ts`**: the "dense token" heuristic
  (`[A-Za-z0-9+/=]{24,}`) matched slash-containing absolute paths and redacted them, breaking
  `allowRead`. Fixed by rejecting `/` in the dense-token guard. Prefer `allowRead` over inlining.
- **Local Qwen latency**: ~1–3.5 min per call. Never worth it for anything `grep`/`awk` answers.
- **Local Qwen prose → table**: reproduced 21/21 sections verbatim with zero invented rows, but
  dropped the single most-critical instruction in ~2 sections and added small extrapolations.
- **Deterministic extraction fails on cheap models, not just Qwen** (2026-09, codestral-latest,
  €10 pay-as-you-go account): a filter+sort task over the Mistral catalog came back wrong twice,
  differently — run 1 dropped 11/21 rows (unrequested dedup); run 2 kept all 21 but added 4
  false positives and **ignored the sort entirely**. Both runs: 0 invented rows, 0 field errors.
  Verdict: extraction/enumeration/sort is not an LLM task — `grep`/`awk`/`python` only.
- **Mistral draft tier works where it should** (2026-09, codestral-latest): prose→table 6/6 rows
  correct, zero invention, ~$0.0007, 4 s; small self-contained function draft passed 12/12 test
  cases on first try (~$0.0007, 7 s). Better than the local Qwen baseline on the same class.
- **Mistral rate limits are real**: ~5 rapid requests (amplified by pi's auto-retries) hit an
  account-wide 429 that recovered in ~90 s; `devstral-2512` stayed 429 even in a clean window
  (not entitled on the plan). Space Mistral offloads; do not burst them.

## Decision record (2026-09-09, supersedes the 2026-08-25 local-only rule)

The default offload target is the **Mistral draft worker** (`codestral-latest`) for
prose → structured table/summary and small self-contained code drafts, always reviewed. The
local Qwen worker remains as the offline fallback only. Deterministic extraction/enumeration/sort
is **never** an LLM task — `grep`/`awk`/`python` only — because both the local 9B model and
codestral-latest fail it while deterministic tools get it right at zero cost.

The 2026-08-25 finding stands and is now generalized: the bottleneck is that cheap models do not
reliably follow multi-clause deterministic instructions, not the specific model. The cloud
escalation path via `delegate` covers everything analytical.

## Data minimization (hard rule)

The worker receives **only** your brief — never the conversation, repository, unrelated files,
MCP state, environment variables, or credentials. Send relevant excerpts, not whole files. The
tool screens the brief before sending (definite secrets → refusal; probable spans → redaction).

## Permissions / isolation

Workers are tool-free by default (pure analysis of the brief). `allowRead: true` grants only
`read, ls, find, grep, glob` — never `bash`/`write`/`edit`/MCP/network. The worker can never
modify anything; you always apply the result yourself.

## Escalation to a stronger cloud model

`delegate` also accepts a concrete OpenCode Go model id (e.g. `gpt-5.6-luna`) for a rare,
justified escalation when a single subtask needs reasoning beyond the primary. `model` is a
concrete id — `mistral`, `local`, or a catalog id — never a dispatch tier (`low…max`) or a
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
