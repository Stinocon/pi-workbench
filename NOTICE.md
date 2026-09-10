# NOTICE — third-party content and provenance

`pi-workbench` is MIT-licensed (see `LICENSE`). A small number of files carry or build
on third-party material. This file records where each came from, its license and its
upstream copyright, so provenance stays traceable when the work is redistributed.

## Vendored code

### `skills/clean-marks/scripts/text_unicode.py`, `skills/clean-marks/scripts/common.py`

- **Source:** `guillaumemeyer/watermarks-remover`
- **License:** MIT
- **Pinned commit:** `d775dbe`
- **Note:** vendored verbatim and audited. Only the "Layer A" hygiene engine (invisible /
  bidi Unicode character detection) is used. The statistical watermark-rewriting layer and
  metadata-stripping features were intentionally left out (dual-use). The CLI wrapper
  `clean_marks.py` and the `SKILL.md` are original to this project.

## Derived code

### `extensions/subagent/` (the subagent dispatcher)

- **Source:** derived from Pi's own open example extension (`@earendil-works/pi-coding-agent`).
- **License:** follows the upstream Pi example extension's license.
- **Note:** reworked into the single / parallel / chain dispatcher described in the README.
  Keep the upstream provenance in mind if you redistribute it.

## External tools referenced (not vendored)

These skills invoke standalone tools that are installed separately — they are not shipped
in this repository, only referenced by name and invoked when present:

- **anydoc** (`skills/docs/`) — office/PDF → Markdown conversion.
- **crawl4ai** (`skills/crawl/`) — web scraping into Markdown.
- **LibreCrawl** (`skills/site-audit/`) — technical/SEO site audit.

## Ideas and methods

The working methods encoded here (calibrated-effort dispatch, adversarial council,
evidence-based memory, doc-sync gates, honesty-over-agreement review) are the author's own,
developed and documented over real projects. No third-party code or text is reproduced in
those skills; only the ideas are restated in this project's own form.
