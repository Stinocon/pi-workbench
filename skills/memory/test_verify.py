#!/usr/bin/env python3
"""test_verify.py — regression tests for the decision-store checker, stdlib only.

Covers the sidecar-write contract: `check <id>` must never destroy the records of the other
decisions, and `check` must never overwrite a sidecar it could not read. Both were real
data-loss bugs — the first clobbered 16 records with 1, the second resurrected that clobber
through the corrupt-file path. Run: `python3 test_verify.py` (or `python3 -m unittest`).
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

VERIFY = Path(__file__).resolve().parent / "verify.py"
SIDECAR = "verification.json"

DECISION = """---
id: {did}
type: invariant
status: validated
scope: project
statement: "fixture {did}"
reason: "fixture"
evidence:
  - {evidence}
authority: low
mutable: false
verify: read
created: 2026-01-01
supersedes: null
---

# {did}
"""


class VerifySidecarTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.evidence = self.dir / "evidence.md"
        self.evidence.write_text("fixture\n", encoding="utf-8")
        self.ids = ["DEC-0001", "DEC-0002", "DEC-0003"]
        for did in self.ids:
            self.write_decision(did)

    def tearDown(self) -> None:
        for did in self.ids:
            p = self.dir / f"{did}.md"
            if p.exists():
                p.chmod(0o644)
        self._tmp.cleanup()

    def write_decision(self, did: str) -> None:
        (self.dir / f"{did}.md").write_text(
            DECISION.format(did=did, evidence=self.evidence), encoding="utf-8",
        )

    def run_check(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(VERIFY), "check", *args, "--dir", str(self.dir)],
            capture_output=True, text=True,
        )

    def sidecar(self) -> dict:
        return json.loads((self.dir / SIDECAR).read_text(encoding="utf-8"))

    def test_single_id_keeps_the_other_records(self) -> None:
        self.assertEqual(self.run_check().returncode, 0)
        self.assertEqual(sorted(self.sidecar()), self.ids)

        self.assertEqual(self.run_check("DEC-0002").returncode, 0)
        self.assertEqual(sorted(self.sidecar()), self.ids)
        self.assertEqual(self.sidecar()["DEC-0002"]["result"], "pass")

    def test_full_run_prunes_a_removed_decision(self) -> None:
        self.run_check()
        (self.dir / "DEC-0003.md").unlink()
        self.assertEqual(self.run_check().returncode, 0)
        self.assertEqual(sorted(self.sidecar()), self.ids[:2])

    def test_a_decision_that_cannot_be_read_keeps_its_record(self) -> None:
        self.run_check()
        path = self.dir / "DEC-0003.md"
        path.chmod(0o000)
        try:
            path.read_text(encoding="utf-8")
            self.skipTest("cannot make a file unreadable for this user")
        except OSError:
            pass
        self.assertEqual(self.run_check().returncode, 0)
        self.assertIn("DEC-0003", self.sidecar())

    def test_a_corrupt_sidecar_is_refused_not_overwritten(self) -> None:
        garbage = "{ this is not json"
        (self.dir / SIDECAR).write_text(garbage, encoding="utf-8")
        res = self.run_check()
        self.assertEqual(res.returncode, 2)
        self.assertEqual((self.dir / SIDECAR).read_text(encoding="utf-8"), garbage)

    def test_a_non_object_sidecar_is_refused_not_overwritten(self) -> None:
        for garbage in ("[]", "42", '"a string"'):
            (self.dir / SIDECAR).write_text(garbage, encoding="utf-8")
            self.assertEqual(self.run_check().returncode, 2, garbage)
            self.assertEqual((self.dir / SIDECAR).read_text(encoding="utf-8"), garbage)

    def test_an_unreadable_sidecar_is_refused_not_overwritten(self) -> None:
        self.run_check()
        before = self.sidecar()
        path = self.dir / SIDECAR
        path.chmod(0o000)
        try:
            path.read_text(encoding="utf-8")
            self.skipTest("cannot make a file unreadable for this user")
        except OSError:
            pass
        try:
            self.assertEqual(self.run_check().returncode, 2)
        finally:
            path.chmod(0o644)
        self.assertEqual(self.sidecar(), before)

    def test_a_decision_file_not_named_after_its_id_keeps_its_record(self) -> None:
        (self.dir / "DEC-0002.md").unlink()
        (self.dir / "renamed.md").write_text(
            DECISION.format(did="DEC-0002", evidence=self.evidence), encoding="utf-8",
        )
        self.run_check()
        self.assertEqual(self.run_check("DEC-0001").returncode, 0)
        self.assertIn("DEC-0002", self.sidecar())

    def test_status_survives_a_record_that_is_not_an_object(self) -> None:
        self.run_check()
        data = self.sidecar()
        data["DEC-0002"] = "not an object"
        (self.dir / SIDECAR).write_text(json.dumps(data), encoding="utf-8")
        res = subprocess.run(
            [sys.executable, str(VERIFY), "status", "--dir", str(self.dir)],
            capture_output=True, text=True,
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertIn("DEC-0002", res.stdout)

    def test_a_sidecar_with_a_byte_order_mark_is_still_read(self) -> None:
        self.run_check()
        before = self.sidecar()
        raw = (self.dir / SIDECAR).read_text(encoding="utf-8")
        (self.dir / SIDECAR).write_text("\ufeff" + raw, encoding="utf-8")
        self.assertEqual(self.run_check("DEC-0001").returncode, 0)
        self.assertEqual(sorted(self.sidecar()), sorted(before))

    def test_a_sidecar_with_invalid_utf8_is_refused(self) -> None:
        (self.dir / SIDECAR).write_bytes(b'{"DEC-0001": "\xff\xfe"}')
        before = (self.dir / SIDECAR).read_bytes()
        self.assertEqual(self.run_check().returncode, 2)
        self.assertEqual((self.dir / SIDECAR).read_bytes(), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
