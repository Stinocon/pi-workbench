#!/usr/bin/env python3
"""score.py — deterministic scorer for the language benchmark (stdlib only).

Scores a set of model outputs with tools/check.py and reports per-case and aggregate
severity-weighted error counts. This is the OBJECTIVE anchor of the benchmark; naturalness
and style adherence are scored separately by the LLM judge (see rubric.md).

Uso:
    score.py --outputs outputs.json      # {"case_id": "text produced by the model", ...}
    score.py --outputs outputs.json --cases cases.yaml

outputs.json format: {"config": "A|B|C|D|E", "results": {"case_id": "text", ...}}
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import check  # noqa: E402

SEVERITY_WEIGHT = {"high": 3, "medium": 2, "low": 1}


def score_text(text: str) -> dict:
    issues = check.check_text(text)
    weighted = sum(SEVERITY_WEIGHT.get(i["severity"], 1) for i in issues)
    by_sev = {"high": 0, "medium": 0, "low": 0}
    for i in issues:
        by_sev[i["severity"]] = by_sev.get(i["severity"], 0) + 1
    return {"weighted": weighted, "issues": issues, "by_severity": by_sev}


def main() -> int:
    ap = argparse.ArgumentParser(description="Deterministic benchmark scorer.")
    ap.add_argument("--outputs", required=True, help="JSON: {config, results:{case_id:text}}")
    args = ap.parse_args()

    data = json.loads(Path(args.outputs).read_text(encoding="utf-8"))
    results = data.get("results", {})
    if not results:
        print("no results in", args.outputs, file=sys.stderr)
        return 2

    total_weighted = 0
    total_issues = 0
    per_case = []
    for case_id, text in results.items():
        s = score_text(text)
        total_weighted += s["weighted"]
        total_issues += len(s["issues"])
        per_case.append({"case_id": case_id, "weighted": s["weighted"],
                         "issues": len(s["issues"]), "by_severity": s["by_severity"]})

    # Lower is better: 0 = error-free.
    out = {
        "config": data.get("config", "?"),
        "cases": len(results),
        "total_issues": total_issues,
        "total_weighted": total_weighted,
        "score": round(total_weighted / max(len(results), 1), 2),  # weighted errors per case
        "per_case": sorted(per_case, key=lambda c: -c["weighted"]),
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
