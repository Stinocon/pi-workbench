#!/usr/bin/env python3
"""check.py — deterministic language checker for pi (Italian, stdlib only, zero dependencies).

The Language Layer's deterministic stage. Rules are DATA in this file (code = data, no external
grammar DB): high-precision regex rules for mechanical Italian errors + LLM-typical unnatural
constructions. The checker REPORTS issues, never auto-corrects. Low false-positive rate is
prioritized over coverage — ambiguous cases (e.g. "colla" noun vs "con la") stay model-facing in
the YAML and are deliberately NOT mechanized here.

Uso:
    check.py check "testo"          # JSON issues: {span, rule_id, severity, suggestion, confidence}
    check.py check -                # read text from stdin
    check.py check "text" --lang en # only the English rules (it|en|all; default all)
    check.py rules                  # list active rules
    check.py test                   # run test_check.py (a rule without a test is not valid)

Language: the two rule sets are high-precision regexes, so running both (the default) is safe on
monolingual text and never misses a rule because the language was guessed wrong. `--lang` narrows
the set when you know which one applies.

Confidence: deterministic orthography ~0.9+, grammar patterns ~0.7-0.85, LLM-tell hints ~0.4-0.6.
"""
from __future__ import annotations

import argparse
import json
import re
import sys

# Match both straight (') and typographic (') apostrophes.
APOS = "['\u2019]"

# Anchor for protasi of a periodo ipotetico: 'se' at sentence start or after . ! ?.
# Excludes indirect interrogatives like "non so se avrei tempo" (there 'se' is not anchored).
SE_ANCHOR = r"(?:(?<=^)|(?<=[\.!?]\s))\s*"

# A rule is: id, name, pattern, suggestion, severity, confidence, register.
# pattern is matched case-insensitively by default; suggestion may be None (report only).
PATTERN_RULES = [
    # --- Ortografia deterministica (confidence alta) ---
    {
        "id": "it-qual-e",
        "name": "'qual è' senza apostrofo",
        "pattern": rf"\bqual{APOS}\s*è\b",
        "suggestion": "qual è",
        "severity": "high",
        "confidence": 0.95,
        "register": "all",
    },
    {
        "id": "it-accento-po",
        "name": "'pò' al posto di 'po''",
        "pattern": r"\bpò\b",
        "suggestion": "po'",
        "severity": "high",
        "confidence": 0.95,
        "register": "all",
    },
    {
        "id": "it-accento-e",
        "name": "'E'' al posto di 'È' (accento grave reso con apostrofo)",
        "pattern": r"\b[eE]['\u2019](?=[\s,.;:!?]|$)",
        "suggestion": "È (accento grave, non apostrofo)",
        "severity": "high",
        "confidence": 0.9,
        "register": "all",
    },
    {
        "id": "it-accento-che",
        "name": "accento grave invece di acuto su -ché",
        "pattern": r"\b(perchè|affinchè|giacchè|sicchè|poichè|benchè|finchè)\b",
        "suggestion": "accento acuto: perché, affinché, giacché, sicché, poiché, benché, finché",
        "severity": "medium",
        "confidence": 0.9,
        "register": "all",
    },
    {
        "id": "it-apostrofo-un",
        "name": "apostrofo su 'un' maschile (troncamento, non elisione)",
        "pattern": rf"\bun{APOS}(uomo|amico|animale|altro|anno|albero|esempio|elemento)\b",
        "suggestion": "senza apostrofo (troncamento): un uomo, un amico, un altro",
        "severity": "high",
        "confidence": 0.93,
        "register": "all",
    },
    {
        "id": "it-apposto",
        "name": "'apposto' al posto di 'a posto'",
        "pattern": r"\b(?:tutto|tutto quanto)\s+apposto\b",
        "suggestion": "a posto",
        "severity": "high",
        "confidence": 0.9,
        "register": "all",
    },
    {
        "id": "it-centra",
        "name": "'centra' al posto di 'c'entra'",
        "pattern": r"\bnon\s+centra\s+(nulla|niente)\b",
        "suggestion": "c'entra",
        "severity": "high",
        "confidence": 0.92,
        "register": "all",
    },
    # --- Grammatica (confidence media-alta) ---
    {
        "id": "it-ipotetico-sapevo",
        "name": "'se lo sapevo' (indicativo al posto del congiuntivo trapassato)",
        "pattern": rf"{SE_ANCHOR}se\s+(?:io\s+)?lo\s+sapevo\b",
        "suggestion": "se l'avessi saputo",
        "severity": "high",
        "confidence": 0.85,
        "register": "all",
    },
    {
        "id": "it-ipotetico-condizionale-protasi",
        "name": "condizionale nella protasi del periodo ipotetico",
        "pattern": rf"{SE_ANCHOR}se\s+(?:io\s+)?(sarei|avrei|potrei|vorrei|dovrei|saresti|avresti|sarebbe|avrebbe|potrebbe|vorrebbe|dovrebbe|saremmo|avremmo|sareste|avreste|sarebbero|avrebbero)\b",
        "suggestion": "congiuntivo (imperfetto/trapassato) nella protasi; verifica che non sia interrogativa indiretta",
        "severity": "high",
        "confidence": 0.7,
        "register": "all",
    },
    {
        "id": "it-concordanza-affittasi",
        "name": "'affittasi' con soggetto plurale",
        "pattern": r"\baffittasi\s+(case|stanze|appartamenti|locali|uffici|ville|camere)\b",
        "suggestion": "affittansi (soggetto plurale)",
        "severity": "medium",
        "confidence": 0.9,
        "register": "all",
    },
    {
        "id": "it-pleonasmo",
        "name": "pleonasmo pronominale",
        "pattern": r"\ba\s+(me|te)\s+(mi|ti)\b",
        "suggestion": "eliminare il pronome ridondante (a me piace / mi piace)",
        "severity": "medium",
        "confidence": 0.75,
        "register": "all",
    },
    {
        "id": "it-pronome-ci",
        "name": "'ci' per 'a lui/a lei/a loro'",
        "pattern": r"\bci\s+(dico|ho detto|hai detto|parlo|ho parlato|telefono|ho telefonato|scrivo|ho scritto|chiedo|ho chiesto|domando|ho domandato)\b",
        "suggestion": "gli / le / loro",
        "severity": "medium",
        "confidence": 0.7,
        "register": "all",
    },
    # --- Errori tipici LLM (confidence bassa: hint, non condanna) ---
    {
        "id": "llm-nominalizzazione",
        "name": "nominalizzazione al posto del verbo",
        "pattern": r"\b(?:l'|all')?effettuazion[ei]\b|\bla realizzazione di\b|\bl'esecuzione di\b|\bla verifica di\b|\bil monitoraggio di\b",
        "suggestion": "preferire il verbo (si effettua → si fa / si verifica)",
        "severity": "low",
        "confidence": 0.7,
        "register": "all",
    },
    {
        "id": "llm-formula-stereotipata",
        "name": "formula stereotipata di apertura/chiusura",
        "pattern": r"\b(?:è|e'|È|E')\s+importante notare che\b|\bpossiamo dire che\b|\bin conclusione,?\s+possiamo dire\b|\bquesto documento si propone di\b",
        "suggestion": "andare dritto al punto, senza formula",
        "severity": "low",
        "confidence": 0.6,
        "register": "all",
    },
    {
        "id": "llm-calco-rendere",
        "name": "calco 'rendere X più Y'",
        "pattern": r"\brende\s+(?:il|la|lo|i|le|gli|questo|ciò)\s+\w+\s+più\s+\w+\b",
        "suggestion": "valutare una forma più naturale (migliora/aumenta ...)",
        "severity": "low",
        "confidence": 0.35,
        "register": "all",
    },
]


# EN pattern rules. Same contract: high precision first, coverage second. `robust` and
# `comprehensive` are deliberately NOT in the marketing pattern — both have real technical senses
# (robust to a malformed frame), and a rule that flags a correct sentence teaches the reader to
# ignore the checker. `unlock`, `empower` and `elevate` stay in the YAML guidance, where the model
# judges context, rather than in a regex that cannot.
PATTERN_RULES_EN = [
    {
        "id": "en-its-possessive",
        "name": "its' (no such form)",
        "pattern": r"\bits['\u2019]",
        "suggestion": "its (the possessive takes no apostrophe)",
        "severity": "high",
        "confidence": 0.95,
        "register": "all",
    },
    {
        "id": "en-your-youre",
        "name": "'your' + article (you're expected)",
        "pattern": r"\byour\s+(?:a|an|the)\b",
        "suggestion": "you're (you are)",
        "severity": "high",
        "confidence": 0.9,
        "register": "all",
    },
    {
        "id": "en-their-there",
        "name": "'their' + verb 'to be' (there expected)",
        "pattern": r"\btheir\s+(?:is|are|was|were|will be|has been|have been)\b",
        "suggestion": "there (existential) — 'their' is the possessive",
        "severity": "high",
        "confidence": 0.92,
        "register": "all",
    },
    {
        "id": "en-could-of",
        "name": "'could/should/would of' instead of 'have'",
        "pattern": r"\b(?:could|should|would|might|must)\s+of\b",
        "suggestion": "could have / should have / would have",
        "severity": "high",
        "confidence": 0.93,
        "register": "all",
    },
    {
        "id": "en-between-you-and-i",
        "name": "'between you and I' (objective case expected)",
        "pattern": r"\bbetween\s+you\s+and\s+I\b",
        "suggestion": "between you and me",
        "severity": "high",
        "confidence": 0.93,
        "register": "all",
    },
    {
        "id": "en-llm-formulaic-opener",
        "name": "formulaic opener/closer",
        "pattern": (
            r"\bit(?:['\u2019]s| is)\s+(?:important|worth)\s+(?:to note|noting|mentioning)\b"
            r"|\bin conclusion,?\s+we can say\b"
            r"|\bin today(?:['\u2019]s)\s+fast-?paced world\b"
            r"|\blet(?:['\u2019]s)\s+dive in\b"
            r"|\bwithout further ado\b"
            r"|\bin this (?:article|post|guide),?\s+we(?:['\u2019]ll| will)\b"
        ),
        "suggestion": "delete the formula and state the fact",
        "severity": "low",
        "confidence": 0.55,
        "register": "all",
    },
    {
        "id": "en-llm-marketing-lexicon",
        "name": "marketing lexicon",
        "pattern": (
            r"\b(?:seamless(?:ly)?|cutting-edge|game-?chang(?:er|ing)|world-class|effortless(?:ly)?"
            r"|supercharg(?:e|ed|ing)|delv(?:e|es|ed|ing) into|leverag(?:e|es|ed|ing))\b"
        ),
        "suggestion": "replace it with the concrete claim it stands in for",
        "severity": "low",
        "confidence": 0.5,
        "register": "all",
    },
    {
        "id": "en-llm-nominalization",
        "name": "nominalization where a verb would do",
        "pattern": (
            r"\bthe (?:implementation|utilisation|utilization|performance|facilitation|execution"
            r"|realisation|realization) of\b"
        ),
        "suggestion": "prefer the verb (we implemented, we executed)",
        "severity": "low",
        "confidence": 0.6,
        "register": "all",
    },
]

# Rule sets by language, and the default: both, in this order.
PATTERN_RULES_BY_LANG = {"it": PATTERN_RULES, "en": PATTERN_RULES_EN}
ALL_PATTERN_RULES = PATTERN_RULES + PATTERN_RULES_EN

ENGLISH_CONNECTORS = r"\b(?:Moreover|Furthermore|Additionally|In addition)"


def _resolve_langs(lang: str) -> tuple[str, ...]:
    return tuple(PATTERN_RULES_BY_LANG) if lang == "all" else (lang,)


def _find_pattern_issues(text: str, rule: dict) -> list[dict]:
    """Return issue dicts for every match of rule['pattern'] in text."""
    issues = []
    for m in re.finditer(rule["pattern"], text, re.IGNORECASE):
        issues.append({
            "span": [m.start(), m.end()],
            "match": m.group(0),
            "rule_id": rule["id"],
            "name": rule["name"],
            "severity": rule["severity"],
            "confidence": rule["confidence"],
            "suggestion": rule["suggestion"],
        })
    return issues


def _find_repetition_issues(text: str, langs: tuple[str, ...]) -> list[dict]:
    """Immediate word duplication (typo) and repeated sentence-initial connectors."""
    issues = []
    # Duplicazione immediata di parola: "il il", "di di", ... (vale per ogni lingua)
    for m in re.finditer(r"\b(\w+)\s+\1\b", text, re.IGNORECASE):
        issues.append({
            "span": [m.start(), m.end()],
            "match": m.group(0),
            "rule_id": "llm-ripetizione",
            "name": "parola duplicata",
            "severity": "low",
            "confidence": 0.85,
            "suggestion": "rimuovere la ripetizione",
        })
    # Connettivi ripetuti a inizio frase ravvicinata
    if "it" in langs:
        connectors = re.findall(r"\b(?:Inoltre|Tuttavia|D'altro canto|D'altronde)\b", text, re.IGNORECASE)
        if len(connectors) >= 2:
            issues.append({
                "span": [0, 0],
                "match": ", ".join(connectors),
                "rule_id": "llm-connettivo-ripetuto",
                "name": "connettivi ripetuti",
                "severity": "low",
                "confidence": 0.6,
                "suggestion": "coordinare invece di accumulare connettivi",
            })
    if "en" in langs:
        connectors = re.findall(ENGLISH_CONNECTORS, text, re.IGNORECASE)
        if len(connectors) >= 2:
            issues.append({
                "span": [0, 0],
                "match": ", ".join(connectors),
                "rule_id": "en-llm-connector-repetition",
                "name": "repeated sentence-initial connectors",
                "severity": "low",
                "confidence": 0.6,
                "suggestion": "coordinate the clauses instead of stacking connectives",
            })
    return issues


def _find_em_dash_issues(text: str) -> list[dict]:
    """Two or more em dashes in one paragraph: the punctuation becomes the rhythm."""
    issues = []
    offset = 0
    for paragraph in re.split(r"(\n\s*\n)", text):
        if paragraph and not re.fullmatch(r"\n\s*\n", paragraph):
            count = paragraph.count("\u2014")
            if count >= 2:
                issues.append({
                    "span": [offset, offset + len(paragraph)],
                    "match": f"{count} em dashes",
                    "rule_id": "en-llm-em-dash-overuse",
                    "name": "em dash overuse in one paragraph",
                    "severity": "low",
                    "confidence": 0.4,
                    "suggestion": "use a colon, a comma or a full stop; keep at most one em dash",
                })
        offset += len(paragraph)
    return issues


def check_text(text: str, langs: tuple[str, ...] = ("it", "en")) -> list[dict]:
    """Run the rules of the given languages over text and return a sorted list of issue dicts."""
    issues: list[dict] = []
    for lang in langs:
        for rule in PATTERN_RULES_BY_LANG[lang]:
            issues.extend(_find_pattern_issues(text, rule))
    issues.extend(_find_repetition_issues(text, langs))
    if "en" in langs:
        issues.extend(_find_em_dash_issues(text))
    # Ordina per gravità decrescente, poi per posizione.
    sev_order = {"high": 0, "medium": 1, "low": 2}
    issues.sort(key=lambda i: (sev_order.get(i["severity"], 3), i["span"][0]))
    return issues


def _rules_table(langs: tuple[str, ...]) -> str:
    lines = []
    for lang in langs:
        for r in PATTERN_RULES_BY_LANG[lang]:
            lines.append(f"{r['id']:<40} {r['severity']:<7} conf={r['confidence']:.2f}  {r['name']}")
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser(description="Deterministic language checker for pi (Italian + English).")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_chk = sub.add_parser("check", help="check a text and emit JSON issues")
    p_chk.add_argument("text", help="text to check, or '-' to read from stdin")
    p_chk.add_argument("--lang", choices=["it", "en", "all"], default="all",
                       help="rule set to apply (default: all — both sets are high-precision)")
    p_rul = sub.add_parser("rules", help="list active rules")
    p_rul.add_argument("--lang", choices=["it", "en", "all"], default="all")
    sub.add_parser("test", help="run test_check.py")
    args = ap.parse_args()

    if args.cmd == "rules":
        print(_rules_table(_resolve_langs(args.lang)))
        return
    if args.cmd == "test":
        import test_check  # local, same directory
        test_check.main()
        return
    # check
    if args.text == "-":
        text = sys.stdin.read()
    else:
        text = args.text
    issues = check_text(text, _resolve_langs(args.lang))
    print(json.dumps({"issues": issues, "count": len(issues)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
