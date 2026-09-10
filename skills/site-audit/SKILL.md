---
name: site-audit
description: Technical/SEO audit of a single website with LibreCrawl (open-source Screaming Frog alternative). Use when you need a packaged crawl report — titles, meta descriptions, headings, internal/external link map, SEO issue detection, PageSpeed, CSV/JSON/XML export. NOT for raw data collection (use crawl). Runs natively, no Docker.
summary: technical/SEO site audit (LibreCrawl; native, no Docker)
---

# Site audit — audit tecnico SEO con LibreCrawl

## Quando usarlo

Quando serve un **report SEO/tecnico pronto** su un singolo sito: estrazione title/meta/heading,
mappatura link interni/esterni, rilevamento issue (alt mancanti, title duplicati, link rotti),
PageSpeed, export CSV/JSON/XML.

**Non è** raccolta dati per pipeline: per quello usa la skill `crawl` (crawl4ai). LibreCrawl è
il prodotto confezionato (GUI + API REST), crawl4ai è il motore.

## Installazione nativa (no Docker) — verificata su macOS / Python 3.14.7

> **Installato su questa macchina:** `~/tools/librecrawl` (pin `3c710d8` + patch già
> applicata e committata, vedi `VENDOR.md`). Non ri-clonare: usa quello. Per altre
> macchine, segui la procedura qui sotto.

```bash
git clone https://github.com/PhialsBasement/LibreCrawl.git
cd LibreCrawl
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
# rendering JS opzionale (~300MB):
# .venv/bin/playwright install chromium
```

Verificato: i pin di `requirements.txt` si installano e `nest_asyncio.apply()` funziona su
Python 3.14.7.

## Patch vendor obbligatoria (2 righe) — prima di avviare

`main.py` ha due valori **hardcoded** che in modalità nativa NON leggono `.env`
(`HOST_BINDING`/`EXTERNAL_PORT` servono solo a docker-compose):

1. `serve(app, host='0.0.0.0', port=5000, threads=8)` → **bind su tutte le interfacce**,
   esposto in LAN anche in LOCAL_MODE.
2. Porta **5000** → su macOS è occupata da AirPlay Receiver (ControlCenter): il server non
   parte (errore "Address already in use").

Patch (riga ~1772 di `main.py`, e allineare i due `print(...5000)` e l'`open_browser`):

```python
serve(app, host='127.0.0.1', port=5001, threads=8)
```

## Avvio

```bash
cd ~/tools/librecrawl
.venv/bin/python main.py --local     # tutti admin, nessun rate limit
# → http://127.0.0.1:5001
```

Modalità standard (auth + tier) se serve: `python main.py` + `.env` con
`SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_hex(32))")`.

## Vincoli di sicurezza

1. **Mai esporlo in rete**: il crawler non ha alcuna guardia su IP privati (SSRF) — chi può
   lanciare un crawl può scansionare la rete interna. Bind 127.0.0.1 e LOCAL_MODE, sempre.
2. **JS rendering = Playwright esegue JS dei siti scansionati** → non fidarti del contenuto;
   per siti non fidati disabilita il rendering JS.
3. **Progetto giovane** (~1 anno, bus-factor 1): va bene come tool, ma pinna il commit e
   registra la provenienza (AGENTS.md §6).

## Contratto

- **produce:** report di audit SEO/tecnico (CSV/JSON/XML)
- **consuma:** URL seed del sito da audire

## Provenienza

LibreCrawl (PhialsBasement/LibreCrawl), MIT. Commit verificato: **`3c710d8ac8fc`** (2026-08-19).
Il core (`src/crawler.py`) usa requests + BeautifulSoup + Playwright: rispetta robots.txt di
default, rate limiter e UA identificabile (`LibreCrawl/1.0`) — igiene buona.
