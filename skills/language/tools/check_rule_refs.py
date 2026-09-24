#!/usr/bin/env python3
"""check_rule_refs.py — the YAML rule files and check.py must agree on what is mechanized.

Every `check: <id>` (or `checks: [<id>, ...]` for an umbrella rule) in rules/*/*.yaml and
errors/*/*.yaml claims that check.py implements that rule id. Nothing verified it, so 10 references
pointed at patterns that did not exist: the file said "mechanized" and the checker knew nothing
about it — a document that lies about its own coverage, and the exact failure mode that is silent by
construction (no error, no output, just a rule the reader believes is enforced).

Exit 1 when a YAML claims a check that does not exist. A rule that check.py implements while no YAML
names it is printed as a warning instead: under-documented, not broken, and `check.py rules` is the
authority on what actually runs.

    python3 check_rule_refs.py            # check, print nothing on success
    python3 check_rule_refs.py -v         # print the mapping
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SKILL = HERE.parent
sys.path.insert(0, str(HERE))

import check  # noqa: E402

# Rules implemented outside PATTERN_RULES (structural checks in check.py).
STRUCTURAL_IDS = {
    "llm-ripetizione",
    "llm-connettivo-ripetuto",
    "en-llm-connector-repetition",
    "en-llm-em-dash-overuse",
}


def implemented_ids() -> set[str]:
    return {r["id"] for r in check.ALL_PATTERN_RULES} | STRUCTURAL_IDS


def referenced_ids() -> dict[str, list[str]]:
    """check id -> files that claim it.

    Two spellings are read:
      `check: <id>`                  one mechanized pattern
      `checks: [<id>, <id>, ...]`    an umbrella rule that several patterns implement
                                     (e.g. the accent rule, mechanized as three patterns)
    """
    refs: dict[str, list[str]] = {}
    for pattern in ("rules/*/*.yaml", "errors/*/*.yaml"):
        for path in sorted(SKILL.glob(pattern)):
            text = path.read_text(encoding="utf-8")
            where = str(path.relative_to(SKILL))
            for m in re.finditer(r"^\s*checks?:(.*)$", text, re.M):
                value = m.group(1).strip()
                if not value:
                    continue
                ids = (
                    [part.strip() for part in value.strip("[]").split(",")]
                    if value.startswith("[")
                    else [value]
                )
                for rule_id in ids:
                    if rule_id:
                        refs.setdefault(rule_id, []).append(where)
    return refs


def main() -> int:
    verbose = "-v" in sys.argv[1:]
    impl = implemented_ids()
    refs = referenced_ids()
    failures = 0
    warnings = 0

    for rule_id, files in sorted(refs.items()):
        if rule_id not in impl:
            failures += 1
            print(f"FAIL: check={rule_id} referenced by {', '.join(sorted(set(files)))}, "
                  f"but check.py has no such rule")

    for rule_id in sorted(impl - set(refs)):
        # A warning, not a failure: check.py is the authority on what runs, and `check.py rules`
        # lists it. A rule the YAML never names is under-documented, not broken — but the reverse
        # (a YAML claiming a check that does not exist) IS a failure, because it tells the model a
        # rule is enforced when nothing enforces it.
        warnings += 1
        print(f"warn: check.py implements {rule_id}, but no YAML names it")

    if verbose:
        for rule_id in sorted(impl & set(refs)):
            print(f"OK   {rule_id:<40} {', '.join(sorted(set(refs[rule_id])))}")

    if failures:
        print(f"check_rule_refs: {failures} inconsistency(ies)")
        return 1
    print(f"check_rule_refs: {len(refs)} referenced rule(s), all implemented"
          + (f" ({warnings} implemented rule(s) not named in any YAML)" if warnings else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
