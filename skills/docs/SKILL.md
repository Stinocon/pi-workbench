---
name: docs
description: Convert office documents (Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV, PDF) into clean GitHub-Flavored Markdown with anydoc. Use when you need to turn a document into LLM-ready Markdown for RAG, agents or pipelines. Global tool (docs.py) available from any project, no Docker, no per-project deps. NOT for web pages (use crawl) or SEO audits (use site-audit).
summary: office/PDF documents → Markdown (anydoc; local, no Docker)
---

# Docs — documenti → Markdown con anydoc

## Quando usarlo

Quando serve convertire **documenti** (non pagine web) in Markdown pulito per RAG/pipeline:
Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV, PDF. Il motore è **anydoc**
(firecrawl/anydoc): libreria Rust con binding Python, MIT, ~18k stelle.

È il terzo pezzo del pattern di acquisizione:

- **`crawl`** (crawl4ai) → pagine web → Markdown
- **`docs`** (anydoc) → documenti → Markdown
- **`site-audit`** (LibreCrawl) → report SEO (ambito separato)

## Tool globale: `docs.py`

> Esposto anche come **tool nativo pi** `doc_to_markdown(path, output?)` (estensione
> `docs.ts`) — da usare quando il modello deve convertire un documento direttamente, senza
> passare da bash. Entrambi delegano allo stesso `docs.py`.

Disponibile da **qualunque progetto**, senza dipendenze nel venv del progetto: il launcher è
stdlib-only e al primo uso crea un venv pinnato in `~/.pi/agent/venvs/anydoc-venv`
(machine-local, non versionato — come `~/.pi/agent/rag`).

```bash
~/.pi/agent/skills/docs/docs.py report.docx                 # Markdown su stdout
~/.pi/agent/skills/docs/docs.py report.docx -o report.md    # su file
~/.pi/agent/skills/docs/docs.py a.docx b.xlsx               # più file, separati da header
~/.pi/agent/skills/docs/docs.py --stdin --format csv        # bytes da stdin
~/.pi/agent/skills/docs/docs.py --doctor                    # verifica venv + smoke-test
~/.pi/agent/skills/docs/docs.py --install                   # (ri)crea il venv pinnato
```

Il formato è rilevato dai **bytes** (header PDF, stream OLE, mimetype ZIP), non dall'estensione.
Errori per file (unconvertibile, criptato, malformato) sono segnalati su stderr senza bloccare
gli altri file; exit code 1 se almeno uno fallisce.

## Uso come libreria (dentro un progetto)

Quando la conversione fa parte di un pipeline del progetto, importa la libreria direttamente
nel venv di quel progetto (`pip install firecrawl-anydoc`, pinna la versione):

```python
import anydoc

markdown = anydoc.to_markdown("report.docx")          # da path
markdown = anydoc.to_markdown_bytes(data)             # da bytes (formato rilevato dal contenuto)
markdown = anydoc.to_markdown_bytes(data, "csv")      # CSV non ha firma → formato esplicito
document = anydoc.to_document(data)                   # modello completo + asset incorporati
```

## Vincoli e limiti

1. **Locale by design**: puro Rust, nessun modello ML, nessun servizio esterno. Il dato non
   lascia la macchina.
2. **PDF scansionati/immagini: non gestiti.** anydoc converte PDF *testuali* (via
   pdf-inspector); per pagine scansionate serve OCR. La Parse API ospitata di Firecrawl fa
   OCR ma manda i dati sul loro cloud → **off-limits** per dati privati. Se serve OCR locale,
   integrarlo come passo separato.
3. **Progetto giovanissimo** (~2 settimane): è di Firecrawl (azienda), ruote già su PyPI, ma
   pinna comunque la versione (AGENTS.md §6) — nel tool globale è pinnato a `==0.2.3`.

## Contratto

- **produce:** Markdown GFM pulito da un documento
- **consuma:** un file documento (path) o bytes

## Provenienza

anydoc (firecrawl/anydoc), MIT. Binding Python `firecrawl-anydoc` **0.2.3** (pinnato nel venv
globale). Il wrapper `docs.py` è nostro (pattern rag.py). La conversione di sorgenti locali
(pdf/markdown) è il punto naturale di integrazione come libreria.
