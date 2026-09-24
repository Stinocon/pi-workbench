#!/usr/bin/env python3
"""rag.py — retrieval locale universale per pi (SQLite FTS5 + BM25, zero dipendenze).

v2: indice incrementale (mtime_ns per file: rilegge da disco SOLO i cambiati) + comando `status`
(anti-aging: età dell'indice e file modificati dopo l'ultimo index). L'indice FTS5 è rebuildato
da `docs` (copia SQLite interna, non tocca il filesystem) solo quando qualcosa è cambiato.
IDEA distillata da context-mode (mksglu/context-mode, ELv2), reimplementata in forma minima
(solo stdlib `sqlite3`), senza server MCP né sandbox. Provenienza §6 ("idea sì, plugin no").

Uso:
    rag.py index  [--dir .] [--ext md,txt,py,...]   # incrementale
    rag.py search "query" [--k 5]
    rag.py status [--dir .]                          # anti-aging

DB: ~/.pi/agent/rag/<slug-cwd>.db  (un indice per progetto, fuori dal repo, derivato/ricostruibile)
"""
from __future__ import annotations

import argparse
import hashlib
import html
import os
import re
import sqlite3
import time
from pathlib import Path

DB_DIR = Path.home() / ".pi" / "agent" / "rag"
DB_DIR.mkdir(parents=True, exist_ok=True)

# File da indicizzare + cartelle da saltare (derivate/ricostruibili/pesanti)
EXT_DEFAULT = ".md,.txt,.rst,.py,.ts,.tsx,.js,.mjs,.yaml,.yml,.toml,.json,.sh,.sql"
SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "dist", "__pycache__", ".next", ".cache",
             "qdrant_storage", ".crawl4ai", "build", "target", ".pytest_cache", ".mypy_cache",
             ".ruff_cache"}
MAX_FILE_BYTES = 200_000


def _slug(cwd: str) -> str:
    return hashlib.sha256(cwd.encode("utf-8")).hexdigest()[:16]


def _db_path(db: str | None = None) -> Path:
    """DB esplicito (--db) oppure, di default, l'indice per-progetto keyed su cwd."""
    if db:
        return Path(db).expanduser()
    return DB_DIR / f"{_slug(os.getcwd())}.db"


def _init_schema(conn: sqlite3.Connection) -> None:
    # `docs` = fonte di verità (path, mtime, contenuto); `docs_fts` = indice FTS5 standalone
    # (compatibile con la v1: stessa tabella, niente migrazione distruttiva necessaria);
    # `meta` = last_index per l'anti-aging.
    conn.execute("CREATE TABLE IF NOT EXISTS docs(path TEXT PRIMARY KEY, mtime_ns INTEGER NOT NULL, content TEXT)")
    # v2-precedente aveva provato external-content (`content='docs'`), che in questo setup non crea
    # i trigger: se l'fts esistente è di quel tipo, si droppa e si ricrea standalone (derivato, sicuro).
    row = conn.execute("SELECT sql FROM sqlite_master WHERE name='docs_fts'").fetchone()
    if row and row[0] and "content=" in row[0]:
        conn.execute("DROP TABLE docs_fts")
    conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(path UNINDEXED, content)")
    conn.execute("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)")


def _walk(root: Path, exts: set[str], exclude_nested_repos: bool = False):
    """File candidati all'indicizzazione: (rel_path, mtime_ns). Solo stat, niente lettura.

    `os.walk` con pruning invece di `rglob`: rglob percorre tutto e filtra DOPO, quindi indicizzare
    una cartella padre leggeva l'intero albero — compresi i repo annidati — e produceva un indice da
    126 MB per `~/sviluppo` che duplicava quelli dei singoli progetti. Con `exclude_nested_repos` una
    sottocartella che è un repo a sé (contiene `.git`, come directory o come file di worktree) viene
    saltata: la ricerca dal workspace resta utile per i file sciolti, senza ricopiare 17 progetti.
    """
    for dirpath, dirnames, filenames in os.walk(root):
        here = Path(dirpath)
        if here != root and exclude_nested_repos and (".git" in dirnames or ".git" in filenames):
            dirnames[:] = []
            continue
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            p = here / name
            if p.suffix.lower() not in exts:
                continue
            if any(part in SKIP_DIRS for part in p.parts):
                continue
            try:
                st = p.stat()
                if st.st_size > MAX_FILE_BYTES:
                    continue
            except OSError:
                continue
            yield p.relative_to(root).as_posix(), st.st_mtime_ns


def _fts_query(q: str) -> str:
    """Rende la query sicura per FTS5 MATCH: tokenizza, quota ogni termine, unisce in OR."""
    terms = [t for t in re.findall(r"[\w\-\./]+", q, re.UNICODE) if t and not t.isdigit()]
    if not terms:
        return q.replace('"', '""')
    return " OR ".join('"' + t.replace('"', '""') + '"' for t in terms)


def index(root: str, exts: set[str], db: str | None = None, exclude_nested_repos: bool = False) -> None:
    db = _db_path(db)
    conn = sqlite3.connect(db)
    _init_schema(conn)
    root_p = Path(root).resolve()

    current = {rel: mtime for rel, mtime in _walk(root_p, exts, exclude_nested_repos)}
    existing = {rel: mtime for rel, mtime in conn.execute("SELECT path, mtime_ns FROM docs")}

    added = updated = removed = 0
    for rel in list(existing):
        if rel not in current:
            conn.execute("DELETE FROM docs WHERE path=?", (rel,))
            removed += 1
    for rel, mtime in current.items():
        old = existing.get(rel)
        if old == mtime:
            continue
        try:
            content = (root_p / rel).read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        conn.execute(
            "INSERT INTO docs(path, mtime_ns, content) VALUES(?,?,?) "
            "ON CONFLICT(path) DO UPDATE SET mtime_ns=excluded.mtime_ns, content=excluded.content",
            (rel, mtime, content),
        )
        added += old is None
        updated += old is not None

    total = conn.execute("SELECT COUNT(*) FROM docs").fetchone()[0]
    fts_count = conn.execute("SELECT COUNT(*) FROM docs_fts").fetchone()[0]
    # Rebuild FTS se qualcosa è cambiato O se l'indice è andato fuori sync (es. la migrazione ha
    # droppato un fts esterno senza ripopolarlo): copia SQLite interna, nessun I/O su file.
    if added or updated or removed or fts_count != total:
        conn.execute("DROP TABLE IF EXISTS docs_fts")
        conn.execute("CREATE VIRTUAL TABLE docs_fts USING fts5(path UNINDEXED, content)")
        conn.execute("INSERT INTO docs_fts(path, content) SELECT path, content FROM docs")
    conn.execute(
        "INSERT INTO meta(key, value) VALUES('last_index', ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (str(time.time_ns()),),
    )
    conn.commit()
    conn.close()
    print(f"[rag] {root_p.name}: +{added} nuovi, ~{updated} aggiornati, -{removed} rimossi, "
          f"{total} totali -> {db}")


def status(root: str, exts: set[str], db: str | None = None) -> None:
    db = _db_path(db)
    if not db.exists():
        print("[rag] nessun indice per questa cartella. Esegui: rag.py index")
        return
    conn = sqlite3.connect(db)
    row = conn.execute("SELECT value FROM meta WHERE key='last_index'").fetchone()
    total = conn.execute("SELECT COUNT(*) FROM docs").fetchone()[0]
    conn.close()
    if not row:
        print("[rag] indice di versione vecchia (senza metadati): esegui rag.py index per migrare")
        return
    last_ns = int(row[0])
    root_p = Path(root).resolve()
    changed = [rel for rel, mtime in _walk(root_p, exts) if mtime > last_ns]
    days = (time.time_ns() - last_ns) / 1e9 / 86400
    print(f"[rag] indice di {days:.1f} giorni fa, {total} file indicizzati.")
    if changed:
        print(f"[rag] {len(changed)} file modificati DOPO l'ultimo index (indice stantio per questi):")
        for c in changed[:20]:
            print(f"   - {c}")
        if len(changed) > 20:
            print(f"   ... e altri {len(changed) - 20}")
    else:
        print("[rag] aggiornato: nessun file cambiato dall'ultimo index.")


def search(q: str, k: int, db: str | None = None) -> None:
    db = _db_path(db)
    if not db.exists():
        print("[rag] indice assente. Esegui prima: rag.py index")
        return
    conn = sqlite3.connect(db)
    rows = conn.execute(
        "SELECT path, snippet(docs_fts, 1, '⟦', '⟧', '…', 24), bm25(docs_fts) "
        "FROM docs_fts WHERE docs_fts MATCH ? ORDER BY bm25(docs_fts) LIMIT ?",
        (_fts_query(q), k),
    ).fetchall()
    conn.close()
    if not rows:
        print("[rag] nessun risultato.")
        return
    for path, snip, _score in rows:
        clean = html.unescape(re.sub(r"[⟦⟧]", "", snip or "")).strip()
        print(f"### {path}")
        print(clean[:800])
        print()


def main() -> None:
    ap = argparse.ArgumentParser(description="RAG locale universale per pi (FTS5/BM25).")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_idx = sub.add_parser("index", help="indicizza (incrementale)")
    p_idx.add_argument("--dir", default=".")
    p_idx.add_argument("--ext", default=EXT_DEFAULT)
    p_idx.add_argument("--db", default=None, help="DB esplicito (default: indice per cwd)")
    p_idx.add_argument("--no-nested-repos", action="store_true",
                       help="salta le sottocartelle che sono un repo a sé (contengono .git)")
    p_src = sub.add_parser("search", help="cerca")
    p_src.add_argument("query")
    p_src.add_argument("--k", type=int, default=5)
    p_src.add_argument("--db", default=None, help="DB esplicito (default: indice per cwd)")
    p_st = sub.add_parser("status", help="anti-aging: età e file cambiati")
    p_st.add_argument("--dir", default=".")
    p_st.add_argument("--db", default=None, help="DB esplicito (default: indice per cwd)")
    args = ap.parse_args()

    def _exts(s: str) -> set[str]:
        return {e.strip().lower() if e.startswith(".") else "." + e.strip().lower()
                for e in s.split(",") if e.strip()}

    if args.cmd == "index":
        index(args.dir, _exts(args.ext), args.db, args.no_nested_repos)
    elif args.cmd == "search":
        search(args.query, args.k, args.db)
    else:
        status(args.dir, _exts(EXT_DEFAULT), args.db)


if __name__ == "__main__":
    main()
