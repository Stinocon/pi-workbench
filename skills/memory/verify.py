#!/usr/bin/env python3
"""verify.py — evidence-based verification for Pi's structured decision store.

Deterministic, stdlib-only checker for decisions/invariants stored as Markdown files
with YAML frontmatter. It scans two tiers:

  project  <cwd>/.pi/decisions/          (git-tracked, impersonal)
  global   ~/.pi/agent/decisions/        (machine-local, like global memory)

Each decision file declares a verification method in its frontmatter:

  auto   -> run `verify_command` (must be a read-only, deterministic check); pass = exit 0
            (when `verify_anchor` is set, the command output must also contain it)
  read   -> every `evidence` path must exist; when `verify_anchor` is set, at least one
            evidence file must contain that anchor text
  human  -> not auto-verifiable: reported as needs-human, never re-interpreted

Verification results land in a derived sidecar `<decisions-dir>/verification.json`
(gitignored). Decision files themselves are append-only and are NEVER mutated here.

Effective status: a decision is `superseded` when another decision declares
`supersedes: <id>` — computed here, not stored on the old file.

Commands:
  verify.py check [id] [--dir DIR]    verify all decisions (or a single id)
  verify.py status [--dir DIR]        human-readable report (effective status + last result)
  verify.py next-id [--dir DIR]       next free DEC number across the scanned dirs

`check <id>` merges into the sidecar, it never replaces it: the records of the other decisions are
kept. Exit codes for `check`: 0 = ran; 1 = unknown decision id; 2 = a sidecar exists but cannot be
read, so it was left untouched (fail closed — never overwrite records that were not seen).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import date
from pathlib import Path

GLOBAL_DIR = Path.home() / ".pi" / "agent" / "decisions"
SIDECAR = "verification.json"
# Frontmatter keys that are single scalars; `evidence` is the only list handled.
SCALAR_KEYS = (
    "id", "type", "status", "scope", "statement", "reason", "authority",
    "mutable", "verify", "verify_anchor", "verify_command",
    "created", "validated_at", "supersedes",
)
# Never coerced to bool/int: these hold COMMANDS and SEARCH STRINGS, and `verify_command: true`
# becoming the boolean `True` made subprocess choke ("'bool' object is not iterable") — a false FAIL
# on a decision whose evidence was fine. A shell command is a string even when it looks like a number.
NO_COERCE = ("verify_command", "verify_anchor")
# The HEAVY store holds only these types. Facts/preferences/workflows/hypotheses/todos
# belong to the LIGHT tier (free-text MEMORY.md / PROJECT-MEMORY.md), not here.
VALID_TYPES = {"decision", "invariant", "constraint"}
VALID_STATUS = {"proposed", "validated", "superseded", "deprecated", "temporary", "unknown"}
VALID_VERIFY = {"auto", "read", "human"}


def parse_frontmatter(text: str) -> dict:
    """Parse the YAML subset this store uses: scalar `key: value` and a single
    `evidence:` list of `- item` lines. Unknown keys are ignored (forward-compat)."""
    m = re.match(r"^---\s*\n(.*?)\n---", text, re.DOTALL)
    if not m:
        return {}
    fm = m.group(1)
    out: dict = {}
    in_evidence = False
    evidence: list[str] = []
    for raw in fm.splitlines():
        line = raw.rstrip()
        if line.strip() == "evidence:":
            in_evidence = True
            continue
        if in_evidence:
            if re.match(r"^\s+-\s+", line):
                item = re.sub(r"^\s+-\s+", "", line).strip()
                if item:
                    evidence.append(item)
                continue
            # A blank line inside the list is cosmetic. Ending the list on it silently DROPPED every
            # path after it — a false FAIL on evidence that was there.
            if line.strip() == "":
                continue
            in_evidence = False  # evidence list ended; fall through to scalar parse
        if line.strip() == "":
            continue
        kv = re.match(r"^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$", line)
        if kv:
            key, val = kv.group(1), kv.group(2).strip()
            if key in SCALAR_KEYS:
                if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
                    val = val[1:-1]
                if val in ("null", "~", ""):
                    val = None
                elif key in NO_COERCE:
                    val = val
                else:
                    val = _coerce(val)
                out[key] = val
    if evidence:
        out["evidence"] = evidence
    return out


def _coerce(v):
    if v in ("true", "True"):
        return True
    if v in ("false", "False"):
        return False
    if re.fullmatch(r"-?\d+", v):
        return int(v)
    return v


def decision_dirs(extra: list[str] | None) -> list[Path]:
    dirs: list[Path] = []
    if extra:
        dirs.extend(Path(d).expanduser() for d in extra)
    else:
        dirs.append(Path.cwd() / ".pi" / "decisions")
        if GLOBAL_DIR.is_dir():
            dirs.append(GLOBAL_DIR)
    seen, out = set(), []
    for d in dirs:
        key = str(d.resolve())
        if key not in seen:
            seen.add(key)
            out.append(d)
    return out


def base_for_dir(d: Path) -> Path:
    """The dir that evidence/verify_command paths are authored against.

    Canonical layouts:
      <cwd>/.pi/decisions/      -> base = <cwd>   (project root)
      ~/.pi/agent/decisions/    -> base = ~        (home)
    For an arbitrary --dir, fall back to the dir two levels up (the dir that
    contains the dir that contains `decisions/`).
    """
    r = d.resolve()
    if r == GLOBAL_DIR.resolve():
        return Path.home()
    return r.parent.parent


# Anonymizer output must never be read as a decision. `DEC-0012.redacted.md` sorts AFTER
# `DEC-0012.md`, and it carries the same `id`, so the loop below would keep the redacted copy and
# shadow the real record — the verification would then assert a redacted document's anchors.
# `decisions/.gitignore` keeps them out of git; this keeps them out of verification even when they
# are on disk, which is the case the anon tool actually produces.
IGNORED_DECISION_SUFFIXES = (".redacted", ".deanon")


def _is_ignored(name: str) -> bool:
    return any(f"{suffix}." in name for suffix in IGNORED_DECISION_SUFFIXES)


def decision_files(dirs: list[Path]) -> dict[str, tuple[Path, Path]]:
    """Map decision id -> (file path, base). A file is a decision when it parses to an
    `id` and a `type` in VALID_TYPES."""
    found: dict[str, tuple[Path, Path]] = {}
    for d in dirs:
        if not d.is_dir():
            continue
        base = base_for_dir(d)
        for f in sorted(d.glob("*.md")):
            if f.name == "README.md" or _is_ignored(f.name):
                continue
            try:
                fm = parse_frontmatter(f.read_text(encoding="utf-8"))
            except Exception:
                continue
            if fm.get("id") and fm.get("type") in VALID_TYPES:
                found[str(fm["id"])] = (f, base)
    return found


def effective_status(fm: dict, all_parsed: dict[str, dict]) -> str:
    """A decision is superseded when another decision's `supersedes` points at it."""
    if fm.get("status") == "superseded":
        return "superseded"
    my_id = fm.get("id")
    if my_id:
        for other_fm in all_parsed.values():
            if other_fm.get("supersedes") == my_id:
                return "superseded"
    return fm.get("status") or "unknown"


def verify_one(fm: dict, base: Path) -> dict:
    method = fm.get("verify", "human")
    if method not in VALID_VERIFY:
        method = "human"
    result = {"method": method, "ok": False, "detail": ""}

    if method == "human":
        return {**result, "ok": None, "detail": "human decision — re-confirm with user"}

    if method == "auto":
        cmd = fm.get("verify_command")
        if not cmd:
            return {**result, "detail": "verify=auto but verify_command missing"}
        if isinstance(cmd, str) and cmd.strip().lower() in ("true", "false"):
            # Not coercing the value to a bool (an earlier fix) was only half the problem: the string
            # "true" is a shell builtin, so the decision verified PASS while proving nothing.
            return {
                **result,
                "ok": False,
                "detail": f"verify_command is a bare YAML boolean ({cmd!r}), not a command — "
                          "it proves nothing",
            }
        try:
            proc = subprocess.run(
                cmd, shell=True, cwd=str(base), capture_output=True, text=True, timeout=60,
            )
        except subprocess.TimeoutExpired:
            return {**result, "detail": "verify_command timed out"}
        except Exception as e:  # noqa: BLE001
            return {**result, "detail": f"verify_command failed to run: {e}"}
        anchor = fm.get("verify_anchor")
        out = (proc.stdout or "") + (proc.stderr or "")
        if proc.returncode != 0:
            return {**result, "detail": f"exit {proc.returncode}: {out.strip()[:200]}"}
        if anchor and anchor not in out:
            return {**result, "detail": f"anchor {anchor!r} not in command output"}
        return {**result, "ok": True, "detail": "verify_command passed"}

    # method == "read"
    evidence = fm.get("evidence") or []
    if not evidence:
        return {**result, "detail": "verify=read but no evidence paths"}
    anchor = fm.get("verify_anchor")
    missing = []
    if anchor is None:
        # `verify: read` means "a human confirms this by reading the evidence". Without an anchor
        # there is nothing to confirm: the path existing says only that the file was not deleted,
        # and its CONTENT can change while the check still reports PASS. Fail with what to add rather
        # than passing on a weaker condition than the decision asked for.
        return {
            **result,
            "detail": "verify=read with no verify_anchor: nothing to confirm — add the string the "
                      "evidence must contain",
        }
    matched = False
    for rel in evidence:
        p = Path(rel)
        cand = p if p.is_absolute() else base / p
        if not cand.exists():
            missing.append(rel)
            continue
        if anchor and not matched:
            try:
                if anchor in cand.read_text(encoding="utf-8", errors="ignore"):
                    matched = True
            except Exception:
                pass
    if missing:
        return {**result, "detail": f"missing evidence: {', '.join(missing)}"}
    if not matched:
        return {**result, "detail": f"anchor {anchor!r} not found in evidence"}
    return {**result, "ok": True, "detail": "evidence present and anchor matched"}


def load_sidecar(d: Path) -> dict | None:
    """The sidecar as a dict; {} when absent or empty; None when present but not readable as one.

    None is a fail-closed signal, not an empty store: `check` refuses to overwrite a sidecar it
    could not read, because writing this run over it would destroy records it never saw — the same
    data loss the single-id merge exists to prevent. Every way of not reading it (missing
    permission, bad encoding, invalid or non-object JSON) ends here as None.
    """
    p = d / SIDECAR
    if not p.exists():
        return {}
    try:
        raw = p.read_text(encoding="utf-8-sig")  # a BOM is valid JSON once stripped
    except (OSError, UnicodeDecodeError):
        return None
    if not raw.strip():
        return {}
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def write_sidecar(d: Path, data: dict) -> None:
    # Written through a temporary file: a crash mid-write must not leave a truncated sidecar, which
    # would fail closed on the next run and lose the records of decisions that no longer exist.
    tmp = d / f"{SIDECAR}.tmp"
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(tmp, d / SIDECAR)


def cmd_check(args) -> int:
    dirs = decision_dirs(args.dir)
    files = decision_files(dirs)
    if not files:
        print("[verify] no decisions found (nothing under the scanned dirs).")
        return 0
    if args.id and args.id not in files:
        print(f"[verify] unknown decision id: {args.id}")
        return 1

    parsed = {}
    for did, (fp, _base) in files.items():
        parsed[did] = parse_frontmatter(fp.read_text(encoding="utf-8"))

    targets = {args.id: files[args.id]} if args.id else files
    today = date.today().isoformat()
    report = []
    sidecars: dict[Path, dict] = {}
    for did, (fp, base) in targets.items():
        fm = parsed[did]
        eff = effective_status(fm, parsed)
        if eff == "superseded":
            report.append(f"{did}: superseded (skipped — frozen historical record)")
            continue
        if eff != "validated":
            report.append(f"{did}: {eff} (only validated decisions are verified)")
            continue
        res = verify_one(fm, base)
        sidecars.setdefault(fp.parent, {})[did] = {
            "last_verified": today,
            "result": "pass" if res["ok"] is True else ("needs-human" if res["ok"] is None else "fail"),
            "confidence": "high" if res["ok"] is True else "low",
            "method": res["method"],
            "detail": res["detail"],
        }
        verdict = "PASS" if res["ok"] is True else ("NEEDS-HUMAN" if res["ok"] is None else "FAIL")
        report.append(f"{did}: {verdict} — {res['detail']}")

    for d, data in sidecars.items():
        # MERGE, don't clobber: `check <id>` must keep the other decisions' records. A record is
        # pruned only when its decision is really gone: it is neither among the ids discovered in
        # this directory nor still present under the conventional filename. A decision file that
        # exists but was skipped (unreadable, mid-edit, frontmatter that does not parse), and one
        # whose filename differs from its id, both keep their history.
        existing = load_sidecar(d)
        if existing is None:
            print(f"[verify] {d / SIDECAR} cannot be read — refusing to overwrite it; "
                  "fix or remove it and re-run.", file=sys.stderr)
            return 2
        known = {did for did, (fp, _b) in files.items() if fp.parent == d}
        merged = {k: v for k, v in existing.items()
                  if k in known or (d / f"{k}.md").exists()}
        merged.update(data)
        write_sidecar(d, merged)

    print("\n".join(report))
    return 0


def cmd_status(args) -> int:
    dirs = decision_dirs(args.dir)
    files = decision_files(dirs)
    if not files:
        print("[verify] no decisions found.")
        return 0
    parsed = {did: parse_frontmatter(fp.read_text(encoding="utf-8")) for did, (fp, _b) in files.items()}
    lines = []
    for did in sorted(files):
        fm = parsed[did]
        eff = effective_status(fm, parsed)
        sc = (load_sidecar(files[did][0].parent) or {}).get(did)
        sc = sc if isinstance(sc, dict) else {}
        last = sc.get("last_verified", "-")
        res = sc.get("result", "-")
        stmt = str(fm.get("statement", "") or "")
        if len(stmt) > 80:
            stmt = stmt[:77] + "…"
        lines.append(
            f"{did}  [{fm.get('type','?')}]  {eff}  verify={fm.get('verify','human')}  "
            f"last={last}  result={res}  authority={fm.get('authority','-')}  — {stmt}"
        )
    print("\n".join(lines))
    return 0


def cmd_next_id(args) -> int:
    dirs = decision_dirs(args.dir)
    files = decision_files(dirs)
    nums = []
    for did in files:
        m = re.fullmatch(r"DEC-(\d+)", did)
        if m:
            nums.append(int(m.group(1)))
    print(f"DEC-{max(nums) + 1 if nums else 1:04d}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Evidence-based decision verification for Pi")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("check", help="verify decisions against evidence")
    c.add_argument("id", nargs="?", default=None)
    c.add_argument("--dir", action="append", default=None)
    c.set_defaults(fn=cmd_check)
    s = sub.add_parser("status", help="report effective status + last verification")
    s.add_argument("--dir", action="append", default=None)
    s.set_defaults(fn=cmd_status)
    n = sub.add_parser("next-id", help="next free DEC number")
    n.add_argument("--dir", action="append", default=None)
    n.set_defaults(fn=cmd_next_id)
    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
