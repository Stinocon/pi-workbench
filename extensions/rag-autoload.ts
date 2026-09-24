// ~/.pi/agent/extensions/rag-autoload.ts
//
// A ogni avvio di pi re-indicizza il RAG del progetto corrente (rag.py index). È INCREMENTALE:
// rilegge da disco solo i file cambiati (mtime), quindi dopo il primo index è quasi gratis.
// Detached e non bloccante: non ritarda mai l'avvio della sessione. Il DB è per-progetto
// (~/.pi/agent/rag/<slug-cwd>.db), derivato e ricostruibile — non va in git.
//
// `--no-nested-repos`: avviare Pi in una cartella padre indicizzava TUTTO l'albero in un unico DB
// (misurato: 126 MB per ~/sviluppo, che duplica gli indici dei singoli progetti). I repo annidati
// hanno già il loro indice; la ricerca dal workspace resta per i file sciolti.
//
// Serve il tool `rag` (skill globale) già installato in ~/.pi/agent/skills/rag/rag.py.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const RAG = path.join(os.homedir(), ".pi", "agent", "skills", "rag", "rag.py");

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup") return;
    // `ctx.cwd`, not `process.cwd()`: every sibling extension uses the session cwd, and if the two
    // diverge (a session opened elsewhere) the index would be built for the wrong directory.
    const child = spawn("python3", [RAG, "index", "--no-nested-repos"], {
      cwd: ctx.cwd,
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {}); // rag.py scrive su stdout (ignorato): niente da raccogliere
    child.unref();
  });
}
