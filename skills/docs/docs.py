#!/usr/bin/env python3
"""docs.py — documenti (Word/PPT/Excel/ODF/RTF/EPUB/CSV/PDF) → Markdown, tool globale per pi.

Wrapper auto-contenuto su anydoc (firecrawl/anydoc, MIT): al primo uso crea un venv pinnato
(~/.pi/agent/venvs/anydoc-venv, firecrawl-anydoc==0.2.3) e delega la conversione a quello.
Il launcher usa SOLO stdlib, quindi gira con qualunque python3, indipendentemente dal venv
del progetto corrente. Il venv è machine-local (non versionato, non sincronizzato), come
~/.pi/agent/rag.

Uso:
    docs.py <file>...            # converte e stampa Markdown su stdout
    docs.py <file> -o out.md     # scrive su file
    docs.py --stdin [--format x] # legge bytes da stdin (formato auto; --format per CSV/estensione assente)
    docs.py --install            # (ri)crea il venv pinnato
    docs.py --doctor             # verifica venv, versione, smoke-test
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

VENV_DIR = Path.home() / ".pi" / "agent" / "venvs" / "anydoc-venv"
PIN = "firecrawl-anydoc==0.2.3"

_CONVERT_CODE = r'''
import json, sys
import anydoc

cfg = json.loads(sys.argv[1])
paths = cfg["paths"]
multiple = len(paths) > 1
failed = 0
for p in paths:
    if multiple:
        sys.stdout.write("\n\n---\n\n# %s\n\n" % p)
    try:
        md = anydoc.to_markdown(p)
        sys.stdout.write(md)
        if not md.endswith("\n"):
            sys.stdout.write("\n")
    except anydoc.ConvertError as e:
        failed += 1
        print("> **%s**: %s - %s" % (p, type(e).__name__, e), file=sys.stderr)
    except OSError as e:
        failed += 1
        print("> **%s**: OSError - %s" % (p, e), file=sys.stderr)
sys.exit(1 if failed else 0)
'''

_STDIN_CODE = r'''
import json, sys
import anydoc

cfg = json.loads(sys.argv[1])
fmt = cfg.get("format")
data = sys.stdin.buffer.read()
try:
    md = anydoc.to_markdown_bytes(data, fmt)
    sys.stdout.write(md)
    if not md.endswith("\n"):
        sys.stdout.write("\n")
except anydoc.ConvertError as e:
    print("> **stdin**: %s - %s" % (type(e).__name__, e), file=sys.stderr)
    sys.exit(2)
'''


def venv_python() -> Path:
    return VENV_DIR / "bin" / "python"


def _ready() -> bool:
    py = venv_python()
    if not py.exists():
        return False
    r = subprocess.run([str(py), "-c", "import anydoc"], capture_output=True)
    return r.returncode == 0


def ensure(force: bool = False) -> None:
    if not force and _ready():
        return
    import venv
    print(f"[docs] creo venv pinnato in {VENV_DIR} (primo uso)...", file=sys.stderr)
    VENV_DIR.parent.mkdir(parents=True, exist_ok=True)
    venv.create(VENV_DIR, with_pip=True)
    subprocess.run([str(venv_python()), "-m", "pip", "install", "--quiet", "--upgrade", "pip"],
                   check=False)
    subprocess.run([str(venv_python()), "-m", "pip", "install", "--quiet", PIN], check=True)


def _run(code: str, payload: dict, input_bytes: bytes | None = None) -> tuple[int, str, str]:
    r = subprocess.run([str(venv_python()), "-c", code, json.dumps(payload)],
                       input=input_bytes, capture_output=True)
    return r.returncode, r.stdout.decode("utf-8", "replace"), r.stderr.decode("utf-8", "replace")


def cmd_doctor() -> int:
    ensure()
    import importlib.metadata
    ver = subprocess.run([str(venv_python()), "-c",
                          "import importlib.metadata as m; print(m.version('firecrawl-anydoc'))"],
                         capture_output=True, text=True).stdout.strip()
    print(f"venv:   {VENV_DIR}")
    print(f"pin:    {PIN}  (installato: {ver})")
    # smoke-test reale
    code, out, _ = _run(_STDIN_CODE, {"format": "csv"}, input_bytes=b"a,b\n1,2\n")
    ok = code == 0 and "| a | b |" in out
    print(f"smoke:  {'OK' if ok else 'FAILED'}")
    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="documenti → Markdown via anydoc")
    ap.add_argument("files", nargs="*", help="file da convertire")
    ap.add_argument("-o", "--output", help="scrivi su file invece di stdout")
    ap.add_argument("--stdin", action="store_true", help="leggi bytes da stdin")
    ap.add_argument("--format", help="formato esplicito (per stdin/CSV senza estensione)")
    ap.add_argument("--install", action="store_true", help="(ri)crea il venv pinnato")
    ap.add_argument("--doctor", action="store_true", help="verifica installazione")
    args = ap.parse_args()

    if args.install:
        ensure(force=True)
        print(f"[docs] venv pronto in {VENV_DIR} ({PIN})")
        return 0
    if args.doctor:
        return cmd_doctor()

    ensure()

    if args.stdin:
        code, out, err = _run(_STDIN_CODE, {"format": args.format}, input_bytes=sys.stdin.buffer.read())
    else:
        if not args.files:
            ap.error("nessun file: passa <file>... o --stdin")
        missing = [f for f in args.files if not Path(f).exists()]
        if missing:
            print("> file inesistenti: " + ", ".join(missing), file=sys.stderr)
            return 2
        if args.output and len(args.files) > 1:
            print("> -o accetta un solo file di input (o usa stdout per più file)", file=sys.stderr)
            return 2
        code, out, err = _run(_CONVERT_CODE, {"paths": args.files})

    if err:
        sys.stderr.write(err)
    if args.output:
        Path(args.output).write_text(out)
        print(f"[docs] scritto {args.output}", file=sys.stderr)
    else:
        sys.stdout.write(out)
    return code


if __name__ == "__main__":
    sys.exit(main())
