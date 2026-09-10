---
name: open-hardware-firmware
description: Design, document and publish open hardware and embedded firmware. Use when writing firmware (ESP32/ESPHome), OpenSCAD models, or 3D-printed parts. A buildable-elsewhere method — design-notes as the reasoning hub, honest about the unbuilt, reproducible parameters with declared sources, and hardware-aware licensing.
summary: ESP32/ESPHome/OpenSCAD/3D printing method
---

# Open Hardware & Firmware — Operating Skill

A working method for open-hardware and firmware projects where the **primary output is a design
other people can build** (ESP32/ESPHome devices, OpenSCAD parametric models, STL parts, BOMs).
The operator is often a single maintainer building one unit for themselves; every reader after
that is a stranger following the instructions with money and, sometimes, a water reservoir or a
powered load at stake.

This is a *domain* skill: it sits alongside `coding-standards`, `repository-standards` and
`security-review` and applies on top of them. It refuses to treat hardware as "just firmware
code" or as "just a README" — both are subordinate to a reproducible build.

## What wins when things compete

Establish the ranking explicitly for the project (document it in `AGENTS.md §1`).
A typical order, from first to last:

1. **Correct physics / signal chain** — ADC range, transfer function, error budget, fault
   detection. A firmware refactor that leaves the measured value slightly wrong is a failure;
   ugly firmware that reports honestly is not.
2. **Honest reporting** — a fault said out loud beats a plausible number. This constraint often
   justifies *not* actuating: a measurement error that misleads is an annoyance; the same error
   driving a dosing pump or a relay kills a crop or starts a fire. Prefer measure-only over
   actuate when that is the honest boundary.
3. **A build a stranger can reproduce** — BOM, wiring, enclosure, calibration, ordering
   identifiers.
4. **Everything else**, including the tooling.

## Honesty about the unbuilt — the overriding rule

Hardware is expensive and slow to iterate, so much of it is *designed before it is built or
measured*. This creates a constant pressure for an estimate to harden into a fact simply because
it has been written down twice. Resist it everywhere:

- Label every number with its provenance: **from a datasheet**, **derived** (with the
  derivation), **estimated**, or **to be measured**.
- Keep the verification state explicit and visible in the README and GitHub description (e.g.
  "desk-verified, not yet built"). Never claim a result better than what was actually measured.
- Maintain a design-notes document (like `docs/DESIGN_NOTES.md`) as the
  **reasoning hub**: *why* each component was chosen, the transfer function and its derivation,
  the error budget. Any question that touches "why is this value this" is answered there or
  nowhere.
- Maintain a changelog that records **what was wrong before and why** (older-revision defects are
  the fastest way to learn which mistakes the design is prone to).
- When a source is a datasheet, cite it with its identifiers. When a specification or tolerance
  matters, say so and flag whether it was verified.

## A build a stranger can reproduce

The bar is: can a stranger with money and their own unit complete the build from the repo alone?

- **Wiring and assembly** — clear, unambiguous connection/graphical instructions, not prose.
- **Bill of materials** — actual part identifiers (orderable), quantities, and where relevant
  alternatives. Keep an SBOM for firmware/software dependencies and record versions.
- **Parametric models** — for OpenSCAD, expose the tunable variables at the top of the `.scad`
  file with unit and comment, and render the preview(s) you ship so the model matches the graph.
- **Calibration** — a documented procedure with a start point, a reference (e.g. calibration
  fluid of known EC), and a stated target/expected value. Keep calibration notes and results
  where the maintainer logs them.
- **Testing and maintenance** — test/verification expectations and sustainment notes so a
  stranger knows when a measurement is out of tolerance and what to do about it.

## Deterministic boundaries apply to physics too

The coding-standards principle ("the model treats words, the code treats numbers") has a
hardware analog:

- Transfer functions, error budgets, unit/density/class lookups and any value that **iterates or
  must be reproducible** are computed by deterministic code or tables with declared sources —
  never estimated inline by a model while writing.
- A conversion or computation without a declared source is a number no one can trust. Either give
  it a source or mark it as a gap to be filled — do not invent the value.
- When the firmware converts raw ADC → engineering units, keep the conversion data-driven
  (declared tables/calibration) rather than hard-coded constants scattered through the code.

## Get the language right for the audience, code/docs in English

- **Code, comments, identifiers, firmware, documentation and the README are in English** —
  non-negotiable and overrides the author's spoken language.
- When an audience genuinely needs a second language, ship a second copy (e.g. `README.it.md`)
  and keep both in sync in the same commit; a description that diverges is a bug.
- Rendering decisions stay reproducible: exporter settings, layer height and smoothing factors
  that affect a printed STL are stated, not hidden.

## Licensing a mixed-content hardware repo

A hardware repo mixes **code**, **documentation** and **hardware design files**, and they do not
need the same license. A reference pattern:

- `LICENSE` (or `LICENSE-HARDWARE`) for the physical/integrated-circuit-relevant content.
- `LICENSE-DOCS` for the documentation.
- `LICENSE` for the firmware/source code.

Separate licenses into their own files, state the split explicitly in the README, and make sure
each artifact actually falls under the license declared for it. Hardware-specific drafting (e.g.
CERN-OHL-S, TAPR) is appropriate for physical files; keep the general rule "MIT by default for
personal code" from `repository-standards` unless a hardware license is explicitly chosen.

## Forks preserve upstream

When the project builds on someone else's hardware or firmware:

- Preserve the upstream author's copyright and license.
- Keep an explicit comparison of what changed vs the original (a table like the fork's
  "Enhanced vs Original"), and record which upstream version it was based on.
- Attribute sources in a `NOTICE.md` when third-party code or ideas are redistributed or
  distilled.

## Published-repo framing for hardware

Add the honest, personal-project framing to the README: a "Read
this first" block stating it is a personal project published as-is with no warranty, developed
with an AI assistant under human guidance and review. Where relevant add `SECURITY.md` honestly
(e.g. hobby project, no SLA) and contribution material (`CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`)
if the design is meant to attract builders or reporters.

## Project structure orientation

Organize around the *physical/build* concerns, not just code, so a builder can find what they
need:

```text
firmware/          # embedded code (e.g. ESPHome/Python config, Arduino), all in English
hardware/          # mechanical: OpenSCAD .scad sources, exported STL, enclosure
3d/ or accessories/# printed parts and preview renders
docs/              # DESIGN_NOTES (why), ASSEMBLY (wiring/build), CALIBRATION, TESTING,
                   # MAINTENANCE, PLANNING — plus brand assets
integrations/       # integration/sensor config when the device reports into a home hub
sbom/              # dependency/component accounting
LICENSE*           # license split for code / docs / hardware as applicable
NOTICE.md          # third-party attribution when relevant
```

Conform to `repository-standards` for hygiene; the differences in this skill exist only because
the artifacts are physical.

## Key deliverables to verify before calling hardware work done

- Design notes explain every non-obvious value and its provenance.
- Every estimate is labelled; nothing unbuilt has silently become fact.
- A stranger could reproduce the build from the repo (BOM, wiring, calibration, enclosure).
- Code, comments, docs, README in English (bilingual copies kept in sync).
- License split reflects code/docs/hardware; forks preserve upstream.
- README and GitHub description are honest about verification state.
- The transfer-function / conversion path is deterministic and source-tracked, with no invented
  constants.