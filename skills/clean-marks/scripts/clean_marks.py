#!/usr/bin/env python3
"""clean_marks.py — CLI del tool clean-marks (Layer A: Unicode invisibile/bidi, solo testo).

Motore vendored da watermarks-remover (MIT, guillaumemeyer/watermarks-remover, commit pinnato
in NOTICE.md): `text_unicode.py` + `common.py` copiati verbatim. Questo wrapper è nostro
(§10: "idea sì, plugin no" — qui il codice terzo si è guadagnato il posto: auditato, vendorato,
pinnato). Niente Layer B (rewrite statistico) né metadata: dual-use lasciato fuori.

Uso:
    clean_marks.py inspect <file>                     # report sola-lettura
    clean_marks.py check <file>                       # come inspect, exit 2 se trova qualcosa (per hook)
    clean_marks.py clean <file> [--in-place] [--nfkc] [--aggressive] [--strip-bidi] [--strip-emoji-glue]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402
import text_unicode  # noqa: E402


def _load(path: str) -> str:
    return common.read_text_input(path)


def cmd_inspect(path: str, aggressive: bool, strip_emoji_glue: bool) -> int:
    report = text_unicode.inspect_text(_load(path), aggressive=aggressive, strip_emoji_glue=strip_emoji_glue)
    print(text_unicode.human_report(report))
    return 0


def cmd_check(path: str, aggressive: bool, strip_emoji_glue: bool) -> int:
    report = text_unicode.inspect_text(_load(path), aggressive=aggressive, strip_emoji_glue=strip_emoji_glue)
    if report.suspicious_total > 0:
        common.eprint(f"[clean-marks] {path}: {report.suspicious_total} caratteri invisibili/bidi sospetti.")
        common.eprint(text_unicode.human_report(report))
        return 2
    print(f"[clean-marks] {path}: pulito.")
    return 0


def cmd_clean(path: str, in_place: bool, nfkc: bool, aggressive: bool,
              strip_bidi: bool, strip_emoji_glue: bool) -> int:
    text = _load(path)
    out, stats = text_unicode.clean_text(
        text, nfkc=nfkc, aggressive_homoglyphs=aggressive,
        strip_bidi=strip_bidi, strip_emoji_glue=strip_emoji_glue,
    )
    if path == "-":
        common.write_text_output(out, None)
        return 0
    if in_place:
        common.backup_path(Path(path))
        common.write_text_output(out, path)
        common.eprint(f"[clean-marks] {path}: {stats['removed_count']} rimossi, "
                      f"{stats['replaced_count']} sostituiti (backup: {path}.bak)")
    else:
        dest = common.cleaned_path(Path(path))
        common.write_text_output(out, str(dest))
        common.eprint(f"[clean-marks] {path} -> {dest}: {stats['removed_count']} rimossi, "
                      f"{stats['replaced_count']} sostituiti")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="clean-marks: rimuove caratteri Unicode invisibili/bidi (Layer A).")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("inspect", "check", "clean"):
        p = sub.add_parser(name)
        p.add_argument("path", nargs="?", default="-")
        p.add_argument("--aggressive", action="store_true",
                       help="sostituisci anche i confusabili latini (es. omografi cirillici)")
        if name == "clean":
            p.add_argument("--in-place", action="store_true", help="scrivi sul file (con backup .bak)")
            p.add_argument("--nfkc", action="store_true", help="normalizza NFKC dopo la pulizia")
            p.add_argument("--strip-bidi", action="store_true",
                           help="rimuovi anche i bidi preservabili (RTL/isolati/coppie valide)")
            p.add_argument("--strip-emoji-glue", action="store_true",
                           help="rimuovi anche ZWJ/variation selector emoji (altera le emoji)")
        else:
            p.add_argument("--strip-emoji-glue", action="store_true")
    a = ap.parse_args()
    if a.cmd == "inspect":
        return cmd_inspect(a.path, a.aggressive, a.strip_emoji_glue)
    if a.cmd == "check":
        return cmd_check(a.path, a.aggressive, a.strip_emoji_glue)
    return cmd_clean(a.path, a.in_place, a.nfkc, a.aggressive, a.strip_bidi, a.strip_emoji_glue)


if __name__ == "__main__":
    sys.exit(main())
