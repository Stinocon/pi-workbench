---
name: rag
description: Universal local retrieval over the current project's text files (SQLite FTS5 + BM25). Use when you need to find where a concept, term, symbol, or piece of logic lives across a repo's docs/code WITHOUT dumping whole files into context — retrieve relevant snippets with their file path, then read only what matters. Local-only, zero dependencies, no data leaves the machine.
summary: universal local retrieval (SQLite FTS5 + BM25) over any project
---

# RAG — retrieval locale universale per qualunque progetto

## Quando usarlo

Quando devi trovare **dove** vive un concetto, termine, simbolo o logica in un progetto — senza
leggere 50 file nel contesto. Indicizza i file del repo in un indice FTS5 locale e recupera i soli
frammenti pertinenti con il loro path, poi leggi solo ciò che conta.

**Non è il RAG di PersonalFinance** (corpus finanziario con Qdrant, ibrido denso+sparso, affidabilità
delle fonti): questo è il retrieval **generico** per *qualunque* repo, leggero e a costo zero.

## Comandi

```bash
# indicizza il repo corrente (INCREMENTALE: rilegge solo i file cambiati)
python3 ~/.pi/agent/skills/rag/rag.py index

# cerca (BM25, snippet con path)
python3 ~/.pi/agent/skills/rag/rag.py search "come calcolo il drift" --k 5

# anti-aging: età dell'indice + file modificati dopo l'ultimo index
python3 ~/.pi/agent/skills/rag/rag.py status

# indicizza un'altra cartella / altre estensioni
python3 ~/.pi/agent/skills/rag/rag.py index --dir /percorso/repo --ext md,py,ts

# DB esplicito: indice/cerca su un DB diverso da quello per-cwd (usato da /memory)
python3 ~/.pi/agent/skills/rag/rag.py index --dir ~/.pi/agent/memory --db ~/.pi/agent/rag/memory-global.db
python3 ~/.pi/agent/skills/rag/rag.py search "pnpm" --db ~/.pi/agent/rag/memory-global.db
```

## Regole d'uso

1. **Auto-index**: l'estensione `rag-autoload` re-indicizza il progetto a ogni avvio di pi
   (incrementale, quasi gratis). Manualmente: `rag.py index`.
2. **Anti-aging**: `rag.py status` dice da quanto l'indice è stantio e quali file sono cambiati dopo
   l'ultimo index — prima di fidarti di un risultato, controlla che il file non sia cambiato.
3. **Il risultato è una mappa, non la risposta**: ti dice *dove* guardare; poi leggi il file con `read`
   per il contesto completo e la correttezza.
4. **Local-only**: nessun dato lascia la macchina. Sicuro anche su repo con contenuti privati.
5. **Non sostituisce `grep`** per match esatti su simboli: FTS5/BM25 serve per *ricerca lessicale
   su testo naturale* (concetti, doc, spiegazioni). Per un simbolo esatto usa `grep -rn`.

## Provenienza

Idea distillata da `context-mode` (mksglu/context-mode, ELv2): l'intuizione valida è "indicizza in
FTS5 e recupera solo il pertinente con la fonte, invece di riversare file interi nel contesto".
Reimplementato in forma nostra, minimale (solo stdlib `sqlite3`), senza server MCP né dipendenze.
Nessun codice copiato — "idea sì, plugin no" (AGENTS.md §6).
