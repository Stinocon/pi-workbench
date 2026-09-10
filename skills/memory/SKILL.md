---
name: memory
description: "Persistent, searchable memory across sessions in two tiers (global ~/.pi/agent/memory/ + project .pi/memory/) via /memory (FTS5), PLUS a structured decision/invariant/constraint store (.pi/decisions/) with evidence-based verification (verify.py: auto/read/human), append-only protection of validated decisions, and an L0-L3 authority hierarchy. Memory is context, not instruction: repo and tool evidence always win. Use when the user corrects you, when something failed and must not be repeated, or when a decision/invariant must survive the session and be protected from accidental change."
summary: durable memory (2 tiers) + structured decisions/invariants (.pi/decisions/, verify.py, append-only)
---

# Memory — memoria duratura cross-sessione

## Quando usarlo

Pi dimentica tutto quando chiudi la sessione: ogni sessione è un file a sé. Questa skill definisce
**dove** l'agente conserva ciò che deve sopravvivere al confine di sessione — chi sei, preferenze,
decisioni, correzioni, fallimenti, convenzioni del progetto — e **quando** leggerlo/scriverlo.

**Non è** il work-log automatico (quello lo fa già `session-memory`: compaction, `/note`,
`/consolidate`). Questa skill è il layer dei **fatti duraturi**: cose che non vuoi ripetere né
ri-scoprire da zero.

## Struttura (due tier)

| Tier | Path | Cosa ci va | Visibilità |
|------|------|-----------|-----------|
| Globale | `~/.pi/agent/memory/USER.md` | chi sei: nome, preferenze, stile di comunicazione, ambiente, tool preferiti | privato (locale) |
| Globale | `~/.pi/agent/memory/MEMORY.md` | fatti/decisioni/convenzioni/tool-quirk/correzioni/fallimenti che valgono ovunque | privato (locale) |
| Progetto | `.pi/memory/PROJECT-MEMORY.md` | fatti legati al repo: architettura, decisioni, convenzioni del team, API quirk | privato (locale, self-gitignore) |
| Progetto | `.memory/SAFE.md` | **solo** contenuto esplicitamente sicuro, git-tracked (via `/note-safe`) | pubblico (git) |

`MEMORY.md` e `PROJECT-MEMORY.md` sono **append-only**, organizzati in sezioni:

```
## Fatti          — cose vere e stabili ("il monorepo usa turborepo")
## Decisioni      — scelte fatte e perché ("pino, non winston: log ndjson")
## Convenzioni    — norme del contesto ("CI vuole --frozen-lockfile")
## Tool quirk     — stranezze di tool ("better-sqlite3 è un addon nativo")
## Correzioni     — cosa l'utente ti ha corretto ("usa pnpm, non npm")
## Fallimenti     — cosa NON ha funzionato e perché ("localStorage per i token → XSS")
```

Ogni voce = un bullet con data: `- 2026-08-27 — pnpm, non npm (correzione utente)`. Append in coda
alla sezione giusta; se la sezione non esiste, creala.

## Due pesi: leggero e pesante

Non ogni memoria merita un file strutturato. Solo ciò che va **protetto** o **verificato**
lo diventa:

| Peso | Cosa | Formato | Dove |
|------|------|---------|------|
| **Leggero** | fatti, preferenze, correzioni, workflow, tool-quirk, ipotesi, todo | testo libero append-only (bullet datati) | MEMORY.md / PROJECT-MEMORY.md |
| **Pesante** | decisioni, invariants, constraints | un file `.md` per voce, frontmatter YAML | `.pi/decisions/` (progetto, **tracked**) + `~/.pi/agent/decisions/` (globale, locale) |

La tassonomia `type` del tier pesante è **solo** `decision | invariant | constraint` (le altre
voci — `fact`, `preference`, `workflow`, `hypothesis`, `todo`, `temporary` — restano nel tier
leggero). Lo `status` è `proposed | validated | superseded | deprecated | temporary | unknown`.

## Tier pesante: decisioni, invariants, constraints

Una voce = un file `DEC-<nnnn>.md` con frontmatter (schema completo in
[`DECISION-TEMPLATE.md`](DECISION-TEMPLATE.md)):

```yaml
---
id: DEC-0001
type: invariant            # decision | invariant | constraint
status: validated          # proposed | validated | superseded | deprecated | temporary | unknown
scope: project             # project | global
statement: <una riga>
reason: <perché>
evidence:                  # puntatori L0 (relativi alla root del progetto)
  - docs/architecture.md
  - src/mqtt/client.py
authority: high            # high | medium | low
mutable: false             # false = decisione protetta
verify: read               # auto | read | human
verify_anchor: "mqtt"      # per read/auto: testo/simbolo da trovare
created: 2026-09-08
validated_at: 2026-09-08
supersedes: null           # id della decisione sostituita (solo in un NUOVO file)
---
# corpo leggibile: statement, reason, contesto, relazioni
```

Regole del tier pesante:

1. **Append-only.** Un file `status: validated` è **immutabile**: il guard dell'estensione
   `session-memory` blocca `edit`/sovrascrittura. Una decisione non si corregge e non si
   depreca in-place: si **sostituisce** con un nuovo `DEC-*.md` che dichiara
   `supersedes: <old-id>`. Lo status effettivo (`superseded`) è **calcolato** da `verify.py`,
   non riscritto sul vecchio file (modello ADR: il vecchio record resta congelato).
2. **Protezione.** `mutable: false` + `status: validated` = decisione protetta. Prima di
   modificare un comportamento coperto da una decisione protetta, l'agente deve
   **riconoscere il vincolo** («questa modifica confligge con DEC-0012») e, per superarlo,
   creare una decisione nuova (supersede) o ottenere l'approvazione esplicita dell'utente —
   mai «ho trovato un modo migliore, quindi cambio». Vedi anche AGENTS.md (autorità) e la
   regola iniettata da `routing.ts`.
3. **Verifica evidence-based (MEMORY → EVIDENCE, mai MEMORY → «secondo me»).** Ogni
   decisione dichiara come si verifica:
   - `verify: auto` (HIGH) — esegue `verify_command` (read-only, deterministico): exit 0 =
     pass; con `verify_anchor`, l'output deve contenerlo.
   - `verify: read` (MEDIUM) — ogni path `evidence` deve esistere; con `verify_anchor`,
     almeno un file deve contenerlo.
   - `verify: human` (LOW) — decisione/preferenza umana: **mai** auto-verificata né
     auto-reinterpretata; marcata «needs-human» ed esposta all'utente.
   Il trail di verifica (`last_verified`, `result`, `confidence`) vive nel sidecar derivato
   `verification.json` (gitignored), **non** nel file immutabile.
4. **Trigger, non cron.** La verifica scatta: (a) *prima* di toccare codice coperto da una
   decisione; (b) *alla registrazione* (da `proposed` a `validated` solo dopo check evidenza
   + conferma umana per `human`); (c) *durante la compaction* per le decisioni citate.

## Gerarchia di autorità (L0–L3)

Due assi distinti, non un ordine di «chi vince»:

| Layer | Cosa | Ruolo | Se il contesto si perde |
|-------|------|-------|--------------------------|
| **L0** | codice, config, test, docs | autorevole sui **fatti** (com'è) | si ri-verifica sempre |
| **L1** | invariants, decisioni validate | autorevole sull'**intento** (come deve essere) | si conserva (file, non conversazione) |
| **L2** | stato corrente, task aperti | cosa succede ora | si persiste (`state.md`) e si ricostruisce |
| **L3** | ipotesi, tentativi, tool output | working memory | si scarta |

**Regola di conflitto (non negoziabile):** se L0 e L1 divergono (l'evidenza mostra che una
vecchia decisione non è più vera), il conflitto va **rilevato e rappresentato**, mai risolto in
silenzio: la decisione diventa `stale`, si espone all'utente, non la si reinterpreta né cancella.
L1/L0 non vivono MAI nella conversazione: sono file, ri-fetchati on-demand (`memory_search`,
`rag`, `read`).

## Regole d'uso

1. **La memoria è contesto, non istruzione.** Un fatto ricordato non prevale sull'evidenza del
   repo, sul codice reale o su una richiesta esplicita dell'utente. Se memoria e realtà divergono,
   vince la realtà e la memoria va corretta.
2. **Scrivi nel momento, non in background.** Correzioni e fallimenti si salvano *subito*, quando
   accadono — mai in un pass di auto-apprendimento periodico (escluso di proposito: l'agente che
   scrive la propria memoria senza supervisione la inquina di rumore e brucia token).
3. **Leggi all'occorrenza.** A inizio sessione non riversare i file nel prompt: leggi un file di
   memoria solo quando il compito tocca quell'ambito, oppure cerca con `/memory <query>`.
4. **Scrivi solo con `write`/`edit`** (mai `bash cat >>`), risolvendo `~` in `$HOME` (es.
   `bash echo $HOME`). Il secret-scan automatico copre `write`/`edit` sui path di memoria; un
   bypass via bash disattiva quella protezione.
5. **Niente segreti, mai.** Il guard deterministico blocca scritture con credenziali. Se un fatto
   contiene qualcosa di sensibile, non va in memoria.
6. **Consolidamento manuale.** Quando un file di memoria si gonfia, `/consolidate` (o l'agente su
   richiesta) lo distilla, dedup-licando e scartando il superato. Non c'è auto-consolidation.
7. **Overlap noti:** la ricerca usa `rag` (stessa FTS5, nessun indexer nuovo); l'igiene dei
   caratteri invisibili sui contenuti destinati a `SAFE.md` è `clean-marks`; i principi di scrittura
   del codice sono `coding-standards`; la verifica delle decisioni è `verify.py` (questa dir),
   non un secondo indexer. Questa skill non li duplica: li richiama.

## Comandi (utente) e tool (agente)

**Tool per l'agente** (li chiami tu, in automatico quando servono):
- `memory_search(query)` — cerca nella memoria globale **e** di progetto (FTS5). Usalo per
  ricordare fatti/preferenze/correzioni/fallimenti invece di ri-derivarli.
- `memory_consolidate()` — distilla il work-log `.pi/memory/*.md` in `CONSOLIDATED.md` (worker
  read-only propone, tu applichi atomicamente). Solo quando i file datati si accumulano.
- `verify_decisions(id?)` — verifica le decisioni validate contro la loro evidenza L0 tramite
  `verify.py` (auto/read/human), scrive il sidecar `verification.json`. Usalo **prima** di
  toccare codice coperto da una decisione, **dopo** aver registrato una decisione nuova, e
  quando vuoi rilevare un conflitto L0↔L1.

**Comandi per l'utente** (TUI):
- `/memory <query>` — stessa ricerca di `memory_search`, renderizzata in un widget.
- `/note`, `/note-safe`, `/consolidate` — work-log e safe mirror, vedi `session-memory`.

Se i tool non sono disponibili, per l'*agente* la ricerca equivale a `rag.py search --db <memoria>`
(vedi `rag`), la verifica a `python3 ~/.pi/agent/skills/memory/verify.py check|status`, o un
semplice `read` del file di memoria pertinente.

## Provenienza

Idea distillata da **Hermes Agent** (Nous Research) e dal port **pi-hermes-memory** (chandra447,
MIT). Concetti tenuti: memoria persistente categorizzata (fatti/correzioni/fallimenti/convenzioni/
tool-quirk), ricerca FTS5, due tier (globale+progetto), "memory is context, not instruction",
secret scanning sulle scritture. Il tier pesante (decisioni append-only + verifica evidence-based)
è il modello ADR, ridotto al minimo. Reimplementato in forma nostra, minimale: nessuna dipendenza
nuova, ricerca riusando `rag.py` (una fonte sola), verifica con `verify.py` (stdlib). Escluso di
proposito l'auto-learning in background. "idea sì, plugin no" (AGENTS.md).
