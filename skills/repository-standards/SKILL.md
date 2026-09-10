---
name: repository-standards
description: Maintain professional, consistent and secure Git repositories. Use when creating or initializing a repo, preparing a project for publication, or deciding licensing/attribution. Encodes a set of conventions — MIT by default, NOTICE.md for third-party content, AI-disclosure, doc-sync in the same commit, private data kept out of git.
summary: "git repos: MIT, NOTICE, doc-sync, forks, README conventions"
---

# Repository Standards

## Scope

Apply these standards primarily when:

- creating a new repository
- initializing an existing local project as a repository
- substantially restructuring a repository
- reviewing repository hygiene
- preparing a project for publication

Do not automatically restructure an existing repository simply because it does not follow
these standards.

Preserve established project conventions unless the user asks for a migration.

## License

New personal repositories should use the **MIT License** by default — this is the consistent
choice across these projects.

A new repository should contain a `LICENSE` file with the standard MIT license text and the
appropriate copyright holder (`Copyright (c) <year> <your name>`), and the current year.

Never change the license of an existing repository without explicit user instruction.

If an existing repository uses another license, preserve it unless the user explicitly
requests a licensing change.

**Forks preserve upstream.** When a repository is a fork or derived from someone else's work
(e.g. a fork of `upstream/example`): keep the upstream author's copyright
and license header intact, add the fork's own changes on top, and keep an `upstream` git
remote for reference. Do not relicense a fork's upstream code to MIT as if it were yours.

**Multi-license projects.** Where a project mixes code, documentation and hardware (e.g. a
project with `LICENSE`, `LICENSE-DOCS`, `LICENSE-HARDWARE`), put each artifact under the
license that fits it and state the split clearly in the README. This is the exception, not the
default.

**Third-party redistribution.** Where the repo redistributes third-party code (vendored,
pinned hooks, icons and assets), separate the redistribution from your own work with a
`NOTICE.md` and attribute the source, its license and the upstream copyright. Distilled ideas
(taken without code) belong in the same provenance record, marked as ideas only.

## README

Every repository should have a `README.md`.

The README must be written in **English** — this is non-negotiable and overrides the language
used for prose elsewhere.

At minimum, it should explain:

- what the project is
- what problem it solves
- its main features
- prerequisites
- installation/setup
- basic usage
- configuration when relevant
- development/testing instructions when relevant
- licensing / provenance

The README must reflect the actual current state of the project.

Do not document features that do not exist or leave placeholder instructions in a published
repository. A README that claims a result better than what is true is a bug and gets fixed
(commit history is explicit about this).

## README Structure

Use a structure appropriate to the project. A typical layout, matching published repos:

```text
[banner image — docs/brand/banner.svg]

# Project Name

Short tagline / one-line description.

> **Read this first.** A personal project, published as is and with no warranty:
> it is not a finished product nor a commercial one, and it will not become either.
> It was written in large part with an AI assistant, under human guidance and review.
> (add this for personal / AI-assisted projects)

## What it is / Features

## Requirements

## Installation

## Configuration

## Usage

## Development

## Testing

## Security  (when relevant — supported versions + private reporting)

## License / Provenance and licence
```

Conventions worth adopting:

- A **graphic banner** (SVG in `docs/brand/`) at the top.
- An honest **"Read this first" disclaimer** for personal, AI-assisted projects: personal,
  no warranty, largely written with an AI assistant under human review. This is part of the
  point of the project, not a disclaimer to trim.
- A **Provenance and licence** section (or a pointer to `NOTICE.md`) that separates what is
  redistributed (with upstream copyright/license) from ideas distilled with no code taken.

Do not mechanically include sections with no useful content.

Prefer a concise README that answers the questions a new user will actually have.

**Second-language copies.** When the audience justifies an extra language copy (e.g.
`README.it.md` alongside the English `README.md`), keep them **in sync as
one logical document**: a change of substance touches *both copies in the same commit*, because
updating only one is how the other starts to lie. In general, the language of a document is
decided by its audience — code-facing docs stay English, and only the entry points that serve
a non-English audience get a second copy.

## Repository Hygiene

Keep the repository clean.

Use an appropriate `.gitignore`.

Do not commit:

- secrets
- API keys
- credentials
- private certificates
- local configuration containing sensitive values
- private or personal data (even in a private repository — treat visibility as one setting
  away from changing)
- crawled / downloaded third-party content (video, media, feed dumps, corpus) — keep only the
  pipeline *code* and the *source list* in the repo
- generated caches
- build artifacts
- `node_modules`, `.venv`, lock files where conventionally ignored
- inappropriate IDE-specific files
- operating-system metadata
- large temporary files

Check the project type before selecting `.gitignore` entries.

Do not blindly copy a generic `.gitignore` containing irrelevant rules.

**Versioned vs local-only split.** Split the repo by *nature of content*, not by technology:
what is versioned is **impersonal** (code, schemas, source lists, docs, templates); real data,
credentials and derived/private output stay **local-only** and gitignored. Keep `.gitignore`,
the leak guard and the documented split in agreement — when they disagree, the guard wins and
the documentation is the bug.

## Configuration Examples

When the project requires configuration through environment variables or configuration files,
provide safe examples when useful.

For environment variables, prefer `.env.example` or the project's established equivalent.

Never put real credentials into examples.

Clearly distinguish required values from optional values.

## Project Structure

Use a predictable structure appropriate to the language and framework.

Separate source code, tests, documentation and generated artifacts when the project benefits
from doing so.

Do not create directories simply because a template expects them.

Avoid unnecessary structural complexity.

The repository should make the main entry point and important components easy to discover.

## Documentation Consistency

Documentation is part of the project.

When a change modifies public behaviour, installation, configuration, CLI usage, API behaviour,
architecture, supported versions, dependencies or operational procedures, update the relevant
documentation as part of the **same** change (doc-sync).

Do not leave documentation describing behaviour that no longer exists.

Do not update unrelated documentation merely for cosmetic consistency.

**Commit and push are one operation.** No commit leaves documentation describing a superseded
state; the doc update belongs in the *same* commit as the change, not in a follow-up or a
cleanup pass. If a push already went out with stale docs, the remedy is the next commit, not a
mental note.

## Dependencies

Keep dependencies intentional.

When adding a dependency:

- verify that it is actually required
- consider whether existing dependencies already provide the capability
- consider maintenance and supply-chain risk
- update the appropriate dependency manifest and lock file
- document important setup requirements when relevant

Avoid dependency bloat.

Third-party code that earns its place is **audited, vendored in the project's own form,
pinned to an explicit version** (checksummed, never a "latest" channel) and registered in the
provenance record. Never install auto-updating unknown plugins.

## Tests and CI

Use tests appropriate to the project.

For software projects, consider:

- unit tests
- integration tests
- golden tests for a deterministic engine or converter (numbers verifiable by hand)
- linting
- formatting checks
- type checking where applicable
- security checks where appropriate

CI should be introduced when it provides meaningful value.

Do not add elaborate CI pipelines to trivial projects merely to make the repository look mature.

**Gate.** Where the project has a `check.sh`-style gate (tests + validity + leak guard +
ingress scanner), it must be **green before every commit**. A test whose external binary or
dataset is missing reports a **skip, not a pass** — red means a real failure and green is not
hiding an untested path. Leak guards are a safety net, not a guarantee: do not assume
`.gitignore` alone guarantees sensitive data cannot be committed. The leak guard is the **last
line** of the pipeline, not the first — it runs on top of a gate that is already green, so a
pass means both the functional checks *and* the boundary check held.

**Honest about verification state.** A published repository must not claim results better than
what was actually measured. If something is designed but never built or measured, say so in the
README and in the GitHub description (e.g. "desk-verified, not yet built"). A label that the
project itself walks back is a defect (commit history is explicit about this); an
estimate must never harden into a fact just because it has been written down twice.

## Git Hygiene

Keep commits understandable.

Prefer focused commits that represent coherent changes.

Do not commit unrelated changes, temporary debugging output, generated junk, secrets or local
environment files.

Commit message style is flexible but must be coherent with the repo's history. Conventions in
these repos include:

- Conventional prefixes for focused changes: `fix:`, `feat:`, `docs:`, `chore:`, `perf:`,
  `refactor:`.
- A short, concrete summary that says *what changed and why* (often a plain descriptive
  sentence in the project's language), or a version-bumped release line (`0.15.21 - some
  change`) for versioned add-ons.
- Match the surrounding history's dominant style rather than introducing a new one in the
  middle of a series.

Before publishing or pushing a repository, inspect the diff and staged files.

## Public Repository Safety

Before making a repository public, check for:

- credentials
- API tokens
- private URLs
- internal hostnames
- personal information
- client-attributable or company telemetry
- proprietary material
- private certificates
- environment-specific configuration
- accidentally committed generated data

Treat making a repository public as a security boundary change.

Do not publish first and inspect later.

## Release and Version Information

When relevant, clearly document:

- supported versions
- runtime requirements
- compatibility constraints
- release/build process

For published projects that take bug reports, include:
- a **`SECURITY.md`** with a supported-versions table and a *private* reporting channel
  (private advisory or maintainer email), with an honest statement of response expectations
- a **`CHANGELOG.md`** that records what was wrong before and why
- contribution material (`CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`) when the project invites
  outside contributors

Do not add versioning or overhead unless the project actually needs it.

## Documentation / provenance files worth including

- `LICENSE` — MIT by default (or the project's license; preserve forks' upstream headers).
- `NOTICE.md` — separates third-party redistributed code (source, license, upstream copyright)
  from ideas distilled with no code taken.
- `README.md` in English (+ optional in-sync second-language copies).
- `SECURITY.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` for published,
  externally-visible projects where bugs/contributions are expected.
- A declared `sbom/` or provenance record for hardware/firmware releases when dependencies or
  components need accounting.

## New Repository Checklist

For a new repository, verify:

- `README.md` exists and is in **English**.
- `LICENSE` exists and uses MIT (or the explicitly chosen license; upstream forks keep their
  copyright).
- `NOTICE.md` exists where third-party code or ideas are redistributed/distilled.
- `.gitignore` is appropriate and keeps private/real data out.
- No secrets are committed.
- Installation instructions work.
- Basic usage is documented.
- Configuration requirements are documented.
- Tests or validation are available when appropriate.
- Documentation matches the actual implementation (doc-sync).
- The repository contains no obvious temporary or generated junk.
- AI-assisted projects carry an honest "Read this first / no warranty / AI-assisted"
  disclaimer.

A repository is not considered ready merely because the code works locally.