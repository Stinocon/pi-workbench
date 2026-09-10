#!/usr/bin/env python3
"""test_check.py — tests for the deterministic language checker.

One positive case (must be flagged) and one negative case (must NOT be flagged) per rule.
The invariant "a rule without a test is not valid" is enforced: the test table must cover
every pattern rule id in check.PATTERN_RULES (and the two special rules).
"""
from __future__ import annotations

import sys
from pathlib import Path

# Allow running from any cwd; check.py lives next to this file.
sys.path.insert(0, str(Path(__file__).resolve().parent))

import check  # noqa: E402

# id -> (positive_text, negative_text)
CASES = {
    "it-qual-e": ("qual'è il problema", "qual è il problema"),
    "it-accento-po": ("un pò di tempo", "un po' di tempo"),
    "it-accento-che": ("perchè non funziona", "perché non funziona"),
    "it-apostrofo-un": ("un'altro caso", "un altro caso"),
    "it-apposto": ("è tutto apposto", "è tutto a posto"),
    "it-centra": ("non centra nulla", "non c'entra nulla"),
    "it-ipotetico-sapevo": ("Se lo sapevo, venivo.", "Se l'avessi saputo, sarei venuto."),
    "it-ipotetico-condizionale-protasi": ("Se avrei saputo, sarei venuto.", "Se avessi saputo, sarei venuto."),
    "it-concordanza-affittasi": ("Affittasi case per l'estate.", "Affittansi case per l'estate."),
    "it-pleonasmo": ("a me mi piace", "mi piace"),
    "it-pronome-ci": ("ci dico la verità", "gli dico la verità"),
    "llm-nominalizzazione": ("si procede all'effettuazione della verifica", "la verifica del sistema"),
    "llm-formula-stereotipata": ("È importante notare che il sistema è vulnerabile.", "Il sistema è vulnerabile."),
    "llm-calco-rendere": ("questo rende il sistema più sicuro", "questo aumenta la sicurezza del sistema"),
    # Special rules:
    "llm-ripetizione": ("il il sistema è rotto", "il sistema è rotto"),
    "llm-connettivo-ripetuto": ("Inoltre il sistema è veloce. Inoltre è sicuro.", "Il sistema è veloce e sicuro."),
}

# Negative cases for ambiguous inputs that MUST NOT be flagged (precision guard).
PRECISION_NEGATIVES = {
    "it-apostrofo-un": ["un'amica sincera"],          # femminile corretto
    "it-apposto": ["il sigillo è apposto sul documento"],  # participio di 'apporre'
    "it-centra": ["non centra il bersaglio"],         # verbo 'centrare' legittimo
    "it-ipotetico-sapevo": ["non so se lo sapevo"],   # interrogativa indiretta
    "it-ipotetico-condizionale-protasi": ["non so se avrei tempo"],  # interrogativa indiretta
}


def _rule_ids(text: str) -> set[str]:
    return {i["rule_id"] for i in check.check_text(text)}


def main() -> int:
    failures = 0

    # Invariant: every pattern rule + special rule has a test case.
    declared = {r["id"] for r in check.PATTERN_RULES} | {"llm-ripetizione", "llm-connettivo-ripetuto"}
    tested = set(CASES)
    missing = declared - tested
    if missing:
        print(f"FAIL: rules without a test: {sorted(missing)}")
        failures += 1
    extra = tested - declared
    if extra:
        print(f"FAIL: test cases for unknown rules: {sorted(extra)}")
        failures += 1

    for rule_id, (positive, negative) in CASES.items():
        pos_ids = _rule_ids(positive)
        if rule_id not in pos_ids:
            print(f"FAIL [{rule_id}] positive not flagged: {positive!r}")
            failures += 1
        if rule_id in _rule_ids(negative):
            print(f"FAIL [{rule_id}] false positive on: {negative!r}")
            failures += 1
        for extra_neg in PRECISION_NEGATIVES.get(rule_id, []):
            if rule_id in _rule_ids(extra_neg):
                print(f"FAIL [{rule_id}] precision guard failed on: {extra_neg!r}")
                failures += 1

    if failures == 0:
        print(f"OK: {len(CASES)} rules tested, all passed.")
        return 0
    print(f"{failures} test(s) failed.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
