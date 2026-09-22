---
name: anon
description: Anonymize sensitive documents BEFORE they enter Pi (client names, people, emails, phones, IPs, hostnames, URLs, API keys) with a deterministic local engine, then work on the redacted copy and re-apply the real values to the final document. Use when a task involves a client document, a contract, a network dump, a CV, an invoice, logs or any text with real names or addresses, or when the anon-guard extension blocks a read. Local-only, no LLM, no network. Does NOT protect against contextual references ("the client from Brescia") — the redacted copy must still be reviewed before sending.
summary: anon → work → deanon (deterministic, local; maps never leave ~/.anon)
---

# anon — anonimizzare prima di mandare a Pi

Motore **deterministico e locale** (`~/.anon/anon.py`): regex + dizionario curato, Python
stdlib, zero dipendenze, zero rete. **Non usa un LLM**: per anonimizzare un modello dovrebbe
prima *ricevere* i dati. Solo DOPO la redazione il testo può entrare nel contesto.

## Contract

- **consumes** — un file di testo (o un documento convertito: usa la skill `docs` / il tool
  `doc_to_markdown` per ottenere prima il `.md`).
- **produces** — `<nome>.redacted.<ext>` (da lavorare in Pi) + una mappa reversibile
  `~/.anon/maps/<id>.map.json` (contiene i valori **reali**: non entra mai nel contesto).

## Workflow

```bash
# 1. redigi — NON aprire il documento originale con `read`
python3 ~/.anon/anon.py ~/sviluppo/cliente/verbale.txt
#    -> verbale.redacted.txt  +  ~/.anon/maps/<id>.map.json

# 1a. su una cartella intera: prima l'anteprima, poi il giro vero
python3 ~/.anon/anon.py ~/sviluppo/cliente --batch --dry-run   # cosa cambierebbe, senza scrivere
python3 ~/.anon/anon.py ~/sviluppo/cliente --batch             # scrive solo i *.redacted.*
#    (i binari li salta: vanno convertiti prima, vedi sotto)

# 1b. (opzionale) solo il controllo, nessuna scrittura — exit 1 se trova qualcosa
python3 ~/.anon/anon.py ~/sviluppo/cliente/verbale.txt --check --json

# 2. leggi SOLO il redacted, lavora su quello, produci il documento finale
#    (il finale contiene i placeholder [CLIENTE-1-a3f9d1], [EMAIL-1-a3f9d1], ...)

# 3. riapplica i valori reali al documento finale
python3 ~/.anon/deanon.py finale.txt ~/.anon/maps/<id>.map.json
#    -> finale.deanon.txt (da consegnare)
```

Dalla sessione Pi ci sono due comandi:

- `/anon <file>` sanitizza e incolla il **redatto** nell'editor, pronto da inviare.
- `/deanon <file> [<mappa|id-mappa>]` riapplica i valori reali e li scrive in un **file**, senza
  incollarli nell'editor: sono esattamente ciò che il guard tiene fuori dal contesto. Se la mappa
  non è indicata la deduce dal campo `output` registrato nelle mappe; se non ne trova **una sola**
  non tira a indovinare, elenca le candidate e chiede quale.

Il giro completo (`anon → lavoro → deanon`) resta quindi: il modello vede solo placeholder, i
valori reali compaiono solo nel file finale.

**Web UI locale** (stesso motore, nessuna reimplementazione): `docker compose up -d` nel repo
`anon-tool` → http://127.0.0.1:1407, oppure `python3 ~/.anon/web/server.py`. Quattro schede:
Anonimizza, Deanonimizza (con la mappa da scegliere), Verifica, Dizionario. Utile quando il lavoro
non passa da Pi: il contenuto resta sulla macchina e non entra in nessun contesto.
**Loopback-only**: la porta si pubblica solo su 127.0.0.1 — la UI non ha autenticazione.

**Opzioni utili** — `--out PATH` (dove scrivere il redatto; `DIR` in `--batch`), `--map PATH` (dove scrivere la
mappa), `--dry-run` (mostra cosa verrebbe redatto e dove, senza scrivere nulla), `--batch`
(una directory: salta i binari, salta i propri output, rifiuta la cartella privata),
`--entities PATH` (ripetibile: sostituisce i tre file di default), `--allow PATH`, `--allow-glob GLOB` (glob dichiarato non-sensibile per
quel solo run, ripetibile; stessa sintassi di `allow.txt`), `--stdout` (nessun file), `--check`/`--json`,
`--no-hosts` (salta le euristiche host/telefono/IP), `--quiet`, `--prune-maps DAYS`
(elenca le mappe piu vecchie di DAYS; aggiungi `--yes` per cancellarle davvero).

### Documenti Office/PDF (.docx, .pdf, .xlsx, …)

Il sorgente è binario: la regex non lo vede. Il percorso corretto è **convertire su file**, poi
anonimizzare il Markdown, poi lavorare sul redatto:

```
doc_to_markdown(path="verbale.docx", output="verbale.md")   # scrive, non restituisce
/anon verbale.md                                             # -> verbale.redacted.md
<leggi verbale.redacted.md, lavora, produci finale.md>
python3 ~/.anon/deanon.py finale.md ~/.anon/maps/<id>.map.json
```

Se il report finale deve essere Word, consegnare il Markdown de-anonimizzato (o riconvertirlo).
Il guard blocca `doc_to_markdown` **senza** `output` quando il Markdown contiene dati sensibili:
non è un vicolo cieco, è l'indicazione di usare `output`.

**Cosa la conversione NON porta con sé** (misurato, `scripts/convert-fidelity.py`: 11 di 17
caratteristiche preservate): intestazione e piè di pagina, commenti, proprietà del documento
(titolo, **autore**) e le cancellazioni tracciate. Sono testi che **il motore non vede, quindi non
redige**, e restano nel `.docx` originale e in ogni PDF esportato da esso. Prima di consegnare un
contenitore: consegna il Markdown rigenerato (che non li contiene) oppure elimina metadati e
cronologia revisioni dal file finale. Non chiedere al modello di "pulire" il `.docx`: non lo vede.

`anon.py` **rifiuta** i file binari (exit 2, nessun file scritto: `docx`/`xlsx`/`pptx`/`odt`,
PDF, immagini). È deliberato: leggere un `.docx` come testo redigerebbe quasi nulla e
lascerebbe una copia corrotta chiamata `*.redacted.docx`, cioè un file che *sembra*
anonimizzato e non lo è. Se vedi `REFUSED`, la strada è la conversione qui sopra.

## Regole (invarianti)

1. **Non alterare i placeholder.** Ogni placeholder porta un suffisso che identifica la mappa
   (`[EMAIL-1-a3f9d1]`): se lo rinomini, lo accorci o lo "semplifichi" in `[EMAIL-1]`, la
   deanonimizzazione non riconosce più il token e il documento non è consegnabile. I placeholder
   si copiano **verbatim**, come qualsiasi altra parte del testo.
2. **Mai il file originale dentro Pi.** Se `read` viene bloccato da `anon-guard`, non aggirarlo:
   anonimizza e leggi il `.redacted`.
3. **`~/.anon/maps/` non entra mai nel contesto.** Contiene i valori reali. `anon-guard`
   blocca la lettura di quella directory; non forzare.
4. **Aggiorna il dizionario.** Il dizionario è diviso per tipo, in `~/.anon`: `entities.txt`
   (generico), `people.txt` (`@type PERSONA`, poi un valore per riga; `Nome Cognome|email` per
   l'alias) e `clients.txt` (`@type AZIENDA`: ragione sociale e sedi). Tutti opzionali e letti
   insieme; `--entities PATH` (ripetibile) li sostituisce. Case e forme legali sono già tollerate
   (`Spa` = `SPA`, `srl` = `S.r.l.`). Le regex coprono email/IP/telefoni/hostname/chiavi; i
   **nomi propri** no — quelli stanno nel dizionario.
   Le direttive (`@type`, `@stem`, `@match`, `@context`) valgono per le voci che **seguono**, e una
   successiva sostituisce la precedente: `@context off` chiude il blocco aperto da un `@context`
   (senza, per restringere un contesto bisognerebbe riordinare il file).
5. **Rivedi il redacted prima di lavorarci.** La regex non coglie i riferimenti contestuali
   ("il cliente di Brescia", "il fornitore che inizia per A"). Quel residuo è un giudizio, non
   un match: leggilo e, se serve, aggiungi l'entità al file giusto (`people.txt` / `clients.txt`) e ripeti.
6. **Idempotente e lossless.** Anonimizzare due volte non corrompe; `deanon` ricostruisce
   l'originale byte per byte. Il giro `anon → deanon` non perde nulla.
7. **Locale.** Nessuna telemetria, nessuna rete, nessun upload.

## `anon-guard` (safety-net)

L'estensione `anon-guard.ts` intercetta `read` e `doc_to_markdown` e **blocca** (non avvisa) un
file con contenuto sensibile non redatto. Quando scatta, il messaggio dice come procedere:
anonimizzare il file, oppure — se il file è legittimamente pubblico — aggiungere un glob in
`~/.anon/allow.txt` (dal comando `/anon-allow <path>`: chiede conferma e appende la riga).

Per una deroga che vale **solo per la sessione corrente**, senza toccare il file:
`pi --anon-guard-allow='/a/*,/b/*'` (o `PI_ANON_GUARD_ALLOW`). I glob di sessione vengono passati
al motore come `--allow-glob`, così resta il motore l'unico giudice di cosa è "consentito".

**Perimetro di enforcement** (preciso, non implicito):

| Modalità | Copre |
|---|---|
| `on` (default) | `read` + `doc_to_markdown` (sorgente e Markdown prodotto) |
| `all` | come `on`, **più** l'output di `bash` e `grep` |
| `off` | nessun blocco |

- `pi --anon-guard=off` (o `all`) per sessione; `PI_ANON_GUARD=0` via ambiente.
- Il blocco su `read` di `~/.anon/maps/` è **incondizionato** (anche via symlink).
- **Documenti binari** (`.docx/.xlsx/.pptx/.odt`, `.pdf`, `.doc/.xls/.ppt`, archivi): **non
  scansionabili** — il tool `read` di Pi li decodifica come testo (`toString("utf-8")`) e ne
  passerebbe il contenuto al modello, quindi "non scansionabile" non è "pulito". La guardia tenta
  la **bonifica**: converte e anonimizza in un sottoprocesso locale (nessun LLM, nessuna rete),
  scrive la copia redatta in `~/.anon/auto/` (0600) e **riscrive il `read` su quella copia**: nel
  contesto entrano solo i placeholder, con un banner che lo dichiara. L'originale non viene toccato
  e la mappa resta in `~/.anon/maps/`. Governa il comportamento `--anon-guard-auto`:
  `ask` (default: chiede conferma; **senza UI blocca**), `on` (senza chiedere), `off` (solo blocco,
  col messaggio che indica i tre passi manuali). Qualunque fallimento — converter assente,
  conversione vuota, motore che non risponde, output oltre il cap — ricade nel **blocco**
  fail-closed: non esiste un percorso in cui un fallimento diventi "pulito" (DEC-0014).
- **Immagini** (`png/jpg/gif/webp/bmp`): **ammesse**. Vengono lette come allegati, non come testo:
  i pixel non sono scansionabili. Gap dichiarato — uno screenshot con dati cliente dentro passa.
- File oltre **12 MB**: **bloccati** (non scansionabili → fail-closed). Anonimizza un estratto più
  piccolo, oppure dichiara il path in `allow.txt`, oppure `--anon-guard=off`.
  Il numero non è stimato: il motore scansiona ~2 MB/s su file grandi con un dizionario da 200 voci
  (`python3 scripts/bench-check.py` nel repo), e 12 MB / 20 s lascia un margine di ~3x. Attenzione:
  il costo dipende dal **dizionario** — a 1 000 voci scende a ~0.9 MB/s, a ~8.000 (lista ISTAT
  completa) a ~0.2 MB/s, cioè il cap verrebbe superato (OPEN-ISSUES #26).
- Un controllo più lento del timeout (20 s): **bloccato**, e il guard **resta attivo** — un file
  lento non è un motore rotto, e non deve spegnere il controllo per il resto della sessione.
- Motore irraggiungibile (python assente, crash): **fail-open** con avviso, e il guard si
  disattiva per la sessione (non paga il timeout a ogni lettura). È l'unico fail-open rimasto.
- Valori pubblici già esclusi: `example.com`, `example.org`, `192.0.2.x`, `198.51.100.x`,
  `203.0.113.x`, `127.0.0.1`, `localhost`, resolver pubblici (`8.8.8.8`, `1.1.1.1`, …),
  maschere (`255.255.255.255`), nomi file (`anon.py`, `main.js`, `obj.id`, `logger.info`, …) e
  placeholder evidenti (`your-api-key-here`, `changeme`).

## Verificare un file "già anonimizzato"

Prima di far leggere a un modello un documento che *dichiara* di essere anonimizzato (arrivato
da qualcun altro, o prodotto in una sessione precedente), esegui l'audit:

```bash
python3 ~/.anon/anon.py file.txt --audit          # exit 0 pulito · 1 sensibile · 4 sospetto
```

Controlla residui sensibili, placeholder rimasti e **varianti** del dizionario scritte in modo
diverso (`Con Toso` per un `Contoso` dichiarato). Il report è sicuro da mostrare a un agente: non
contiene i valori né i nomi delle entità, se non con `--reveal`. Exit 4 = qualcuno ha scritto un
nome in un modo che il dizionario non copre: dichiaralo (`entities.txt`) e ripeti.

## Limiti dichiarati

- **Riferimenti contestuali** non catturati (vedi regola 4).
- **Dizionario curato a mano**: senza un'entità nel dizionario (`entities.txt` generico,
  `people.txt` per le persone, `clients.txt` per aziende e sedi), un nome proprio non viene
  redatto. Va aggiornato all'arrivo di nuovi clienti/persone/sedi.
- **Forme che le regex non riconoscono**: email o domini senza punto (`user@intranet`), domini
  IDN (`marco@bücher.de`), hostname a label singola (`srvcrm`), IP mappati IPv6 (`::ffff:8.8.8.8`
  → viene redatto solo il suffisso).
- **Domini interni con TLD "da codice"**: un hostname è riconosciuto solo se l'ultima label è un
  TLD plausibile, e i TLD che collidono con identificatori di codice o nomi di metodo
  (`.io`, `.dev`, `.cloud`, `.app`, `.name`, `.home`, `.info`, `.pl`, `.rs`, …) sono esclusi di
  proposito: `socket.io`, `import.meta.env.DEV`, `obj.name`, `Path.home`, `main.rs` non devono
  essere redatti. Conseguenza: `srv.api.dev` o `db.intranet.io` **non** vengono riconosciuti.
  Rimedio: dichiarali nel dizionario — `HOST|db.intranet.io` — che li copre come qualunque altra
  entità (è il motivo per cui il dizionario esiste).
- **PDF malformati**: la firma `%PDF-` è riconosciuta entro i 1024 byte ammessi dalla specifica (più gli 8 byte della firma). Un PDF con preambolo più lungo **e** stream compressi non viene classificato come documento — resta però coperto dalla scansione testuale finché il contenuto sensibile è in chiaro. Caso molto raro.
- **`bash` non è coperto in modalità default**: `cat`/`rg`/pipe possono far passare valori
  reali. Usa `--anon-guard=all` per estendere il controllo all'output di `bash`/`grep` (più
  rumoroso: l'output di shell è pieno di email/IP non segreti). Il flusso corretto resta
  anonimizzare *prima*, non sperare nel blocco.
- **`~/.anon/maps` cresce senza limiti**: ogni run scrive una mappa con i valori reali. Ripulisci
  periodicamente con `python3 ~/.anon/anon.py --prune-maps 90` (elenca) e `--yes` (cancella).
- **`~/.anon/auto/` cresce**: ospita le copie redatte prodotte dalla bonifica automatica (solo
  placeholder, 0600 — il Markdown intermedio con i valori reali viene rimosso a fine run). Puoi
  cancellarla quando vuoi: si rigenera alla prossima lettura.
- **Non è un giudizio legale** sull'uso di provider cloud: riduce il rischio tecnico (niente
  dati riconoscibili in transito), non sostituisce la valutazione aziendale/DPA.
- **La tutela è best-effort**: il motore è euristico (un nome non in dizionario non viene
  redatto). Il guard è fail-closed su ciò che non riesce a scansionare (file troppo grandi, timeout,
  e documenti binari la cui bonifica fallisce), e fallisce aperto **solo** se il motore non è
  raggiungibile. Non è un DLP certificato.
